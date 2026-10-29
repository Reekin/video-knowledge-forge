import fsp from "node:fs/promises";
import path from "node:path";

const PERSISTENCE_VERSION = 1;
const TASK_FILE_SUFFIX = ".json";
const TASK_MARKDOWN_SUFFIX = ".md";
const WRITE_DEBOUNCE_MS = 150;
// Task history is a local cache, not an archive. Only the most recent tasks are
// read back into memory, so a long-lived store cannot exhaust the heap.
const TASK_HISTORY_LIMIT = 200;

function sortByCreatedAt(left, right) {
  return String(left.createdAt || "").localeCompare(String(right.createdAt || ""));
}

function ensureLogs(logs) {
  return Array.isArray(logs) ? logs : [];
}

function createInterruptedError() {
  return {
    name: "Error",
    message: "Task did not finish because the daemon stopped before completion.",
  };
}

function serializeTask(task) {
  return {
    persistenceVersion: PERSISTENCE_VERSION,
    id: task.id,
    dedupKey: task.dedupKey ?? null,
    status: task.status,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    input: task.input,
    progress: task.progress,
    logs: ensureLogs(task.logs),
    nextLogSeq: Number(task.nextLogSeq) || ensureLogs(task.logs).length + 1,
    result: task.result ?? null,
    error: task.error ?? null,
  };
}

function deserializeTask(payload) {
  const logs = ensureLogs(payload.logs);
  const task = {
    id: payload.id,
    dedupKey: payload.dedupKey ?? null,
    status: payload.status || "failed",
    createdAt: payload.createdAt || new Date(0).toISOString(),
    startedAt: payload.startedAt || null,
    finishedAt: payload.finishedAt || null,
    input: payload.input || {
      file: null,
      model: null,
      bucket: null,
    },
    args: null,
    progress: payload.progress || payload.status || "failed",
    logs,
    nextLogSeq: Number(payload.nextLogSeq) || logs.length + 1,
    result: payload.result ?? null,
    error: payload.error ?? null,
  };

  if (task.status === "queued" || task.status === "running") {
    task.status = "failed";
    task.progress = "failed";
    task.finishedAt = task.finishedAt || task.startedAt || task.createdAt;
    task.error = task.error || createInterruptedError();
  }

  return task;
}

async function readTaskFile(filePath) {
  const text = await fsp.readFile(filePath, "utf8");
  return JSON.parse(text);
}

async function selectRecentTaskFileNames(taskStoreDir, limit) {
  const entries = await fsp.readdir(taskStoreDir, { withFileTypes: true });
  const fileNames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(TASK_FILE_SUFFIX))
    .map((entry) => entry.name);

  if (fileNames.length <= limit) {
    return fileNames;
  }

  const statBatchSize = 128;
  const stats = [];
  for (let index = 0; index < fileNames.length; index += statBatchSize) {
    const batch = fileNames.slice(index, index + statBatchSize);
    const batchStats = await Promise.all(
      batch.map(async (name) => {
        try {
          const info = await fsp.stat(path.join(taskStoreDir, name));
          return { name, mtimeMs: info.mtimeMs };
        } catch {
          return null;
        }
      }),
    );
    for (const item of batchStats) {
      if (item) {
        stats.push(item);
      }
    }
  }

  stats.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return stats.slice(0, limit).map((item) => item.name);
}

export function createTaskPersistence({ taskStoreDir, log }) {
  const writeState = new Map();

  async function ensureReady() {
    await fsp.mkdir(taskStoreDir, { recursive: true });
  }

  function getTaskFilePath(taskId) {
    return path.join(taskStoreDir, `${taskId}${TASK_FILE_SUFFIX}`);
  }

  function getTaskMarkdownPath(taskId) {
    return path.join(taskStoreDir, `${taskId}${TASK_MARKDOWN_SUFFIX}`);
  }

  function renderMarkdown(task) {
    const result = task.result ?? {};
    const preprocessing = result.preprocessing ?? {};
    const sourceVideo = preprocessing.sourceVideo ?? {};
    const sourceAudio = preprocessing.sourceAudio ?? {};
    const requestedModels = Array.isArray(result.models) ? result.models.filter(Boolean) : [];
    const modelsUsed = Array.isArray(result.modelsUsed) ? result.modelsUsed.filter(Boolean) : [];
    const parts = [
      "# Video Understanding Result",
      "",
      `- Task ID: ${task.id}`,
      `- Status: ${task.status}`,
      `- Created At: ${task.createdAt || ""}`,
      `- Finished At: ${task.finishedAt || ""}`,
      `- Source File: ${result.filePath || task.input?.file || ""}`,
      `- Model Used: ${modelsUsed.join(", ") || result.model || task.input?.model || ""}`,
      `- Model Fallback Order: ${requestedModels.join(", ") || result.model || task.input?.model || ""}`,
      `- Prompt: ${result.prompt || ""}`,
      `- Source Duration Seconds: ${preprocessing.sourceDurationSeconds ?? ""}`,
      `- Segment Count: ${preprocessing.segmentCount ?? ""}`,
      `- Source Video: ${sourceVideo.codec || ""} ${sourceVideo.width || ""}x${sourceVideo.height || ""} ${sourceVideo.bitRate || ""}bps`,
      `- Source Audio: ${sourceAudio.codec || ""} ${sourceAudio.sampleRate || ""}Hz ${sourceAudio.channels || ""}ch ${sourceAudio.bitRate || ""}bps`,
      "",
      "## Full Transcript And Summary",
      "",
      result.resultText || "",
      "",
    ];

    return parts.join("\n");
  }

  async function writeTask(task) {
    await ensureReady();
    await fsp.writeFile(
      getTaskFilePath(task.id),
      JSON.stringify(serializeTask(task), null, 2),
      "utf8",
    );

    if (task.status === "succeeded" && task.result) {
      await fsp.writeFile(
        getTaskMarkdownPath(task.id),
        renderMarkdown(task),
        "utf8",
      );
    }
  }

  async function flushTask(taskId) {
    const state = writeState.get(taskId);
    if (!state) return;

    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    if (state.writing) {
      state.dirty = true;
      return;
    }

    state.writing = true;
    try {
      while (state.dirty) {
        state.dirty = false;
        await writeTask(state.task);
      }
    } finally {
      state.writing = false;
      if (!state.dirty && !state.timer) {
        writeState.delete(taskId);
      }
    }
  }

  function schedulePersist(task) {
    const current = writeState.get(task.id) || {
      task,
      dirty: false,
      writing: false,
      timer: null,
    };

    current.task = task;
    current.dirty = true;

    if (!current.timer) {
      current.timer = setTimeout(() => {
        void flushTask(task.id);
      }, WRITE_DEBOUNCE_MS);
    }

    writeState.set(task.id, current);
  }

  async function flushAll() {
    await Promise.allSettled(
      [...writeState.keys()].map(async (taskId) => {
        await flushTask(taskId);
      }),
    );
  }

  async function loadTasks({ limit = TASK_HISTORY_LIMIT } = {}) {
    await ensureReady();
    const fileNames = await selectRecentTaskFileNames(taskStoreDir, limit);
    const tasks = [];

    for (const name of fileNames) {
      const filePath = path.join(taskStoreDir, name);
      try {
        const payload = await readTaskFile(filePath);
        const task = deserializeTask(payload);
        tasks.push(task);
      } catch (error) {
        if (log) {
          log(`failed to load persisted task file ${filePath}: ${error.message || String(error)}`);
        }
      }
    }

    return tasks.sort(sortByCreatedAt);
  }

  async function loadTask(taskId) {
    try {
      const payload = await readTaskFile(getTaskFilePath(taskId));
      return deserializeTask(payload);
    } catch (error) {
      const code = error?.code;
      if (code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  return {
    taskStoreDir,
    ensureReady,
    schedulePersist,
    flushAll,
    loadTasks,
    loadTask,
  };
}
