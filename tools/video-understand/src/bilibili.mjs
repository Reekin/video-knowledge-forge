// Bilibili input: download the best available streams and subtitles with BBDown,
// then hand the local file to the normal file pipeline.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { getToolDir } from "./config.mjs";
import { describeSubtitleFile, parseSrt } from "./subtitles.mjs";

export class BilibiliError extends Error {
  constructor(message) {
    super(message);
    this.name = "BilibiliError";
  }
}

// Human CC subtitles in Chinese first, then AI Chinese, then anything else.
const SUBTITLE_PRIORITY = ["zh-CN", "zh-Hans", "zh", "ai-zh", "zh-Hant", "zh-HK", "zh-TW"];

function resolveBbdown() {
  const candidate = process.env.BBDOWN_PATH || "BBDown";
  const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
  if (probe.error) {
    throw new BilibiliError(
      `BBDown not found (${candidate}). Install it with "dotnet tool install --global BBDown" or set BBDOWN_PATH.`,
    );
  }
  return candidate;
}

function sourceId(input) {
  const text = String(input).trim();
  const match = text.match(/(BV[0-9A-Za-z]{10}|av\d+|ep\d+|ss\d+)/i);
  if (match) return match[1];
  return `url-${createHash("sha1").update(text).digest("hex").slice(0, 10)}`;
}

function runBbdown(bbdown, args, log) {
  const result = spawnSync(bbdown, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) {
    throw new BilibiliError(`BBDown failed to start: ${result.error.message}`);
  }
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  for (const line of output.split(/\r?\n/)) {
    // Stream listings carry long signed URLs; keep only BBDown's own status lines.
    if (/^\[\d{4}-\d{2}-\d{2} /.test(line) || /^\s+\[(视频|音频)\]/.test(line)) log(line.trim());
  }
  if (result.status !== 0) {
    throw new BilibiliError(`BBDown exited with code ${result.status}`);
  }
  return output;
}

function listFiles(dir, extension) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(extension))
    .map((name) => path.join(dir, name));
}

function probeDurationSeconds(videoPath) {
  const result = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", videoPath], { encoding: "utf8" });
  const seconds = Number(String(result.stdout || "").trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

// Bilibili's subtitle API occasionally returns another video's AI subtitles; a
// subtitle whose timeline runs well past the video's end cannot belong to it.
function dropMismatchedSubtitles(files, videoPath, log) {
  const duration = probeDurationSeconds(videoPath);
  if (!duration) return files;
  return files.filter((file) => {
    const cues = parseSrt(fs.readFileSync(file, "utf8"));
    const lastEnd = cues.length ? cues[cues.length - 1].end : 0;
    if (lastEnd <= duration * 1.1 + 5) return true;
    log(`dropping subtitle ${path.basename(file)}: ends at ${lastEnd.toFixed(0)}s but the video lasts ${duration.toFixed(0)}s`);
    return false;
  });
}

export function pickSubtitle(files, preferredLang = null) {
  const described = files.map(describeSubtitleFile);
  if (preferredLang) {
    return described.find((item) => item.lang === preferredLang) || null;
  }
  for (const lang of SUBTITLE_PRIORITY) {
    const match = described.find((item) => item.lang === lang);
    if (match) return match;
  }
  return described.find((item) => item.kind === "human") || described[0] || null;
}

export function downloadBilibili(input, options = {}) {
  const { page = "1", outDir = null, redownload = false, subLang = null, log = () => {} } = options;
  const bbdown = resolveBbdown();
  const workDir = path.resolve(
    outDir || path.join(getToolDir(), "downloads", "bilibili", `${sourceId(input)}-p${page}`),
  );
  fs.mkdirSync(workDir, { recursive: true });

  const common = [String(input), "--work-dir", workDir, "-p", String(page), "-F", "<bvid>-p<pageNumber>", "-M", "<bvid>-p<pageNumber>"];

  let notLoggedIn = false;
  let videoPath = listFiles(workDir, ".mp4")[0] || null;
  if (videoPath && !redownload) {
    log(`reusing downloaded video ${videoPath}`);
  } else {
    for (const stale of [...listFiles(workDir, ".mp4"), ...listFiles(workDir, ".srt")]) fs.rmSync(stale);
    const subOutput = runBbdown(bbdown, [...common, "--sub-only", "--skip-ai", "false"], log);
    const videoOutput = runBbdown(bbdown, [...common, "--skip-subtitle", "--skip-cover", "-hs"], log);
    notLoggedIn = /尚未登录/.test(subOutput + videoOutput);
    videoPath = listFiles(workDir, ".mp4")[0] || null;
    if (!videoPath) {
      throw new BilibiliError(`BBDown finished but produced no .mp4 in ${workDir}`);
    }
  }

  const subtitleFiles = dropMismatchedSubtitles(listFiles(workDir, ".srt"), videoPath, log);
  return {
    workDir,
    videoPath,
    subtitleFiles,
    subtitle: pickSubtitle(subtitleFiles, subLang),
    notLoggedIn,
  };
}
