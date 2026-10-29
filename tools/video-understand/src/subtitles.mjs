// Reference subtitles: parse an SRT file and render the cues that fall inside one
// preprocessed segment, re-timed to that segment's own media timeline.

import fs from "node:fs";
import path from "node:path";

function parseTimestamp(value) {
  const match = String(value).trim().match(/^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!match) return null;
  const [, h, m, s, ms] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, "0")) / 1000;
}

export function parseSrt(text) {
  const cues = [];
  const blocks = String(text).replace(/^\uFEFF/, "").replace(/\r/g, "").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((line) => line.trim() !== "");
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const [rawStart, rawEnd] = lines[timingIndex].split("-->");
    const start = parseTimestamp(rawStart);
    const end = parseTimestamp(rawEnd);
    const content = lines.slice(timingIndex + 1).join(" ").trim();
    if (start === null || end === null || !content) continue;
    cues.push({ start, end, text: content });
  }
  return cues;
}

function formatClock(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}

// Bilibili AI subtitles are named like "<stem>.ai-zh.srt"; human CC subtitles
// carry a plain language code.
export function describeSubtitleFile(filePath) {
  const name = path.basename(filePath, ".srt");
  const lang = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "unknown";
  return { path: filePath, lang, kind: lang.startsWith("ai-") ? "ai" : "human" };
}

export function loadSubtitles(filePath, kind = null) {
  const resolved = path.resolve(filePath);
  const cues = parseSrt(fs.readFileSync(resolved, "utf8"));
  const described = describeSubtitleFile(resolved);
  return { ...described, kind: kind || described.kind, cues };
}

export function buildSubtitlePromptSection(subtitles, segment) {
  if (!subtitles || subtitles.cues.length === 0) return null;

  const start = segment.sourceStartSeconds;
  const end = start + segment.sourceDurationSeconds;
  const speed = segment.speedFactor;
  const lines = subtitles.cues
    .filter((cue) => cue.end > start && cue.start < end)
    .map((cue) => {
      const from = (Math.max(cue.start, start) - start) / speed;
      const to = (Math.min(cue.end, end) - start) / speed;
      return `[${formatClock(from)}-${formatClock(to)}] ${cue.text}`;
    });
  if (lines.length === 0) return null;

  const guidance =
    subtitles.kind === "human"
      ? "These are human-made subtitles. Treat their wording as authoritative for the transcript, keep the audio as the reference for timing, and add any speech the subtitles leave out."
      : "These are machine-generated subtitles. Use them as a strong hint for names, terms, and wording, but verify every line against the audio and correct recognition errors.";

  return [
    `Reference subtitles (${subtitles.kind}, language: ${subtitles.lang}), timed to this segment's media timeline:`,
    guidance,
    lines.join("\n"),
  ].join("\n");
}
