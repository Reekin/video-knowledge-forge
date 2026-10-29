import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const THIS_FILE = fileURLToPath(import.meta.url);
const SRC_DIR = path.dirname(THIS_FILE);
const TOOL_DIR = path.resolve(SRC_DIR, "..");
const ENV_PATHS = [
  path.join(TOOL_DIR, ".env"),
  path.join(TOOL_DIR, ".env.local"),
];

function toNumber(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected a number, received: ${value}`);
  }
  return parsed;
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`Expected a boolean, received: ${value}`);
}

function ensureString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required config: ${label}`);
  }
  return value.trim();
}

function uniqueNonEmptyStrings(values) {
  const seen = new Set();
  const output = [];

  for (const rawValue of values) {
    const value = typeof rawValue === "string" ? rawValue.trim() : "";
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

function resolveConfiguredModels(args = {}) {
  const cliModels = parseModelList(args.model);
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

  return ["gemini-2.5-pro"];
}

function readProviderPair(baseUrl, apiKey, label) {
  if (!baseUrl && !apiKey) {
    return null;
  }

  return {
    label,
    baseUrl: ensureString(baseUrl, `${label} BASE_URL`),
    apiKey: ensureString(apiKey, `${label} API_KEY`),
  };
}

function buildProviderListFromEnv() {
  const providers = [];
  const primary = readProviderPair(
    process.env.PROVIDER_BASE_URL,
    process.env.PROVIDER_API_KEY,
    "provider-primary",
  );
  if (primary) {
    providers.push(primary);
  }

  const indexed = new Map();

  for (const [key, rawValue] of Object.entries(process.env)) {
    const match = key.match(/^PROVIDER_(\d+)_(BASE_URL|API_KEY)$/);
    if (!match) continue;

    const [, rawIndex, field] = match;
    const index = Number(rawIndex);
    if (!indexed.has(index)) {
      indexed.set(index, {});
    }

    indexed.get(index)[field] = rawValue;
  }

  for (const [index, value] of [...indexed.entries()].sort((left, right) => left[0] - right[0])) {
    const provider = readProviderPair(
      value.BASE_URL?.trim(),
      value.API_KEY?.trim(),
      `provider-${index}`,
    );
    if (!provider) {
      continue;
    }
    providers.push(provider);
  }

  for (const [index, value] of indexed.entries()) {
    if (!value.BASE_URL?.trim() || !value.API_KEY?.trim()) {
      throw new Error(
        `Incomplete provider config: PROVIDER_${index}_BASE_URL and PROVIDER_${index}_API_KEY are both required.`,
      );
    }
  }

  return providers;
}

function resolveMaybeRelativePath(filePath) {
  if (!filePath) return undefined;
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(TOOL_DIR, filePath);
}

export function getToolDir() {
  return TOOL_DIR;
}

export function loadEnv() {
  const loadedEnvFiles = [];

  for (const envPath of ENV_PATHS) {
    if (!fs.existsSync(envPath)) {
      continue;
    }

    dotenv.config({
      path: envPath,
      override: true,
    });
    loadedEnvFiles.push(envPath);
  }

  return {
    envPaths: [...ENV_PATHS],
    loadedEnvFiles,
    hasEnvFile: loadedEnvFiles.length > 0,
  };
}

// Default media budget per request. Inline requests carry base64 media (+33%), and the
// official Gemini endpoint caps request size at about 20MB, so inline defaults to 14MB.
const DEFAULT_MAX_MEDIA_MB_GCS = 100;
const DEFAULT_MAX_MEDIA_MB_INLINE = 14;

export function buildConfig(args = {}) {
  const bucket = (args.bucket || process.env.GCS_BUCKET)?.trim() || null;
  const keyFilename =
    args["key-file"] ||
    process.env.GCS_KEY_FILENAME ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const serviceAccountJson = process.env.GCS_SERVICE_ACCOUNT_JSON;

  const storageOptions = {};
  if (process.env.GCS_PROJECT_ID) {
    storageOptions.projectId = process.env.GCS_PROJECT_ID;
  }

  if (serviceAccountJson) {
    storageOptions.credentials = JSON.parse(serviceAccountJson);
  } else if (keyFilename) {
    storageOptions.keyFilename = resolveMaybeRelativePath(keyFilename);
  }

  const providers = [];
  if (args["base-url"] || args["api-key"]) {
    providers.push({
      label: "cli-override",
      baseUrl: ensureString(args["base-url"], "--base-url"),
      apiKey: ensureString(args["api-key"], "--api-key"),
    });
  }
  providers.push(...buildProviderListFromEnv());

  if (providers.length === 0) {
    throw new Error(
      "Missing provider config. Please set PROVIDER_BASE_URL / PROVIDER_API_KEY or numbered PROVIDER_n_BASE_URL / PROVIDER_n_API_KEY in .env.",
    );
  }

  const models = resolveConfiguredModels(args);

  return {
    bucket,
    maxMediaBytes:
      toNumber(
        process.env.PROVIDER_MAX_MEDIA_MB,
        bucket ? DEFAULT_MAX_MEDIA_MB_GCS : DEFAULT_MAX_MEDIA_MB_INLINE,
      ) *
      1024 *
      1024,
    objectPrefix: (args["object-prefix"] || process.env.GCS_OBJECT_PREFIX || "video-understand").trim(),
    providers,
    model: models[0],
    models,
    timeoutMs: toNumber(args["timeout-ms"] || process.env.PROVIDER_TIMEOUT_MS, 15 * 60 * 1000),
    defaultPrompt:
      args.prompt ||
      process.env.PROVIDER_DEFAULT_PROMPT ||
      "Understand this video in detail. In the first half of your answer, output a complete sentence-by-sentence transcript with timestamps, preserving the original order of speech as closely as possible. Each transcript entry must include a timestamp range plus the spoken content, and when helpful a brief note about the corresponding visuals. After the transcript section, provide a second half with a structured summary of the key information, topics, people, objects, scene changes, and other notable details.",
    storageOptions,
  };
}

export function buildDaemonConfig(args = {}) {
  return {
    host: (args.host || process.env.DAEMON_HOST || "127.0.0.1").trim(),
    port: toNumber(args.port || process.env.DAEMON_PORT, 43177),
    maxConcurrency: toNumber(
      args["max-concurrency"] || process.env.DAEMON_MAX_CONCURRENCY,
      2,
    ),
    cleanupOnStart: toBoolean(args["cleanup-on-start"] || process.env.DAEMON_CLEANUP_ON_START, true),
    cleanupOnExit: toBoolean(args["cleanup-on-exit"] || process.env.DAEMON_CLEANUP_ON_EXIT, true),
    startupTimeoutMs: toNumber(
      args["startup-timeout-ms"] || process.env.DAEMON_STARTUP_TIMEOUT_MS,
      20000,
    ),
    pollIntervalMs: toNumber(
      args["poll-interval-ms"] || process.env.DAEMON_POLL_INTERVAL_MS,
      1000,
    ),
    taskStoreDir: resolveMaybeRelativePath(
      args["task-store-dir"] || process.env.DAEMON_TASK_STORE_DIR || "./.daemon/tasks",
    ),
  };
}
