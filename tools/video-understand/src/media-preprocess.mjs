import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const MAX_SEGMENT_SECONDS = 3580;
const SPLIT_THRESHOLD_SECONDS = 5300;
const SEGMENT_OVERLAP_RATIO = 0.05;
const OUTPUT_VIDEO_FPS = 1;
const MIN_AUDIO_BITRATE_BPS = 12000;
const MAX_AUDIO_BITRATE_BPS = 32000;

const VIDEO_PROFILES = [
  { minHeight: 720, minBitrate: 160_000, preferredBitrate: 260_000, label: "720p" },
  { minHeight: 480, minBitrate: 110_000, preferredBitrate: 190_000, label: "480p" },
  { minHeight: 360, minBitrate: 80_000, preferredBitrate: 140_000, label: "360p" },
  { minHeight: 240, minBitrate: 55_000, preferredBitrate: 100_000, label: "240p" },
  { minHeight: 0, minBitrate: 40_000, preferredBitrate: 70_000, label: "180p" },
];

// maxMediaBytes is the total video + audio bytes one provider request may carry
// (config.maxMediaBytes). A smaller budget splits long videos into more segments.

// Longest segment that still fits the budget at the 720p floor bitrate plus full audio.
function getMaxSegmentSeconds(maxMediaBytes) {
  const floorBps = VIDEO_PROFILES[0].minBitrate + MAX_AUDIO_BITRATE_BPS;
  return Math.min(MAX_SEGMENT_SECONDS, Math.floor(((maxMediaBytes * 8) / floorBps) * 0.95));
}

function quoteArg(value) {
  const text = String(value);
  if (/^[a-zA-Z0-9_./:-]+$/.test(text)) {
    return text;
  }
  return `"${text.replace(/(["\\$`])/g, "\\$1")}"`;
}

function formatCommand(command, args) {
  return [command, ...args].map(quoteArg).join(" ");
}

function getNumeric(value, fallback = null) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getProfileForHeight(height) {
  return VIDEO_PROFILES.find((profile) => height >= profile.minHeight) || VIDEO_PROFILES[VIDEO_PROFILES.length - 1];
}

function buildResolutionCandidates(sourceHeight) {
  const initial = Math.min(Math.max(Math.floor(sourceHeight || 180), 180), 720);
  const candidates = [initial, 480, 360, 240, 180]
    .filter((value) => value <= initial)
    .filter((value, index, list) => list.indexOf(value) === index);
  return candidates.length > 0 ? candidates : [180];
}

function buildSegmentPlan(totalDurationSeconds, maxMediaBytes) {
  const maxSegmentSeconds = getMaxSegmentSeconds(maxMediaBytes);
  if (totalDurationSeconds <= maxSegmentSeconds) {
    return [
      {
        index: 1,
        sourceStartSeconds: 0,
        sourceDurationSeconds: totalDurationSeconds,
        speedFactor: 1,
      },
    ];
  }

  if (totalDurationSeconds <= maxSegmentSeconds * (SPLIT_THRESHOLD_SECONDS / MAX_SEGMENT_SECONDS)) {
    return [
      {
        index: 1,
        sourceStartSeconds: 0,
        sourceDurationSeconds: totalDurationSeconds,
        speedFactor: totalDurationSeconds / maxSegmentSeconds,
      },
    ];
  }

  const overlapSeconds = maxSegmentSeconds * SEGMENT_OVERLAP_RATIO;
  const stepSeconds = maxSegmentSeconds - overlapSeconds;
  const segments = [];
  let start = 0;
  let index = 1;

  while (start < totalDurationSeconds) {
    const remaining = totalDurationSeconds - start;
    const duration = Math.min(maxSegmentSeconds, remaining);
    segments.push({
      index,
      sourceStartSeconds: start,
      sourceDurationSeconds: duration,
      speedFactor: 1,
    });

    if (start + duration >= totalDurationSeconds) {
      break;
    }

    start += stepSeconds;
    index += 1;
  }

  return segments;
}

function buildAtempoFilterChain(speedFactor) {
  if (!Number.isFinite(speedFactor) || speedFactor <= 0) {
    throw new Error(`Invalid speed factor: ${speedFactor}`);
  }

  const filters = [];
  let remaining = speedFactor;

  while (remaining > 2.0) {
    filters.push("atempo=2.0");
    remaining /= 2.0;
  }

  while (remaining < 0.5) {
    filters.push("atempo=0.5");
    remaining /= 0.5;
  }

  if (Math.abs(remaining - 1) > 0.0001) {
    filters.push(`atempo=${remaining.toFixed(6)}`);
  }

  return filters;
}

function buildVideoFilter({ outputHeight, speedFactor }) {
  const filters = [];

  if (Math.abs(speedFactor - 1) > 0.0001) {
    filters.push(`setpts=PTS/${speedFactor}`);
  }

  filters.push(`fps=${OUTPUT_VIDEO_FPS}`);
  filters.push(`scale=-2:${outputHeight}:flags=lanczos`);
  filters.push("format=yuv420p");

  return filters.join(",");
}

function buildAudioFilter({ speedFactor }) {
  const filters = [];
  filters.push(...buildAtempoFilterChain(speedFactor));
  return filters.length > 0 ? filters.join(",") : null;
}

async function runCommand(command, args, { log, cwd, captureStdout = false } = {}) {
  if (log) {
    log(`exec ${formatCommand(command, args)}`);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: captureStdout ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (!captureStdout && log) {
        const trimmed = text.trim();
        if (trimmed) {
          log(trimmed);
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (log) {
        const trimmed = text.trim();
        if (trimmed) {
          log(trimmed);
        }
      }
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const error = new Error(
        `${command} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`,
      );
      error.stdout = stdout;
      error.stderr = stderr;
      error.exitCode = code;
      reject(error);
    });
  });
}

export async function createRunWorkspace(prefix = "video-understand-") {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function probeMedia(filePath, log) {
  const { stdout } = await runCommand(
    "ffprobe",
    [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_streams",
      "-show_format",
      filePath,
    ],
    { log, captureStdout: true },
  );

  const payload = JSON.parse(stdout);
  const streams = Array.isArray(payload.streams) ? payload.streams : [];
  const format = payload.format || {};
  const videoStream = streams.find((stream) => stream.codec_type === "video");
  const audioStream = streams.find((stream) => stream.codec_type === "audio");

  const durationSeconds =
    getNumeric(format.duration) ??
    getNumeric(videoStream?.duration) ??
    getNumeric(audioStream?.duration);

  if (!durationSeconds || durationSeconds <= 0) {
    throw new Error("Unable to determine media duration with ffprobe.");
  }

  return {
    durationSeconds,
    video: videoStream
      ? {
          width: getNumeric(videoStream.width, 0),
          height: getNumeric(videoStream.height, 0),
          bitRate: getNumeric(videoStream.bit_rate, 0),
          codec: videoStream.codec_name || null,
        }
      : null,
    audio: audioStream
      ? {
          bitRate:
            getNumeric(audioStream.bit_rate) ??
            getNumeric(format.bit_rate) ??
            MAX_AUDIO_BITRATE_BPS,
          sampleRate: getNumeric(audioStream.sample_rate, 0),
          channels: getNumeric(audioStream.channels, 0),
          codec: audioStream.codec_name || null,
        }
      : null,
    raw: payload,
  };
}

async function encodeAudioSegment({
  inputPath,
  outputPath,
  segment,
  audioBitrateBps,
  log,
}) {
  const args = ["-y"];

  if (segment.sourceStartSeconds > 0) {
    args.push("-ss", String(segment.sourceStartSeconds));
  }

  args.push("-i", inputPath, "-t", String(segment.sourceDurationSeconds));

  const audioFilter = buildAudioFilter({ speedFactor: segment.speedFactor });
  if (audioFilter) {
    args.push("-filter:a", audioFilter);
  }

  args.push(
    "-vn",
    "-c:a",
    "aac",
    "-b:a",
    `${Math.max(MIN_AUDIO_BITRATE_BPS, Math.min(audioBitrateBps, MAX_AUDIO_BITRATE_BPS))}`,
    "-ac",
    "1",
    "-ar",
    "22050",
    "-movflags",
    "+faststart",
    outputPath,
  );

  await runCommand("ffmpeg", args, { log });
  const stat = await fsp.stat(outputPath);

  return {
    path: outputPath,
    mimeType: "audio/mp4",
    bytes: stat.size,
    targetBitrateBps: Math.max(MIN_AUDIO_BITRATE_BPS, Math.min(audioBitrateBps, MAX_AUDIO_BITRATE_BPS)),
  };
}

async function encodeVideoVariant({
  inputPath,
  outputPath,
  segment,
  outputHeight,
  targetBitrateBps,
  log,
}) {
  const args = ["-y"];

  if (segment.sourceStartSeconds > 0) {
    args.push("-ss", String(segment.sourceStartSeconds));
  }

  args.push("-i", inputPath, "-t", String(segment.sourceDurationSeconds));

  args.push(
    "-vf",
    buildVideoFilter({ outputHeight, speedFactor: segment.speedFactor }),
    "-an",
    "-c:v",
    "libx265",
    "-preset",
    "slow",
    "-b:v",
    `${targetBitrateBps}`,
    "-maxrate",
    `${Math.round(targetBitrateBps * 1.15)}`,
    "-bufsize",
    `${Math.round(targetBitrateBps * 2)}`,
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    outputPath,
  );

  await runCommand("ffmpeg", args, { log });
  const stat = await fsp.stat(outputPath);

  return {
    path: outputPath,
    mimeType: "video/mp4",
    bytes: stat.size,
    outputHeight,
    targetBitrateBps,
  };
}

async function compressSegmentVideo({
  inputPath,
  segment,
  sourceHeight,
  segmentDir,
  maxMediaBytes,
  log,
}) {
  const outputDurationSeconds = segment.sourceDurationSeconds / segment.speedFactor;
  const maxVideoBytes = maxMediaBytes - (MAX_AUDIO_BITRATE_BPS / 8) * outputDurationSeconds;
  const allowedBitrateBps = Math.max(
    35_000,
    Math.floor((maxVideoBytes * 8) / outputDurationSeconds) - 8_000,
  );
  const resolutions = buildResolutionCandidates(sourceHeight);

  log(
    `segment ${segment.index}: output duration ${outputDurationSeconds.toFixed(2)}s, allowed video bitrate ${allowedBitrateBps}bps, candidate heights ${resolutions.join(", ")}`,
  );

  for (const height of resolutions) {
    const profile = getProfileForHeight(height);
    if (allowedBitrateBps < profile.minBitrate) {
      log(
        `segment ${segment.index}: skipping ${height}p because allowed bitrate ${allowedBitrateBps}bps is below profile minimum ${profile.minBitrate}bps`,
      );
      continue;
    }

    const targetBitrateBps = Math.min(profile.preferredBitrate, allowedBitrateBps);
    const outputPath = path.join(segmentDir, `segment-${segment.index}-${height}p.mp4`);
    log(
      `segment ${segment.index}: encoding ${height}p at ${targetBitrateBps}bps (profile ${profile.label})`,
    );

    const variant = await encodeVideoVariant({
      inputPath,
      outputPath,
      segment,
      outputHeight: height,
      targetBitrateBps,
      log,
    });

    if (variant.bytes <= maxVideoBytes) {
      log(
        `segment ${segment.index}: ${height}p output size ${(variant.bytes / (1024 * 1024)).toFixed(2)}MB within limit`,
      );
      return variant;
    }

    log(
      `segment ${segment.index}: ${height}p output size ${(variant.bytes / (1024 * 1024)).toFixed(2)}MB exceeds ${(maxVideoBytes / (1024 * 1024)).toFixed(2)}MB, trying next resolution`,
    );
  }

  throw new Error(
    `Unable to compress segment ${segment.index} under ${(maxVideoBytes / (1024 * 1024)).toFixed(0)}MB without dropping below the minimum bitrate floor.`,
  );
}

export async function preprocessVideoForRequest({
  inputPath,
  runRootDir,
  maxMediaBytes,
  log,
}) {
  const mediaInfo = await probeMedia(inputPath, log);
  const sourceHeight = mediaInfo.video?.height || 180;
  const segments = buildSegmentPlan(mediaInfo.durationSeconds, maxMediaBytes);
  const targetAudioBitrateBps = mediaInfo.audio
    ? Math.max(
        MIN_AUDIO_BITRATE_BPS,
        Math.min(Math.round(mediaInfo.audio.bitRate || MAX_AUDIO_BITRATE_BPS), MAX_AUDIO_BITRATE_BPS),
      )
    : null;

  log(
    `preprocess plan: duration=${mediaInfo.durationSeconds.toFixed(2)}s, sourceHeight=${sourceHeight}, audioBitrate=${targetAudioBitrateBps ?? "none"}, segments=${segments.length}`,
  );

  const preparedSegments = [];

  for (const segment of segments) {
    const segmentDir = path.join(runRootDir, `segment-${segment.index}`);
    await fsp.mkdir(segmentDir, { recursive: true });
    log(
      `segment ${segment.index}/${segments.length}: start=${segment.sourceStartSeconds.toFixed(2)}s duration=${segment.sourceDurationSeconds.toFixed(2)}s speed=${segment.speedFactor.toFixed(6)}`,
    );

    const video = await compressSegmentVideo({
      inputPath,
      segment,
      sourceHeight,
      segmentDir,
      maxMediaBytes,
      log,
    });

    let audio = null;
    if (targetAudioBitrateBps) {
      const audioOutputPath = path.join(segmentDir, `segment-${segment.index}.m4a`);
      audio = await encodeAudioSegment({
        inputPath,
        outputPath: audioOutputPath,
        segment,
        audioBitrateBps: targetAudioBitrateBps,
        log,
      });
      log(
        `segment ${segment.index}: audio size ${(audio.bytes / (1024 * 1024)).toFixed(2)}MB at ${audio.targetBitrateBps}bps`,
      );
    }

    preparedSegments.push({
      ...segment,
      outputDurationSeconds: segment.sourceDurationSeconds / segment.speedFactor,
      video,
      audio,
    });
  }

  return {
    runRootDir,
    mediaInfo,
    preparedSegments,
  };
}

export async function removeRunWorkspace(runRootDir) {
  if (!runRootDir) return;
  await fsp.rm(runRootDir, { recursive: true, force: true });
}
