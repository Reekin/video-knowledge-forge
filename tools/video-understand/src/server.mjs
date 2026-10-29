#!/usr/bin/env node

import http from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnv, buildConfig, buildDaemonConfig } from "./config.mjs";
import { createStorageClient, deleteObjectsWithPrefix } from "./gcs.mjs";
import { runVideoTask, serializeError } from "./runner.mjs";
import { createTaskPersistence } from "./task-persistence.mjs";
import { buildTaskDedupKey, findReusableTask } from "./task-dedup.mjs";

const TASK_LOG_LIMIT = 5000;
const TASK_RESULT_LIMIT = 100;

function jsonResponse(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

function nowIso() {
  return new Date().toISOString();
}

function logServer(message) {
  console.error(`[${nowIso()}] [server] ${message}`);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text);
}

function createTaskStore() {
  return {
    pending: [],
    tasks: new Map(),
    running: new Set(),
    completedOrder: [],
    nextOrderId: 1,
  };
}

function sortTaskSummary(left, right) {
  return String(right.createdAt || "").localeCompare(String(left.createdAt || ""));
}

function taskSummary(task) {
  return {
    id: task.id,
    dedupKey: task.dedupKey ?? null,
    status: task.status,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    input: task.input,
    progress: task.progress,
    logCount: task.logs.length,
  };
}

function appendTaskLog(task, entry) {
  const logEntry = {
    seq: task.nextLogSeq,
    timestamp: nowIso(),
    ...entry,
  };
  task.nextLogSeq += 1;
  task.logs.push(logEntry);

  if (task.logs.length > TASK_LOG_LIMIT) {
    task.logs.splice(0, task.logs.length - TASK_LOG_LIMIT);
  }

  return logEntry;
}

function createServerRuntime({ taskStore, daemonConfig, taskPersistence }) {
  let accepting = true;
  let shuttingDown = false;
  let activePromises = new Set();
  let server = null;
  let enqueueSerial = Promise.resolve();

  async function cleanupResidualObjects() {
    const baseConfig = buildConfig({});
    if (!baseConfig.bucket) {
      logServer("cleanup skipped because GCS_BUCKET is not configured");
      return {
        bucket: null,
        objectPrefix: baseConfig.objectPrefix,
        deleted: 0,
        skipped: true,
      };
    }

    const storage = await createStorageClient(baseConfig.storageOptions);
    const deleted = await deleteObjectsWithPrefix({
      storage,
      bucketName: baseConfig.bucket,
      objectPrefix: baseConfig.objectPrefix,
      log: (message) => {
        logServer(message);
      },
    });
    return {
      bucket: baseConfig.bucket,
      objectPrefix: baseConfig.objectPrefix,
      deleted,
    };
  }

  function evictCompletedTasksIfNeeded() {
    while (taskStore.completedOrder.length > TASK_RESULT_LIMIT) {
      const taskId = taskStore.completedOrder.shift();
      if (!taskId) break;
      taskStore.tasks.delete(taskId);
    }
  }

  async function processQueue() {
    while (
      !shuttingDown &&
      taskStore.running.size < daemonConfig.maxConcurrency &&
      taskStore.pending.length > 0
    ) {
      const taskId = taskStore.pending.shift();
      const task = taskStore.tasks.get(taskId);
      if (!task || task.status !== "queued") {
        continue;
      }

      task.status = "running";
      task.startedAt = nowIso();
      task.progress = "starting";
      taskStore.running.add(taskId);
      appendTaskLog(task, {
        event: "task_started",
        scope: "server",
        message: `task ${task.id} started`,
      });
      taskPersistence.schedulePersist(task);

      const runPromise = runVideoTask({
        args: task.args,
        onLog: (entry) => {
          appendTaskLog(task, entry);
          const label = entry.scope ? `[${entry.scope}] ` : "";
          if (entry.event === "log") {
            task.progress = entry.message;
            logServer(`task ${task.id} ${label}${entry.message}`);
          } else {
            logServer(`task ${task.id} event ${entry.event}`);
          }
          taskPersistence.schedulePersist(task);
        },
      })
        .then((result) => {
          task.status = "succeeded";
          task.finishedAt = nowIso();
          task.progress = "completed";
          task.result = result;
          appendTaskLog(task, {
            event: "task_succeeded",
            scope: "server",
            message: `task ${task.id} completed successfully`,
          });
          taskPersistence.schedulePersist(task);
        })
        .catch((error) => {
          task.status = "failed";
          task.finishedAt = nowIso();
          task.progress = "failed";
          task.error = serializeError(error);
          appendTaskLog(task, {
            event: "task_failed",
            scope: "server",
            error: serializeError(error),
            message: error.message || String(error),
          });
          taskPersistence.schedulePersist(task);
        })
        .finally(() => {
          taskStore.running.delete(taskId);
          taskStore.completedOrder.push(taskId);
          evictCompletedTasksIfNeeded();
          activePromises.delete(runPromise);
          queueMicrotask(() => {
            void processQueue();
          });
        });

      activePromises.add(runPromise);
    }
  }

  async function enqueueTask(args) {
    const previousEnqueue = enqueueSerial;
    let releaseEnqueue = () => {};
    enqueueSerial = new Promise((resolve) => {
      releaseEnqueue = resolve;
    });

    await previousEnqueue;

    try {
      if (!accepting || shuttingDown) {
        const error = new Error("Server is shutting down and is not accepting new tasks.");
        error.statusCode = 503;
        throw error;
      }

      const dedupKey = args.force === "true" ? null : buildTaskDedupKey(args);
      if (dedupKey) {
        const knownTasks = new Map();
        for (const task of taskStore.tasks.values()) {
          knownTasks.set(task.id, task);
        }
        for (const task of await taskPersistence.loadTasks()) {
          if (!knownTasks.has(task.id)) {
            knownTasks.set(task.id, task);
          }
        }

        const existingTask = findReusableTask([...knownTasks.values()], dedupKey);
        if (existingTask) {
          return {
            task: existingTask,
            reusedExistingTask: true,
          };
        }
      }

      const id = randomUUID();
      const task = {
        id,
        dedupKey,
        status: "queued",
        createdAt: nowIso(),
        startedAt: null,
        finishedAt: null,
        input: {
          file: args.file,
          youtubeUrl: args["youtube-url"] || null,
          model: args.model || null,
          bucket: args.bucket || null,
        },
        args,
        progress: "queued",
        logs: [],
        nextLogSeq: 1,
        result: null,
        error: null,
      };

      appendTaskLog(task, {
        event: "task_queued",
        scope: "server",
        message: `task ${id} queued`,
      });

      taskStore.tasks.set(id, task);
      taskStore.pending.push(id);
      taskPersistence.schedulePersist(task);
      queueMicrotask(() => {
        void processQueue();
      });
      return {
        task,
        reusedExistingTask: false,
      };
    } finally {
      releaseEnqueue();
    }
  }

  async function shutdown(reason = "requested") {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    accepting = false;
    logServer(`shutdown started (${reason})`);

    if (server) {
      await new Promise((resolve) => {
        server.close(() => resolve());
      });
    }

    await Promise.allSettled([...activePromises]);
    await taskPersistence.flushAll();

    if (daemonConfig.cleanupOnExit) {
      try {
        const result = await cleanupResidualObjects();
        logServer(
          `shutdown cleanup deleted ${result.deleted} object(s) from gs://${result.bucket}/${result.objectPrefix}`,
        );
      } catch (error) {
        logServer(`shutdown cleanup failed: ${error.stack || String(error)}`);
      }
    }
  }

  function attachServer(instance) {
    server = instance;
  }

  return {
    cleanupResidualObjects,
    enqueueTask,
    processQueue,
    shutdown,
    attachServer,
    getState() {
      return {
        accepting,
        shuttingDown,
        pendingCount: taskStore.pending.length,
        runningCount: taskStore.running.size,
        taskCount: taskStore.tasks.size,
      };
    },
  };
}

export async function startServer({
  foreground = true,
} = {}) {
  loadEnv();
  const daemonConfig = buildDaemonConfig({});
  const daemonMode = process.env.VIDEO_UNDERSTAND_DAEMON_MODE === "background" ? "background" : "foreground";
  buildConfig({});
  const taskStore = createTaskStore();
  const taskPersistence = createTaskPersistence({
    taskStoreDir: daemonConfig.taskStoreDir,
    log: (message) => {
      logServer(message);
    },
  });
  await taskPersistence.ensureReady();

  const runtime = createServerRuntime({ taskStore, daemonConfig, taskPersistence });

  if (daemonConfig.cleanupOnStart) {
    const result = await runtime.cleanupResidualObjects();
    logServer(
      `startup cleanup deleted ${result.deleted} object(s) from gs://${result.bucket}/${result.objectPrefix}`,
    );
  }

  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url, `http://${req.headers.host}`);

      if (req.method === "GET" && requestUrl.pathname === "/health") {
        jsonResponse(res, 200, {
          ok: true,
          pid: process.pid,
          ...runtime.getState(),
          maxConcurrency: daemonConfig.maxConcurrency,
        });
        return;
      }

      if (req.method === "POST" && requestUrl.pathname === "/tasks") {
        const body = await readJsonBody(req);
        const submission = await runtime.enqueueTask(body.args || {});
        jsonResponse(res, submission.reusedExistingTask ? 200 : 202, {
          ok: true,
          reusedExistingTask: submission.reusedExistingTask,
          task: taskSummary(submission.task),
        });
        return;
      }

      if (req.method === "GET" && requestUrl.pathname === "/tasks") {
        const persistedTasks = await taskPersistence.loadTasks();
        const merged = new Map();
        for (const task of persistedTasks) {
          merged.set(task.id, taskSummary(task));
        }
        for (const task of taskStore.tasks.values()) {
          merged.set(task.id, taskSummary(task));
        }

        jsonResponse(res, 200, {
          tasks: [...merged.values()].sort(sortTaskSummary),
        });
        return;
      }

      const taskMatch = requestUrl.pathname.match(/^\/tasks\/([^/]+)$/);
      if (req.method === "GET" && taskMatch) {
        const task = taskStore.tasks.get(taskMatch[1]) || (await taskPersistence.loadTask(taskMatch[1]));
        if (!task) {
          jsonResponse(res, 404, { error: "Task not found" });
          return;
        }

        jsonResponse(res, 200, {
          task: {
            ...taskSummary(task),
            result: task.result,
            error: task.error,
          },
        });
        return;
      }

      const logMatch = requestUrl.pathname.match(/^\/tasks\/([^/]+)\/logs$/);
      if (req.method === "GET" && logMatch) {
        const task = taskStore.tasks.get(logMatch[1]) || (await taskPersistence.loadTask(logMatch[1]));
        if (!task) {
          jsonResponse(res, 404, { error: "Task not found" });
          return;
        }

        const after = Number(requestUrl.searchParams.get("after") || "0");
        const logs = task.logs.filter((entry) => entry.seq > after);
        jsonResponse(res, 200, {
          taskId: task.id,
          status: task.status,
          logs,
          lastSeq: logs.length > 0 ? logs[logs.length - 1].seq : after,
        });
        return;
      }

      if (req.method === "POST" && requestUrl.pathname === "/control/stop") {
        jsonResponse(res, 202, {
          ok: true,
          message: "Server shutdown requested.",
        });
        queueMicrotask(() => {
          void runtime.shutdown("api");
        });
        return;
      }

      jsonResponse(res, 404, { error: "Not found" });
    } catch (error) {
      const statusCode = error?.statusCode || 500;
      jsonResponse(res, statusCode, {
        error: error?.message || String(error),
        details: statusCode >= 500 ? serializeError(error) : undefined,
      });
    }
  });

  runtime.attachServer(server);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(daemonConfig.port, daemonConfig.host, () => {
      resolve();
    });
  });

  logServer(
    `daemon listening on http://${daemonConfig.host}:${daemonConfig.port} with maxConcurrency=${daemonConfig.maxConcurrency} (${daemonMode})`,
  );

  if (daemonMode === "foreground") {
    const handleSignal = (signal) => {
      logServer(`received ${signal}`);
      void runtime.shutdown(signal).finally(() => {
        process.exit(0);
      });
    };

    process.on("SIGINT", handleSignal);
    process.on("SIGTERM", handleSignal);
    process.on("SIGBREAK", handleSignal);
  } else {
    logServer("background mode enabled; console signals are ignored and shutdown should happen via /control/stop");
  }

  if (foreground) {
    await new Promise(() => {});
  }

  return server;
}

const entryUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;

if (entryUrl === import.meta.url) {
  startServer().catch((error) => {
    console.error(error.stack || String(error));
    process.exit(1);
  });
}
