import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { normalizeAndValidateYoutubeUrl } from "./runner.mjs";

const DEFAULT_MODEL = "gemini-2.5-pro";
const DEFAULT_OBJECT_PREFIX = "video-understand";
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_PROMPT =
  "Understand this video in detail. In the first half of your answer, output a complete sentence-by-sentence transcript with timestamps, preserving the original order of speech as closely as possible. Each transcript entry must include a timestamp range plus the spoken content, and when helpful a brief note about the corresponding visuals. After the transcript section, provide a second half with a structured summary of the key information, topics, people, objects, scene changes, and other notable details.";

function normalizeOptionalString(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const text = String(value).trim();
  return text === "" ? null : text;
}

function uniqueNonEmptyStrings(values) {
  const seen = new Set();
  const output = [];

  for (const rawValue of values) {
    const value = normalizeOptionalString(rawValue);
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    output.push(value);
  }

  return output;
}

function parseModelList(value) {
  if (value === undefined || value === null) {
    return [];
  }

  return uniqueNonEmptyStrings(String(value).split(/[\r\n,]+/));
}

function resolveConfiguredModels(argsLike = {}) {
  const cliModels = parseModelList(argsLike.model);
  if (cliModels.length > 0) {
    return cliModels;
  }

  const envModels = uniqueNonEmptyStrings([
    ...parseModelList(process.env.PROVIDER_MODELS),
    ...parseModelList(process.env.PROVIDER_MODEL_LIST),
  ]);
  if (envModels.length > 0) {
    return envModels;
  }

  const legacyModel = parseModelList(process.env.PROVIDER_MODEL);
  if (legacyModel.length > 0) {
    return legacyModel;
  }

  return [DEFAULT_MODEL];
}

function collectConfiguredProviderBaseUrls(argsLike = {}) {
  const providers = [];
  const cliBaseUrl = normalizeOptionalString(argsLike["base-url"] ?? argsLike.baseUrl);
  if (cliBaseUrl) {
    providers.push(cliBaseUrl);
  }

  const primaryEnvBaseUrl = normalizeOptionalString(process.env.PROVIDER_BASE_URL);
  if (primaryEnvBaseUrl) {
    providers.push(primaryEnvBaseUrl);
  }

  const indexedProviders = [];
  for (const [key, value] of Object.entries(process.env)) {
    const match = key.match(/^PROVIDER_(\d+)_BASE_URL$/);
    if (!match) {
      continue;
    }

    indexedProviders.push({
      index: Number(match[1]),
      baseUrl: normalizeOptionalString(value),
    });
  }

  indexedProviders.sort((left, right) => left.index - right.index);
  providers.push(...indexedProviders.map((entry) => entry.baseUrl));
  return uniqueNonEmptyStrings(providers);
}

function resolveEffectivePrompt(argsLike = {}) {
  return (
    normalizeOptionalString(argsLike.prompt) ||
    normalizeOptionalString(process.env.PROVIDER_DEFAULT_PROMPT) ||
    DEFAULT_PROMPT
  );
}

function normalizeTimeoutMs(argsLike = {}) {
  return normalizeOptionalString(argsLike["timeout-ms"] ?? argsLike.timeoutMs) || String(
    process.env.PROVIDER_TIMEOUT_MS || DEFAULT_TIMEOUT_MS,
  );
}

function normalizeSource(argsLike = {}) {
  const youtubeUrl = argsLike["youtube-url"] ?? argsLike.youtubeUrl ?? null;
  if (youtubeUrl) {
    try {
      return {
        kind: "youtube",
        value: normalizeAndValidateYoutubeUrl(youtubeUrl),
      };
    } catch {
      return {
        kind: "youtube",
        value: String(youtubeUrl).trim(),
      };
    }
  }

  const filePath = argsLike.file ?? null;
  if (filePath) {
    const resolvedPath = path.resolve(String(filePath));
    const stat = fs.statSync(resolvedPath, { throwIfNoEntry: false });

    return {
      kind: "file",
      value: resolvedPath,
      size: stat?.isFile() ? stat.size : null,
      mtimeMs: stat?.isFile() ? Math.trunc(stat.mtimeMs) : null,
    };
  }

  return null;
}

function statusPriority(status) {
  switch (status) {
    case "succeeded":
      return 3;
    case "running":
      return 2;
    case "queued":
      return 1;
    default:
      return 0;
  }
}

function normalizeSubtitle(argsLike = {}) {
  const subtitlePath = argsLike["subtitle-file"] ?? null;
  if (!subtitlePath) return null;
  const resolvedPath = path.resolve(String(subtitlePath));
  const stat = fs.statSync(resolvedPath, { throwIfNoEntry: false });
  return {
    value: resolvedPath,
    kind: normalizeOptionalString(argsLike["subtitle-kind"]),
    mtimeMs: stat?.isFile() ? Math.trunc(stat.mtimeMs) : null,
  };
}

export function buildTaskDedupKey(argsLike = {}) {
  const source = normalizeSource(argsLike);
  if (!source) {
    return null;
  }

  const payload = {
    source,
    subtitle: normalizeSubtitle(argsLike),
    prompt: resolveEffectivePrompt(argsLike),
    models: resolveConfiguredModels(argsLike),
    bucket: normalizeOptionalString(argsLike.bucket ?? process.env.GCS_BUCKET),
    objectPrefix:
      normalizeOptionalString(
        argsLike["object-prefix"] ?? argsLike.objectPrefix ?? process.env.GCS_OBJECT_PREFIX,
      ) || DEFAULT_OBJECT_PREFIX,
    timeoutMs: normalizeTimeoutMs(argsLike),
    mimeType: normalizeOptionalString(argsLike["mime-type"] ?? argsLike.mimeType),
    providerBaseUrls: collectConfiguredProviderBaseUrls(argsLike),
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function findReusableTask(tasks, dedupKey) {
  if (!dedupKey) {
    return null;
  }

  const candidates = tasks
    .filter((task) => task?.dedupKey === dedupKey)
    .filter((task) => ["queued", "running", "succeeded"].includes(task.status));

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((left, right) => {
    const statusDelta = statusPriority(right.status) - statusPriority(left.status);
    if (statusDelta !== 0) {
      return statusDelta;
    }

    return String(right.createdAt || "").localeCompare(String(left.createdAt || ""));
  });

  return candidates[0];
}
