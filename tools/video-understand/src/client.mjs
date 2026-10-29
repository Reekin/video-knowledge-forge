import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { getToolDir } from "./config.mjs";

const START_LOCK_DIRNAME = ".daemon-start.lock";

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getBaseUrl(daemonConfig) {
  return `http://${daemonConfig.host}:${daemonConfig.port}`;
}

async function fetchJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    const wrapped = new Error(`Daemon is not reachable at ${url}`);
    wrapped.code = "DAEMON_UNREACHABLE";
    wrapped.cause = error;
    throw wrapped;
  }

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const error = new Error(payload?.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

export async function getHealth(daemonConfig) {
  return fetchJson(`${getBaseUrl(daemonConfig)}/health`);
}

export async function submitTask(daemonConfig, args) {
  return fetchJson(`${getBaseUrl(daemonConfig)}/tasks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ args }),
  });
}

export async function getTask(daemonConfig, taskId) {
  return fetchJson(`${getBaseUrl(daemonConfig)}/tasks/${encodeURIComponent(taskId)}`);
}

export async function getTaskLogs(daemonConfig, taskId, after = 0) {
  return fetchJson(
    `${getBaseUrl(daemonConfig)}/tasks/${encodeURIComponent(taskId)}/logs?after=${after}`,
  );
}

export async function listTasks(daemonConfig) {
  return fetchJson(`${getBaseUrl(daemonConfig)}/tasks`);
}

export async function stopServer(daemonConfig) {
  return fetchJson(`${getBaseUrl(daemonConfig)}/control/stop`, {
    method: "POST",
  });
}

async function clearStaleStartLock(lockDir, startupTimeoutMs) {
  try {
    const stat = await fs.stat(lockDir);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > startupTimeoutMs * 2) {
      await fs.rm(lockDir, { recursive: true, force: true });
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

async function acquireStartLock(lockDir, startupTimeoutMs) {
  await clearStaleStartLock(lockDir, startupTimeoutMs);

  try {
    await fs.mkdir(lockDir);
  } catch (error) {
    if (error?.code === "EEXIST") {
      return false;
    }
    throw error;
  }

  try {
    await fs.writeFile(
      path.join(lockDir, "owner.json"),
      JSON.stringify(
        {
          pid: process.pid,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch {
    // Best effort diagnostic metadata only.
  }

  return true;
}

async function releaseStartLock(lockDir) {
  await fs.rm(lockDir, { recursive: true, force: true });
}

async function waitForServerHealth(daemonConfig) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < daemonConfig.startupTimeoutMs) {
    try {
      return await getHealth(daemonConfig);
    } catch {
      await sleep(500);
    }
  }

  throw new Error(
    `Timed out waiting for daemon to start on ${daemonConfig.host}:${daemonConfig.port}`,
  );
}

export async function ensureServer(daemonConfig, log) {
  try {
    return await getHealth(daemonConfig);
  } catch {
    // Server not ready yet.
  }

  const toolDir = getToolDir();
  const lockDir = path.join(toolDir, START_LOCK_DIRNAME);
  const hasStartLock = await acquireStartLock(lockDir, daemonConfig.startupTimeoutMs);

  if (!hasStartLock) {
    if (log) {
      log("another client is starting the daemon; waiting for health check");
    }
    return waitForServerHealth(daemonConfig);
  }

  const serverEntry = path.join(toolDir, "src", "server.mjs");
  try {
    const child = spawn(process.execPath, [serverEntry], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      cwd: toolDir,
      env: {
        ...process.env,
        VIDEO_UNDERSTAND_DAEMON_MODE: "background",
      },
    });
    child.unref();

    if (log) {
      log(`spawned daemon process pid=${child.pid ?? "unknown"}`);
    }

    return await waitForServerHealth(daemonConfig);
  } finally {
    try {
      await releaseStartLock(lockDir);
    } catch {
      // Best effort cleanup.
    }
  }
}

export async function waitForTaskCompletion({
  daemonConfig,
  taskId,
  onLogEntry,
}) {
  let lastSeq = 0;

  while (true) {
    const logPayload = await getTaskLogs(daemonConfig, taskId, lastSeq);
    for (const entry of logPayload.logs) {
      lastSeq = entry.seq;
      if (onLogEntry) {
        onLogEntry(entry);
      }
    }

    const taskPayload = await getTask(daemonConfig, taskId);
    const task = taskPayload.task;
    if (task.status === "succeeded" || task.status === "failed" || task.status === "cancelled") {
      return task;
    }

    await new Promise((resolve) => setTimeout(resolve, daemonConfig.pollIntervalMs));
  }
}

export function formatLogEntry(entry) {
  const prefix = `[${entry.timestamp}]`;
  if (entry.event === "log") {
    const scope = entry.scope ? ` [${entry.scope}]` : "";
    return `${prefix}${scope} ${entry.message}`;
  }

  return JSON.stringify(entry, null, 2);
}
