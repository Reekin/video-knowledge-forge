#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnv, getToolDir, buildDaemonConfig } from "./config.mjs";
import {
  ensureServer,
  formatLogEntry,
  getHealth,
  getTask,
  listTasks,
  stopServer,
  submitTask,
  waitForTaskCompletion,
} from "./client.mjs";
import { BridgeUnavailableError, createBridge } from "./web/bridge.mjs";
import { WebFetchError, fetchStream } from "./web/fetch.mjs";
import { collectWebStreams } from "./web/probe.mjs";
import { downloadBilibili } from "./bilibili.mjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current.startsWith("--")) continue;

    const key = current.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
      continue;
    }

    args[key] = next;
    i += 1;
  }
  return args;
}

function printHelp() {
  const toolDir = getToolDir();
  console.log(`Usage:
 node ./src/cli.mjs --file <video-path> [--prompt "Summarize this video"]
 node ./src/cli.mjs --youtube-url <youtube-url> [--prompt "Summarize this video"]
 node ./src/cli.mjs --bili-url <bilibili-url-or-BV> [--prompt "Summarize this video"]
 node ./src/cli.mjs --web-url <page-url> [--prompt "Summarize this video"]

Task submission:
  --file                 Local video file path
  --youtube-url          Public YouTube URL (youtube.com / youtu.be)
  --bili-url             Bilibili URL or id (BV/av/ep/ss); downloads it with BBDown, then analyzes it
  --web-url              Page URL to capture from the browser extension; downloads it, then analyzes it
  --subtitle-file        SRT file passed to the model as a reference transcript
  --subtitle-kind        human | ai (default: inferred from the file name, ai-* means ai)
  --prompt               Custom video understanding prompt
  --model                Override the configured model list (single model or comma-separated list)
  --bucket               Override GCS_BUCKET
  --object-prefix        Override GCS_OBJECT_PREFIX
  --timeout-ms           Override PROVIDER_TIMEOUT_MS
  --base-url             Add a highest-priority provider base URL
  --api-key              Add a highest-priority provider API key
  --mime-type            Manually specify the input video MIME type
  --keep-temp            Keep the local preprocessing temp directory
  --keep-download        Keep the downloaded source video after a successful --bili-url / --web-url task
  --json                 Output the full result as JSON
  --no-wait              Submit the task without waiting
  --force                Bypass duplicate-task reuse and always create a new task

Bilibili options (used with --bili-url):
  --page                 Part number to download (default: 1)
  --sub-lang             Subtitle language to use, e.g. zh-CN or ai-zh (default: human Chinese, then AI Chinese)
  --no-subtitles         Do not pass downloaded subtitles to the model
  --redownload           Download again even if this part is already under downloads/bilibili
  --out-dir              Directory for the downloaded video and subtitles
  --download-only        Download and report files; do not submit a task

Web stream options (used with --web-url):
  --probe                Only report candidate streams; do not download or submit
  --stream-id            Candidate id from --probe (default: the highest ranked one)
  --variant              Rendition index inside that candidate, 1-based (default: let ffmpeg choose)
  --session              Browser extension session name (default: video-understand-web)
  --group-title          Tab group label used when the page has to be opened
  --reload               Reload the page before probing to re-issue media requests
  --fresh                Restart the capture buffer; discards requests already recorded
  --wait                 Seconds to wait for media requests (default: 8)
  --out                  Output path for the downloaded source video
  --max-seconds          Download only the first N seconds of the page video

Daemon control:
  --host                 Override DAEMON_HOST
  --port                 Override DAEMON_PORT
  --max-concurrency      Override DAEMON_MAX_CONCURRENCY
  --task-store-dir       Override DAEMON_TASK_STORE_DIR
  --status --task-id <id>  Show one task status
  --status                 Show all task summaries
  --server-status          Show daemon status
  --stop-server            Request graceful daemon shutdown
  --help                   Show help

env file search order:
  ${path.join(toolDir, ".env")}
  ${path.join(toolDir, ".env.local")}
`);
}

function shouldTreatAsJson(args) {
  return args.json === "true";
}

async function handleTaskSubmission(args, daemonConfig) {
  await ensureServer(daemonConfig, (message) => {
    console.error(`[daemon] ${message}`);
  });

  const submission = await submitTask(daemonConfig, args);
  const taskId = submission.task.id;

  if (args["no-wait"] === "true") {
    if (shouldTreatAsJson(args)) {
      console.log(JSON.stringify(submission, null, 2));
    } else {
      if (submission.reusedExistingTask) {
        console.log(`reused existing task ${taskId}`);
      } else {
        console.log(`submitted task ${taskId}`);
      }
    }
    return;
  }

  const task = await waitForTaskCompletion({
    daemonConfig,
    taskId,
    onLogEntry: (entry) => {
      console.error(formatLogEntry(entry));
    },
  });

  if (task.status !== "succeeded") {
    const error = new Error(task.error?.message || `Task ${task.id} failed`);
    error.task = task;
    throw error;
  }

  removeCachedDownload(args);

  if (shouldTreatAsJson(args)) {
    console.log(JSON.stringify(task.result, null, 2));
    return;
  }

  console.log(task.result?.resultText || JSON.stringify(task.result, null, 2));
}

// Remote sources are downloaded into the downloads cache only to be analyzed, so a
// successful task deletes them; failed tasks keep the file for a retry.
function removeCachedDownload(args) {
  const target = args.cachedDownload;
  if (!target || args["keep-download"] === "true") return;
  fs.rmSync(target, { recursive: true, force: true });
  console.error(`[cleanup] removed downloaded source ${target}`);
}

async function handleStatus(args, daemonConfig) {
  await getHealth(daemonConfig);

  if (args["task-id"]) {
    const payload = await getTask(daemonConfig, args["task-id"]);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const payload = await listTasks(daemonConfig);
  console.log(JSON.stringify(payload, null, 2));
}

async function handleServerStatus(daemonConfig) {
  const payload = await getHealth(daemonConfig);
  console.log(JSON.stringify(payload, null, 2));
}

async function handleStopServer(daemonConfig) {
  await getHealth(daemonConfig);
  const payload = await stopServer(daemonConfig);
  console.log(JSON.stringify(payload, null, 2));
}

function normalizeUrl(value) {
  return String(value || "")
    .replace(/#.*$/, "")
    .replace(/\/+$/, "");
}

function looksLikeUrl(value) {
  return /[/?=]|:\/\//.test(String(value || ""));
}

function sanitizeName(value, fallback) {
  const cleaned = String(value || "")
    .replace(/[\\/:*?"<>|]/g, "")
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

function defaultWebOutput(stream, pageTitle) {
  const title = looksLikeUrl(pageTitle) ? "" : String(pageTitle || "").trim();
  const stem = sanitizeName(title, `stream-${stream.id}`);
  return path.join(getToolDir(), "downloads", `${stem}.mp4`);
}

// Probe the browser tab for media streams, download the chosen one, and return
// its local path so the normal file pipeline can analyze it.
async function resolveWebSource(args) {
  const session = args.session || "video-understand-web";
  const bridge = createBridge(session);
  const targetUrl = args["web-url"];

  let tab = null;
  try {
    tab = await bridge.currentTab();
  } catch (error) {
    if (error instanceof BridgeUnavailableError) throw error;
    tab = null;
  }

  let navigateTo = null;
  if (!tab) {
    // No tab yet means there is nothing to attach a capture to, so open the page
    // first and load it once more below, after the capture is running.
    await bridge.navigate(targetUrl, { newTab: true, groupTitle: args["group-title"] || null });
    navigateTo = targetUrl;
  } else if (normalizeUrl(tab.url) !== normalizeUrl(targetUrl)) {
    navigateTo = targetUrl;
  }

  const result = await collectWebStreams(bridge, {
    navigateTo,
    reload: args.reload === "true",
    waitSeconds: Number(args.wait || 8),
    fresh: args.fresh === "true",
  });

  if (args.probe === "true") {
    console.log(JSON.stringify(result, null, 2));
    return null;
  }

  if (result.streams.length === 0) {
    throw new WebFetchError(
      `No candidate stream found on ${result.pageUrl || targetUrl}. ${result.notes.join(" ")}`,
    );
  }

  let stream = result.streams[0];
  if (args["stream-id"]) {
    const match = result.streams.find((item) => item.id === args["stream-id"]);
    if (!match) {
      const available = result.streams.map((item) => item.id).join(", ");
      throw new WebFetchError(`Unknown --stream-id ${args["stream-id"]}; available: ${available}`);
    }
    stream = match;
  }

  const outputPath = args.out || defaultWebOutput(stream, result.pageTitle);
  const maxSeconds = args["max-seconds"] ? Number(args["max-seconds"]) : null;
  const report = fetchStream(stream, outputPath, {
    variantIndex: args.variant ? Number(args.variant) : null,
    maxSeconds,
  });

  if (shouldTreatAsJson(args)) {
    console.log(JSON.stringify({ stream, fetch: report, maxSeconds }, null, 2));
  } else {
    const resolution = report.video.width ? `${report.video.width}x${report.video.height}` : "unknown";
    console.log(
      `downloaded ${stream.id} (${resolution}) -> ${report.output} ` +
        `[${(report.bytes / 1024 / 1024).toFixed(1)} MB, ${report.duration.toFixed(1)}s` +
        `${maxSeconds ? `, truncated to ${maxSeconds}s` : ""}]`,
    );
  }

  return report.output;
}

// Download a Bilibili part with BBDown and fill in the file and subtitle args
// for the normal file pipeline. Returns false when no task should be submitted.
function resolveBilibiliSource(args) {
  const download = downloadBilibili(args["bili-url"], {
    page: args.page || "1",
    outDir: args["out-dir"] || null,
    redownload: args.redownload === "true",
    subLang: args["sub-lang"] || null,
    log: (line) => console.error(`[bbdown] ${line}`),
  });

  if (download.notLoggedIn) {
    console.error(
      "[bbdown] not logged in: quality is limited (often 480P) and AI subtitles are unavailable. Run `BBDown login` once to fix this.",
    );
  }
  if (args["sub-lang"] && !download.subtitle) {
    console.error(`[bbdown] no subtitle with language ${args["sub-lang"]}; continuing without subtitles`);
  }

  const useSubtitle = download.subtitle && args["no-subtitles"] !== "true";
  const summary = {
    video: download.videoPath,
    subtitles: download.subtitleFiles,
    selectedSubtitle: useSubtitle ? download.subtitle : null,
  };
  console.error(`[bbdown] ${JSON.stringify(summary)}`);

  if (args["download-only"] === "true") {
    console.log(JSON.stringify(summary, null, 2));
    return false;
  }

  args.file = download.videoPath;
  if (!args["out-dir"]) args.cachedDownload = download.workDir;
  if (useSubtitle) {
    args["subtitle-file"] = download.subtitle.path;
    args["subtitle-kind"] = download.subtitle.kind;
  }
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === "true") {
    printHelp();
    return;
  }

  loadEnv();
  const daemonConfig = buildDaemonConfig(args);

  if (args["server-status"] === "true") {
    await handleServerStatus(daemonConfig);
    return;
  }

  if (args["stop-server"] === "true") {
    await handleStopServer(daemonConfig);
    return;
  }

  if (args.status === "true") {
    await handleStatus(args, daemonConfig);
    return;
  }

  const hasFile = Boolean(args.file);
  const hasYoutubeUrl = Boolean(args["youtube-url"]);
  const hasBiliUrl = Boolean(args["bili-url"]);
  const hasWebUrl = Boolean(args["web-url"]);

  const sourceCount = [hasFile, hasYoutubeUrl, hasBiliUrl, hasWebUrl].filter(Boolean).length;
  if (sourceCount === 0) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  if (sourceCount > 1) {
    console.error("Please provide exactly one input source: --file, --youtube-url, --bili-url, or --web-url.");
    printHelp();
    process.exitCode = 1;
    return;
  }

  if (hasBiliUrl && !resolveBilibiliSource(args)) {
    return;
  }

  if (hasWebUrl) {
    const downloadedPath = await resolveWebSource(args);
    if (!downloadedPath) {
      // --probe only: candidates were printed, nothing to submit.
      return;
    }
    args.file = downloadedPath;
    if (!args.out) args.cachedDownload = downloadedPath;
  }

  await handleTaskSubmission(args, daemonConfig);
}

const entryUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;

if (entryUrl === import.meta.url) {
  main().catch((error) => {
    if (error?.code === "DAEMON_UNREACHABLE") {
      console.error(error.message);
      process.exit(1);
      return;
    }

    if (error.task) {
      console.error(
        JSON.stringify(
          {
            message: error.message,
            task: error.task,
          },
          null,
          2,
        ),
      );
      process.exit(1);
      return;
    }

    console.error(error.stack || String(error));
    process.exit(1);
  });
}
