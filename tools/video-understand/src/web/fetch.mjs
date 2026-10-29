// Execution layer: download one selected stream and verify the result against
// what the manifest claimed.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { bestVariant } from "./probe.mjs";

export class WebFetchError extends Error {
  constructor(message) {
    super(message);
    this.name = "WebFetchError";
  }
}

export function toolVersion(tool) {
  const result = spawnSync(tool, ["-version"], { encoding: "utf8" });
  if (result.error) return null;
  const firstLine = String(result.stdout || result.stderr || "").split(/\r?\n/)[0];
  return firstLine || "unknown";
}

function requireTool(tool) {
  if (!toolVersion(tool)) {
    throw new WebFetchError(`Required tool not found on PATH: ${tool}`);
  }
  return tool;
}

function chooseInput(stream, variantIndex) {
  if (!variantIndex) {
    return { url: stream.url, label: stream.role };
  }
  const index = Number(variantIndex);
  if (!Number.isInteger(index) || index < 1 || index > stream.variants.length) {
    throw new WebFetchError(
      `Rendition index out of range: ${variantIndex} (this stream has ${stream.variants.length}).`,
    );
  }
  return { url: stream.variants[index - 1].url, label: `variant-${index}` };
}

export function buildFfmpegArgs(stream, outputPath, options = {}) {
  const { variantIndex = null, maxSeconds = null, ffmpeg = "ffmpeg" } = options;
  const { url, label } = chooseInput(stream, variantIndex);

  const args = ["-y", "-loglevel", "warning"];
  if (stream.userAgent) args.push("-user_agent", stream.userAgent);
  if (stream.referer) args.push("-referer", stream.referer);
  args.push("-i", url);

  const audioTrack = (stream.tracks || []).find((track) => track.kind === "audio" && track.url);
  if (variantIndex && audioTrack) {
    // A rendition picked by URL does not carry the separate audio rendition.
    args.push("-i", audioTrack.url, "-map", "0:v:0", "-map", "1:a:0");
  }

  args.push("-c", "copy");
  if (maxSeconds) args.push("-t", String(maxSeconds));
  args.push(outputPath);
  return { args, label };
}

export function probeOutput(outputPath) {
  const ffprobe = requireTool("ffprobe");
  const result = spawnSync(
    ffprobe,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration,size",
      "-show_entries",
      "stream=index,codec_type,codec_name,width,height,channels",
      "-of",
      "json",
      outputPath,
    ],
    { encoding: "utf8", timeout: 120000 },
  );
  if (result.status !== 0) {
    throw new WebFetchError(`ffprobe failed: ${String(result.stderr || "").trim().slice(0, 300)}`);
  }
  return JSON.parse(result.stdout || "{}");
}

export function fetchStream(stream, outputPath, options = {}) {
  const { variantIndex = null, maxSeconds = null } = options;
  const ffmpeg = requireTool("ffmpeg");

  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  const { args, label } = buildFfmpegArgs(stream, outputPath, { variantIndex, maxSeconds, ffmpeg });

  const started = Date.now();
  const result = spawnSync(ffmpeg, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error) {
    throw new WebFetchError(`ffmpeg failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const tail = String(result.stderr || "").trim().split(/\r?\n/).slice(-8).join("\n");
    throw new WebFetchError(`ffmpeg exited with code ${result.status}:\n${tail}`);
  }

  const probe = probeOutput(outputPath);
  const duration = Number.parseFloat(probe.format?.duration || "0") || 0;
  const video = (probe.streams || []).find((item) => item.codec_type === "video") || {};
  const audio = (probe.streams || []).find((item) => item.codec_type === "audio") || {};

  const expected = stream.duration;
  let durationMismatch = null;
  if (!maxSeconds && expected) {
    const tolerance = Math.max(5, expected * 0.05);
    if (Math.abs(duration - expected) > tolerance) {
      durationMismatch = { expected, actual: duration };
    }
  }

  return {
    output: path.resolve(outputPath),
    bytes: fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0,
    input: label,
    duration,
    elapsedSeconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    video: { codec: video.codec_name || null, width: video.width || null, height: video.height || null },
    audio: { codec: audio.codec_name || null, channels: audio.channels || null },
    durationMismatch,
  };
}

export { bestVariant };
