// Rough classification of a captured request, used to decide what is worth parsing.
//
// Only the transport-level kind is decided here. Whether a playlist is a master,
// a rendition, or a standalone audio track is decided later from the manifest body,
// because guessing that role from the URL is what makes naive tools pick audio-only
// playlists as their top candidate.

const HLS_EXTENSIONS = new Set(["m3u8", "m3u"]);
const DASH_EXTENSIONS = new Set(["mpd"]);
const FILE_EXTENSIONS = new Set(["mp4", "m4v", "mov", "f4v", "webm"]);
const SEGMENT_EXTENSIONS = new Set(["ts", "m2ts", "mp2t", "m4s", "cmfv", "cmfa", "aac", "vtt"]);

const HLS_MIME_TYPES = new Set([
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "application/mpegurl",
  "audio/mpegurl",
  "audio/x-mpegurl",
]);
const DASH_MIME_TYPES = new Set(["application/dash+xml"]);
const SEGMENT_MIME_TYPES = new Set(["video/mp2t", "video/iso.segment"]);

export const CANDIDATE_KINDS = new Set(["hls", "dash", "file"]);

function extensionOf(url) {
  const path = new URL(url).pathname;
  const name = path.split("/").pop() || "";
  const index = name.lastIndexOf(".");
  return index === -1 ? "" : name.slice(index + 1).toLowerCase();
}

function normalizeMime(mimeType) {
  return String(mimeType || "").split(";")[0].trim().toLowerCase();
}

export function inferKind(url, mimeType) {
  const extension = extensionOf(url);
  const mime = normalizeMime(mimeType);

  if (HLS_EXTENSIONS.has(extension) || HLS_MIME_TYPES.has(mime)) return "hls";
  if (DASH_EXTENSIONS.has(extension) || DASH_MIME_TYPES.has(mime)) return "dash";
  if (SEGMENT_EXTENSIONS.has(extension) || SEGMENT_MIME_TYPES.has(mime)) return "segment";
  if (FILE_EXTENSIONS.has(extension) || mime.startsWith("video/")) return "file";
  return "other";
}
