# Setup Reference

This document explains the environment requirements, configuration, and first-use flow of the video understanding tool. All paths and commands below are relative to this directory.

## Directory Layout

- Config file: `./.env` (machine-specific overrides in `./.env.local`)
- Config template: `./.env.example`
- CLI entrypoint: `./src/cli.mjs`
- Daemon task history: `./.daemon/tasks`

## Environment Requirements

At minimum, this tool requires:

- Node.js 20 or newer
- `pnpm` 9 or newer
- `ffmpeg` (required for local file mode)
- `ffprobe` (required for local file mode)
- Chrome (or another Chromium browser) running the Kimi Browser Extension, with its daemon listening on `http://127.0.0.1:10086` (required for web page mode)
- BBDown on PATH, or `BBDOWN_PATH` pointing at it (required for Bilibili mode). Install with `dotnet tool install --global BBDown`, then run `BBDown login` once and scan the QR code with the Bilibili app so downloads can reach 1080P and above and AI subtitles are available.
- a writable local temporary directory
- at least one provider `base URL + API key` pair: a Gemini API key from Google AI Studio, or a Gemini-compatible gateway
- optionally, a Google Cloud Storage bucket and credentials (see [Media Delivery: Inline or GCS](#media-delivery-inline-or-gcs))

## Preparation Before First Use

1. Install dependencies in this directory:

```bash
pnpm install
```

`@google-cloud/storage` is an optional dependency. It is only loaded when `GCS_BUCKET` is set, so inline mode works even if it fails to install.

2. Make sure the config file exists:

```bash
cp .env.example .env
```

If `.env` already exists, you do not need to copy it again. If you prefer keeping machine-specific secrets out of the shareable default file, put them in `.env.local`, which is loaded after `.env` and overrides it.

3. Fill out `.env`. The minimal setup uses the official Gemini API with inline media:

```dotenv
PROVIDER_1_BASE_URL=https://generativelanguage.googleapis.com
PROVIDER_1_API_KEY=your-gemini-api-key

PROVIDER_MODELS=gemini-3.8-flash
PROVIDER_TIMEOUT_MS=900000
# PROVIDER_MAX_MEDIA_MB=14
PROVIDER_DEFAULT_PROMPT=Understand this video in detail. In the first half of your answer, output a complete sentence-by-sentence transcript with timestamps, preserving the original order of speech as closely as possible. Each transcript entry must include a timestamp range plus the spoken content, and when helpful a brief note about the corresponding visuals. After the transcript section, provide a second half with a structured summary of the key information, topics, people, objects, scene changes, and other notable details.

DAEMON_HOST=127.0.0.1
DAEMON_PORT=43177
DAEMON_MAX_CONCURRENCY=2
DAEMON_CLEANUP_ON_START=true
DAEMON_CLEANUP_ON_EXIT=true
DAEMON_STARTUP_TIMEOUT_MS=20000
DAEMON_POLL_INTERVAL_MS=1000
DAEMON_TASK_STORE_DIR=./.daemon/tasks
```

`PROVIDER_MODELS` accepts a comma-separated or newline-separated ordered list. For each retry round, the tool tries all configured providers with the first model, then all configured providers with the second model, and only sleeps before retrying after every configured provider/model combination fails. If `PROVIDER_MODELS` is unset, the legacy single `PROVIDER_MODEL` fallback is still supported.

## Providers and Authentication

Every provider must accept the Gemini-style `POST /v1beta/models/{model}:generateContent` request built by `src/provider-api.mjs`. Authentication depends on the host of `PROVIDER_n_BASE_URL`:

- `https://generativelanguage.googleapis.com` (official Gemini API): the key is sent as `x-goog-api-key`.
- any other host (Gemini-compatible gateway): the key is sent as `Authorization: Bearer <key>`.

## Media Delivery: Inline or GCS

Local files, Bilibili downloads, and web page captures are compressed and, when needed, split into segments before each request. Each segment's video and audio reach the provider in one of two ways:

- Inline (default, no `GCS_BUCKET`): the files are base64-encoded into the request body. No cloud account is needed. Base64 adds about 33%, and the official Gemini API limits a request to about 20MB, so the media budget defaults to 14MB per request and long videos are split into more segments.
- GCS (`GCS_BUCKET` set): the files are uploaded to the bucket, passed to the provider as public `https://storage.googleapis.com/...` URLs, and deleted after the request. Requests stay small, so the budget defaults to 100MB per request. Use this with gateways whose request-body limit is too small for inline media.

`PROVIDER_MAX_MEDIA_MB` overrides the budget in either mode.

To enable GCS, add:

```dotenv
GCS_BUCKET=your-bucket-name
GCS_PROJECT_ID=your-gcp-project-id
GCS_KEY_FILENAME=./gcp-service-account.json
GCS_OBJECT_PREFIX=video-understand
```

Instead of `GCS_KEY_FILENAME`, you can also provide `GCS_SERVICE_ACCOUNT_JSON` if you prefer injecting the whole credential JSON through the environment.

- `GCS_KEY_FILENAME` may be a relative path, resolved from this directory.
- `gcp-service-account.example.json` is only a schema template. Create your own `gcp-service-account.json` or `gcp-service-account.local.json` locally, or point `GCS_KEY_FILENAME` somewhere outside the repository.
- `GCS_OBJECT_PREFIX` should be dedicated to this tool, because the daemon clears all objects under that prefix on startup and shutdown.
- Uploaded objects must be publicly readable over HTTPS, and the provider must be able to fetch those URLs.
- The service account needs enough permission to upload objects and delete residue under the configured bucket and prefix.
- Without `GCS_BUCKET`, the daemon skips the startup and shutdown cleanup.

YouTube URLs are passed to the provider directly and use neither inline media nor GCS.

## Publishing Hygiene

Keep these paths local only:

- `.env`
- `.env.local`
- `gcp-service-account.json`
- `gcp-service-account.local.json`
- `.daemon/`
- `node_modules/`
- `downloads/`

The included `.gitignore` covers them, but you should still confirm the working tree before pushing.

## First Run

The most common first command is:

```bash
node ./src/cli.mjs --file "C:/Videos/demo.mp4" --json
```

This command automatically performs:

1. checking whether the daemon is already running
2. auto-starting the singleton daemon if it is not running
3. preprocessing video and audio
4. inlining each segment into the request, or uploading it to GCS when `GCS_BUCKET` is set
5. calling the provider
6. deleting uploaded GCS objects, if any
7. writing results and logs into the local history store

If you submit a YouTube URL instead, preprocessing and media delivery are skipped:

```bash
node ./src/cli.mjs --youtube-url "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --json
```

To analyze a video that is playing on a page in your own browser, start with the
browser (and its extension daemon) running:

```bash
# List what the page is actually streaming, with duration and renditions.
node ./src/cli.mjs --web-url "https://example.com/play/12345" --probe --json

# Download the highest-ranked candidate into ./downloads and analyze it.
node ./src/cli.mjs --web-url "https://example.com/play/12345" --json
```

Web page mode navigates the session tab to that URL, waits for the page's own media
requests, resolves the playlist behind them, and downloads the stream with `ffmpeg`
before handing the file to the normal local-file pipeline. It never records the
screen, so a one-hour video takes minutes rather than an hour.

## Common Commands

Submit a task and wait for the result:

```bash
node ./src/cli.mjs --file "C:/Videos/demo.mp4" --json
```

Submit a YouTube URL and wait for the result:

```bash
node ./src/cli.mjs --youtube-url "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --json
```

Analyze a Bilibili video, or only download it with its subtitles:

```bash
node ./src/cli.mjs --bili-url "https://www.bilibili.com/video/BV1GJ411x7h7" --json
node ./src/cli.mjs --bili-url BV1GJ411x7h7 --page 2 --sub-lang ai-zh --json
node ./src/cli.mjs --bili-url BV1GJ411x7h7 --download-only
```

Inspect the streams a page is serving, then analyze the one you pick:

```bash
node ./src/cli.mjs --web-url "https://example.com/play/12345" --probe --json
node ./src/cli.mjs --web-url "https://example.com/play/12345" --stream-id s1 --json
node ./src/cli.mjs --web-url "https://example.com/play/12345" --variant 2 --max-seconds 120 --json
```

Submit a task without waiting:

```bash
node ./src/cli.mjs --file "C:/Videos/demo.mp4" --no-wait
```

Check daemon status:

```bash
node ./src/cli.mjs --server-status
```

Check task history:

```bash
node ./src/cli.mjs --status
node ./src/cli.mjs --status --task-id "<task-id>"
```

Stop the daemon:

```bash
node ./src/cli.mjs --stop-server
```

## Troubleshooting Tips

- If `--server-status` reports that the daemon is unreachable, first check whether `.env` is complete and whether `DAEMON_HOST` or `DAEMON_PORT` is already in use.
- If a task fails, first inspect the live CLI logs or the `error` and `logs` returned by `--status --task-id`.
- If only longer videos fail with `400 Request contains an invalid argument` while short ones succeed, the gateway is rejecting the media size (one relay accepted about 18MB of video + audio and rejected 20MB). Set `PROVIDER_MAX_MEDIA_MB` below that size; long videos are then split into more segments. A 400 is deterministic, so a task that keeps retrying it only wastes time: stop it and fix the cause.
- If you need to keep local intermediate files for debugging, submit the task with `--keep-temp`.
- If the provider rejects the request with 401/403, verify the base URL host and key type (see [Providers and Authentication](#providers-and-authentication)).
- If uploads succeed but provider requests fail, verify that the generated `https://storage.googleapis.com/<bucket>/<object>` URLs are publicly readable by the provider.
- `--youtube-url` only accepts `youtube.com` and `youtu.be` links. Other video hosts are rejected before the provider request is sent.
- If `--bili-url` reports `not logged in`, run `BBDown login`, then rerun with `--redownload` so the cached low-quality copy is replaced.
- `--web-url` needs the browser extension daemon. An error mentioning `Cannot reach the browser extension daemon` means the browser or that daemon is not running.
- If a web probe finds no candidate and reports `needsUserAction`, the page is not playing yet or its player only accepts a real click. Start playback and probe again; the tool intentionally does not reload a page a user has just started.
