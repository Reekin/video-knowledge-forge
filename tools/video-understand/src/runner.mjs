import fs from "node:fs";
import path from "node:path";
import { lookup as lookupMimeType } from "mime-types";
import { buildConfig } from "./config.mjs";
import {
  createPublicObjectUrl,
  createStorageClient,
  deleteObject,
  uploadFile,
} from "./gcs.mjs";
import {
  createRunWorkspace,
  preprocessVideoForRequest,
  removeRunWorkspace,
} from "./media-preprocess.mjs";
import { generateVideoUnderstanding } from "./provider-api.mjs";
import { buildSubtitlePromptSection, loadSubtitles } from "./subtitles.mjs";

const PROVIDER_RETRY_BASE_DELAY_MS = 5000;
const PROVIDER_RETRY_MAX_ROUNDS = 10;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatProviderLabel(provider, index) {
  return provider.label || `provider-${index + 1}`;
}

export function serializeError(error) {
  if (!error) {
    return { message: "Unknown error" };
  }

  const output = {
    name: error.name || "Error",
    message: error.message || String(error),
  };

  if (error.stack) output.stack = error.stack;
  if (error.status !== undefined) output.status = error.status;
  if (error.rawText !== undefined) output.rawText = error.rawText;
  if (error.payload !== undefined) output.payload = error.payload;
  if (error.failures !== undefined) output.failures = error.failures;

  return output;
}

function emitLog(onLog, payload) {
  if (!onLog) return;
  onLog(payload);
}

function createScopedLogger(scope, onLog) {
  return (message) => {
    emitLog(onLog, {
      event: "log",
      scope,
      message,
    });
  };
}

async function generateWithProviderFailover({
  providers,
  models,
  model,
  prompt,
  mediaParts,
  timeoutMs,
  onLog,
  scope,
}) {
  const configuredModels =
    Array.isArray(models) && models.length > 0
      ? models
      : typeof model === "string" && model.trim() !== ""
        ? [model.trim()]
        : [];

  if (configuredModels.length === 0) {
    throw new Error("Missing model configuration for provider failover.");
  }

  const failures = [];

  for (let round = 1; round <= PROVIDER_RETRY_MAX_ROUNDS; round += 1) {
    emitLog(onLog, {
      event: "log",
      scope,
      message: `provider round ${round}/${PROVIDER_RETRY_MAX_ROUNDS} started with ${configuredModels.length} model candidate(s)`,
    });

    for (let modelIndex = 0; modelIndex < configuredModels.length; modelIndex += 1) {
      const currentModel = configuredModels[modelIndex];
      emitLog(onLog, {
        event: "log",
        scope,
        message: `model candidate ${modelIndex + 1}/${configuredModels.length}: ${currentModel}`,
      });

      for (let index = 0; index < providers.length; index += 1) {
        const provider = providers[index];
        const providerLabel = formatProviderLabel(provider, index);
        emitLog(onLog, {
          event: "log",
          scope,
          message: `trying ${providerLabel} (${index + 1}/${providers.length}) with model ${currentModel} via ${provider.baseUrl}`,
        });

        try {
          const result = await generateVideoUnderstanding({
            apiKey: provider.apiKey,
            baseUrl: provider.baseUrl,
            model: currentModel,
            prompt,
            mediaParts,
            timeoutMs,
          });

          emitLog(onLog, {
            event: "log",
            scope,
            message: `provider ${providerLabel} succeeded in round ${round} with model ${currentModel}`,
          });

          return {
            ...result,
            model: currentModel,
            modelIndex: modelIndex + 1,
            requestedModels: [...configuredModels],
            provider: {
              label: providerLabel,
              index: index + 1,
              baseUrl: provider.baseUrl,
            },
            providerRetryRound: round,
            providerFailures: failures,
          };
        } catch (error) {
          emitLog(onLog, {
            event: "provider_failed",
            scope,
            round,
            model: currentModel,
            modelIndex: modelIndex + 1,
            providerIndex: index + 1,
            providerLabel,
            baseUrl: provider.baseUrl,
            error: serializeError(error),
          });
          failures.push({
            round,
            model: currentModel,
            modelIndex: modelIndex + 1,
            providerIndex: index + 1,
            providerLabel,
            baseUrl: provider.baseUrl,
            status: error?.status || null,
            message: error?.message || String(error),
          });
        }
      }

      emitLog(onLog, {
        event: "log",
        scope,
        message: `all providers failed for model ${currentModel} in round ${round}`,
      });
    }

    if (round < PROVIDER_RETRY_MAX_ROUNDS) {
      const delayMs = PROVIDER_RETRY_BASE_DELAY_MS * (2 ** (round - 1));
      emitLog(onLog, {
        event: "log",
        scope,
        message: `all providers failed for every configured model in round ${round}; sleeping ${delayMs}ms before next round`,
      });
      await sleep(delayMs);
    }
  }

  const latestFailure = failures[failures.length - 1];
  const finalError = new Error(
    latestFailure
      ? `All configured provider/model combinations failed after ${PROVIDER_RETRY_MAX_ROUNDS} rounds. Last error: ${latestFailure.message}`
      : `All configured provider/model combinations failed after ${PROVIDER_RETRY_MAX_ROUNDS} rounds.`,
  );
  finalError.failures = failures;
  throw finalError;
}

function collectUsedModels(segmentResults) {
  return [...new Set(segmentResults.map((segment) => segment.model).filter(Boolean))];
}

function pickResultModel(modelsUsed) {
  return modelsUsed.length === 1 ? modelsUsed[0] : null;
}

function buildModelResultMetadata({ requestedModels, modelsUsed }) {
  return {
    model: pickResultModel(modelsUsed),
    models: [...requestedModels],
    modelsUsed: [...modelsUsed],
  };
}

function buildYoutubeResultMetadata({ requestedModels, understanding }) {
  const modelsUsed = understanding.model ? [understanding.model] : [];
  return buildModelResultMetadata({
    requestedModels,
    modelsUsed,
  });
}

function buildSegmentResultMetadata({ requestedModels, segmentResults }) {
  return buildModelResultMetadata({
    requestedModels,
    modelsUsed: collectUsedModels(segmentResults),
  });
}

function resolveFilePath(filePath) {
  if (!filePath) {
    throw new Error("Missing required argument: --file");
  }

  const resolved = path.resolve(filePath);
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) {
    throw new Error(`Video file does not exist: ${resolved}`);
  }
  return resolved;
}

export function normalizeAndValidateYoutubeUrl(youtubeUrl) {
  if (!youtubeUrl) {
    throw new Error("Missing required argument: --youtube-url");
  }

  let parsed;
  try {
    parsed = new URL(String(youtubeUrl).trim());
  } catch {
    throw new Error(`Invalid URL for --youtube-url: ${youtubeUrl}`);
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Unsupported --youtube-url protocol. Only http(s) URLs are allowed.");
  }

  const host = parsed.hostname.toLowerCase();
  const isYoutubeHost =
    host === "youtube.com" ||
    host === "www.youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "youtu.be" ||
    host.endsWith(".youtu.be");

  if (!isYoutubeHost) {
    throw new Error(
      "Unsupported --youtube-url host. Only youtube.com and youtu.be URLs are accepted.",
    );
  }

  return parsed.toString();
}

function detectMimeType(filePath, argMimeType) {
  const mimeType = argMimeType || lookupMimeType(filePath);
  if (!mimeType || !String(mimeType).startsWith("video/")) {
    throw new Error(
      `Unable to detect a video MIME type for ${filePath}. Please pass --mime-type explicitly.`,
    );
  }
  return String(mimeType);
}

function buildSegmentPrompt({
  basePrompt,
  segmentIndex,
  totalSegments,
  previousResults,
  hasAudio,
  subtitleSection,
}) {
  const isFinalSegment = segmentIndex === totalSegments;
  const includeSummary = totalSegments === 1 || isFinalSegment;
  const intro = [
    `You are currently processing video segment ${segmentIndex}/${totalSegments}.`,
    "Audio is the primary source of information, and the video is only supporting context.",
    hasAudio
      ? "Prioritize the audio to understand meaning, spoken content, and event progression, then use the video to supplement people, scenes, subtitles, and actions."
      : "There is no separate audio file for this segment, so complete the understanding task using only the video.",
    `User request: ${basePrompt}`,
  ];

  if (previousResults.length > 0) {
    intro.push(
      "Below are the results from all previous segments. Treat them as prior context and maintain continuity while understanding the current segment:",
      previousResults
        .map((result, index) => `Prior context ${index + 1}:\n${result}`)
        .join("\n\n"),
    );
  } else {
    intro.push("This is the first segment, so there is no prior context.");
  }

  if (subtitleSection) {
    intro.push(subtitleSection);
  }

  intro.push(
    "Return a detailed understanding of the current segment.",
    "Output a complete sentence-by-sentence transcript with timestamp ranges in chronological order. Each entry must include the time range and the spoken content. When useful, add a brief visual note for the same time range, but do not skip spoken content in favor of transcript coverage.",
  );

  if (includeSummary) {
    intro.push(
      totalSegments === 1
        ? "After the transcript section, provide a second half with a structured summary of the full video, including the key information, topics, people, objects, scene changes, major timeline points, and notable details."
        : "After the transcript section, provide a second half with a structured summary of the full video so far, combining all previous segment context with the current segment. The summary should cover the overall key information, topics, people, objects, scene changes, major timeline points, and notable details.",
    );
  } else {
    intro.push(
      "Do not include a summary, recap, conclusion, key-points section, or any other wrap-up for this segment. Only output the timestamped transcript for this segment.",
    );
  }

  return intro.join("\n\n");
}

function buildCombinedResultText(segmentResults) {
  return segmentResults
    .map(
      (segment) =>
        `### Segment ${segment.segmentIndex}/${segment.totalSegments}\n\n${segment.resultText || ""}`.trim(),
    )
    .join("\n\n");
}

// With a bucket the asset is uploaded to GCS and referenced by public URL; without one
// it is sent inline as base64 in the request body.
async function prepareSegmentAsset({
  storage,
  bucketName,
  objectPrefix,
  filePath,
  mimeType,
  onLog,
  scope,
}) {
  if (!storage) {
    const data = (await fs.promises.readFile(filePath)).toString("base64");
    emitLog(onLog, {
      event: "log",
      scope,
      message: `inlined ${path.basename(filePath)} (${(data.length / (1024 * 1024)).toFixed(2)}MB base64)`,
    });
    return { mimeType, filePath, data, publicUrl: null };
  }

  const uploaded = await uploadFile({
    storage,
    bucketName,
    filePath,
    objectPrefix,
    mimeType,
  });
  const publicUrl = createPublicObjectUrl({
    bucketName: uploaded.bucketName,
    objectName: uploaded.objectName,
  });
  emitLog(onLog, {
    event: "log",
    scope,
    message: `uploaded ${path.basename(filePath)} -> ${publicUrl}`,
  });
  return {
    ...uploaded,
    publicUrl,
    mimeType,
    filePath,
  };
}

function toMediaPart(asset) {
  return asset.data
    ? { mimeType: asset.mimeType, data: asset.data }
    : { mimeType: asset.mimeType, fileUri: asset.publicUrl };
}

export async function runVideoTask({
  args,
  onLog,
}) {
  const hasFile = Boolean(args.file);
  const hasYoutubeUrl = Boolean(args["youtube-url"]);

  if (hasFile === hasYoutubeUrl) {
    throw new Error("Please provide exactly one input source: use either --file or --youtube-url.");
  }

  const config = buildConfig(args);
  const prompt = args.prompt || config.defaultPrompt;
  const requestedModels = config.models;
  const youtubeUrl = hasYoutubeUrl ? normalizeAndValidateYoutubeUrl(args["youtube-url"]) : null;

  if (youtubeUrl) {
    emitLog(onLog, {
      event: "log",
      scope: "task",
      message: `using direct YouTube URL input: ${youtubeUrl}`,
    });

    const understanding = await generateWithProviderFailover({
      providers: config.providers,
      models: requestedModels,
      prompt,
      mediaParts: [
        {
          fileUri: youtubeUrl,
          mimeType: "video/*",
        },
      ],
      timeoutMs: config.timeoutMs,
      onLog,
      scope: "youtube",
    });

    return {
      filePath: null,
      youtubeUrl,
      prompt,
      ...buildYoutubeResultMetadata({
        requestedModels,
        understanding,
      }),
      bucket: null,
      runRootDir: null,
      preprocessing: null,
      segments: [
        {
          segmentIndex: 1,
          totalSegments: 1,
          sourceStartSeconds: 0,
          sourceDurationSeconds: null,
          speedFactor: 1,
          outputDurationSeconds: null,
          video: {
            publicUrl: youtubeUrl,
            bytes: null,
            outputHeight: null,
            targetBitrateBps: null,
          },
          audio: null,
          model: understanding.model,
          modelIndex: understanding.modelIndex,
          provider: understanding.provider,
          providerRetryRound: understanding.providerRetryRound,
          providerFailures: [...understanding.providerFailures],
          resultText: understanding.text,
          rawResponse: understanding.raw,
        },
      ],
      resultText: understanding.text,
    };
  }

  const filePath = resolveFilePath(args.file);
  detectMimeType(filePath, args["mime-type"]);
  const subtitles = args["subtitle-file"]
    ? loadSubtitles(args["subtitle-file"], args["subtitle-kind"] || null)
    : null;
  if (subtitles) {
    emitLog(onLog, {
      event: "log",
      scope: "task",
      message: `using ${subtitles.kind} reference subtitles (${subtitles.lang}, ${subtitles.cues.length} cues) from ${subtitles.path}`,
    });
  }
  const storage = config.bucket ? await createStorageClient(config.storageOptions) : null;
  const keepTemp = args["keep-temp"] === "true";
  const runRootDir = await createRunWorkspace();
  let success = false;
  const uploadedObjects = [];

  try {
    emitLog(onLog, {
      event: "log",
      scope: "task",
      message: `created run workspace ${runRootDir}; media delivery: ${storage ? `GCS bucket ${config.bucket}` : "inline"}, budget ${(config.maxMediaBytes / (1024 * 1024)).toFixed(0)}MB per request`,
    });

    const preprocess = await preprocessVideoForRequest({
      inputPath: filePath,
      runRootDir,
      maxMediaBytes: config.maxMediaBytes,
      log: createScopedLogger("preprocess", onLog),
    });

    const segmentResults = [];

    for (const segment of preprocess.preparedSegments) {
      const scope = `segment-${segment.index}`;
      const segmentUploads = [];
      // Only uploaded GCS objects need deleting; inline assets have nothing remote.
      const trackRemote = (asset) => {
        if (!asset.objectName) return;
        segmentUploads.push(asset);
        uploadedObjects.push(asset);
      };

      try {
        emitLog(onLog, {
          event: "log",
          scope,
          message: `starting request flow for segment ${segment.index}/${preprocess.preparedSegments.length}`,
        });

        const videoAsset = await prepareSegmentAsset({
          storage,
          bucketName: config.bucket,
          objectPrefix: config.objectPrefix,
          filePath: segment.video.path,
          mimeType: segment.video.mimeType,
          onLog,
          scope,
        });
        trackRemote(videoAsset);

        let audioAsset = null;
        if (segment.audio) {
          audioAsset = await prepareSegmentAsset({
            storage,
            bucketName: config.bucket,
            objectPrefix: config.objectPrefix,
            filePath: segment.audio.path,
            mimeType: segment.audio.mimeType,
            onLog,
            scope,
          });
          trackRemote(audioAsset);
        }

        const currentPrompt = buildSegmentPrompt({
          basePrompt: prompt,
          segmentIndex: segment.index,
          totalSegments: preprocess.preparedSegments.length,
          previousResults: segmentResults.map((item) => item.resultText),
          hasAudio: Boolean(audioAsset),
          subtitleSection: buildSubtitlePromptSection(subtitles, segment),
        });

        const mediaParts = [audioAsset, videoAsset].filter(Boolean).map(toMediaPart);

        const understanding = await generateWithProviderFailover({
          providers: config.providers,
          models: requestedModels,
          prompt: currentPrompt,
          mediaParts,
          timeoutMs: config.timeoutMs,
          onLog,
          scope,
        });

        segmentResults.push({
          segmentIndex: segment.index,
          totalSegments: preprocess.preparedSegments.length,
          sourceStartSeconds: segment.sourceStartSeconds,
          sourceDurationSeconds: segment.sourceDurationSeconds,
          speedFactor: segment.speedFactor,
          outputDurationSeconds: segment.outputDurationSeconds,
          video: {
            publicUrl: videoAsset.publicUrl,
            bytes: segment.video.bytes,
            outputHeight: segment.video.outputHeight,
            targetBitrateBps: segment.video.targetBitrateBps,
          },
          audio: audioAsset
            ? {
                publicUrl: audioAsset.publicUrl,
                bytes: segment.audio.bytes,
                targetBitrateBps: segment.audio.targetBitrateBps,
              }
            : null,
          model: understanding.model,
          modelIndex: understanding.modelIndex,
          provider: understanding.provider,
          providerRetryRound: understanding.providerRetryRound,
          providerFailures: [...understanding.providerFailures],
          resultText: understanding.text,
          rawResponse: understanding.raw,
        });

        emitLog(onLog, {
          event: "log",
          scope,
          message: `segment ${segment.index} completed successfully`,
        });
      } finally {
        for (const asset of segmentUploads) {
          try {
            const deleted = await deleteObject({
              storage,
              bucketName: asset.bucketName,
              objectName: asset.objectName,
            });
            if (deleted) {
              emitLog(onLog, {
                event: "log",
                scope,
                message: `deleted remote object gs://${asset.bucketName}/${asset.objectName}`,
              });
            }
          } catch (error) {
            emitLog(onLog, {
              event: "delete_failed",
              scope,
              bucket: asset.bucketName,
              objectName: asset.objectName,
              error: serializeError(error),
            });
          }
        }
      }
    }

    success = true;
    return {
      filePath,
      prompt,
      subtitles: subtitles
        ? { path: subtitles.path, lang: subtitles.lang, kind: subtitles.kind, cues: subtitles.cues.length }
        : null,
      ...buildSegmentResultMetadata({
        requestedModels,
        segmentResults,
      }),
      bucket: config.bucket,
      runRootDir,
      preprocessing: {
        sourceDurationSeconds: preprocess.mediaInfo.durationSeconds,
        sourceVideo: preprocess.mediaInfo.video,
        sourceAudio: preprocess.mediaInfo.audio,
        segmentCount: preprocess.preparedSegments.length,
      },
      segments: segmentResults,
      resultText: buildCombinedResultText(segmentResults),
    };
  } finally {
    for (const asset of uploadedObjects) {
      try {
        await deleteObject({
          storage,
          bucketName: asset.bucketName,
          objectName: asset.objectName,
        });
      } catch {
        // Segment-level cleanup already emitted details.
      }
    }

    if (keepTemp) {
      emitLog(onLog, {
        event: "log",
        scope: "task",
        message: `keeping run workspace ${runRootDir}`,
      });
      return;
    }

    if (success) {
      await removeRunWorkspace(runRootDir);
      emitLog(onLog, {
        event: "log",
        scope: "task",
        message: `removed run workspace ${runRootDir}`,
      });
    } else {
      emitLog(onLog, {
        event: "log",
        scope: "task",
        message: `run failed; keeping workspace for inspection: ${runRootDir}`,
      });
    }
  }
}
