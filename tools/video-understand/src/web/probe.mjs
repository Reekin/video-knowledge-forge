// Observation layer: collect candidate streams from the current browser tab and
// enrich them with the facts a caller needs to choose (duration, renditions,
// separate tracks, encryption, live status).

import { PAGE_PROBE_SCRIPT } from "./bridge.mjs";
import { CANDIDATE_KINDS, inferKind } from "./classify.mjs";
import { parseM3u8, parseMpd } from "./manifest.mjs";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";

const FORWARDED_HEADERS = new Set(["user-agent", "referer", "cookie", "origin", "accept-language"]);

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function httpGetText(url, headers = {}, timeoutMs = 20000) {
  const requestHeaders = { "User-Agent": DEFAULT_USER_AGENT, Accept: "*/*" };
  for (const [key, value] of Object.entries(headers)) {
    if (FORWARDED_HEADERS.has(key.toLowerCase())) requestHeaders[key] = value;
  }
  const response = await fetch(url, { headers: requestHeaders, signal: AbortSignal.timeout(timeoutMs) });
  return response.text();
}

function detailText(detail) {
  const body = detail?.body;
  if (!body) return null;
  if (detail.base64Encoded) {
    try {
      return Buffer.from(body, "base64").toString("utf8");
    } catch (error) {
      return null;
    }
  }
  return String(body);
}

function detailHeaders(detail) {
  const headers = {};
  for (const [key, value] of Object.entries(detail?.requestHeaders || {})) {
    headers[String(key).toLowerCase()] = String(value);
  }
  return headers;
}

export async function ensureCapture(bridge, fresh) {
  // Restarting the capture clears everything the extension recorded so far, so it
  // only happens when the buffer is empty. Otherwise a caller who asked the user to
  // press play would wipe exactly the requests that play produced.
  if (fresh) {
    await bridge.networkStart();
    return true;
  }
  let listing;
  try {
    listing = await bridge.networkList();
  } catch (error) {
    await bridge.networkStart();
    return true;
  }
  if (!(listing.requests || []).length) {
    await bridge.networkStart();
    return true;
  }
  return false;
}

export function selectRequests(requests, seen = new Set()) {
  const selected = [];
  for (const item of requests) {
    const url = item.url || "";
    if (!url.startsWith("http://") && !url.startsWith("https://")) continue;
    if (typeof item.status === "number" && (item.status < 200 || item.status >= 300)) continue;
    if (!item.requestId) continue;
    const kind = inferKind(url, item.mimeType);
    if (!CANDIDATE_KINDS.has(kind)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    selected.push({ ...item, kind });
  }
  return selected;
}

async function buildStream(bridge, item, notes) {
  const stream = {
    id: null,
    role: item.kind === "file" ? "file" : "media",
    url: item.url,
    status: item.status ?? null,
    mimeType: item.mimeType ?? null,
    duration: null,
    live: null,
    encryption: null,
    segmentCount: null,
    variants: [],
    tracks: [],
    requestId: item.requestId ?? null,
    referer: null,
    userAgent: null,
    evidence: ["network-capture"],
  };
  if (item.kind === "file") return stream;

  let detail = {};
  try {
    detail = await bridge.networkDetail(item.requestId);
  } catch (error) {
    notes.push(`Failed to read request detail for ${item.url.slice(0, 80)}: ${error.message}`);
  }

  const headers = detailHeaders(detail);
  stream.referer = headers.referer || null;
  stream.userAgent = headers["user-agent"] || null;

  let text = detailText(detail);
  if (text === null) {
    try {
      text = await httpGetText(item.url, headers);
      stream.evidence.push("body-from-http");
    } catch (error) {
      notes.push(`Failed to read manifest body for ${item.url.slice(0, 80)}: ${error.message}`);
      return stream;
    }
  } else {
    stream.evidence.push("body-from-capture");
  }

  const playlist = item.kind === "dash" ? parseMpd(text, item.url) : parseM3u8(text, item.url);
  stream.role = playlist.kind === "master" ? "master" : "media";
  stream.variants = playlist.variants;
  stream.tracks = playlist.tracks;
  stream.duration = playlist.duration;
  stream.live = playlist.live;
  stream.encryption = playlist.encryption;
  stream.segmentCount = playlist.segmentCount;

  const best = bestVariant(stream);
  if (stream.role === "master" && best) {
    try {
      // The master itself carries no duration; the highest rendition does.
      const variantText = await httpGetText(best.url, headers);
      const variantPlaylist = parseM3u8(variantText, best.url);
      stream.duration = variantPlaylist.duration;
      stream.live = variantPlaylist.live;
      stream.encryption = variantPlaylist.encryption || stream.encryption;
      stream.segmentCount = variantPlaylist.segmentCount;
      stream.evidence.push("duration-from-highest-variant");
    } catch (error) {
      notes.push(`Failed to read rendition manifest ${best.url.slice(0, 80)}: ${error.message}`);
    }
  }

  return stream;
}

export function bestVariant(stream) {
  if (!stream.variants?.length) return null;
  return [...stream.variants].sort(
    (a, b) => (b.averageBandwidth || b.bandwidth || 0) - (a.averageBandwidth || a.bandwidth || 0),
  )[0];
}

export function mergeVariants(streams) {
  // A rendition that a master already references should not also appear as its own
  // top-level candidate; that is what turns "a pile of m3u8 URLs" into one choice.
  const referenced = new Set();
  for (const stream of streams) {
    if (stream.role !== "master") continue;
    for (const variant of stream.variants) referenced.add(variant.url);
    for (const track of stream.tracks) if (track.url) referenced.add(track.url);
  }
  return streams.filter((stream) => stream.role === "master" || !referenced.has(stream.url));
}

function rank(stream) {
  const roleOrder = { master: 0, media: 1, file: 2 };
  return [roleOrder[stream.role] ?? 3, -(stream.duration || 0), stream.url];
}

async function observePage(bridge, result) {
  try {
    const parsed = JSON.parse(await bridge.evaluate(PAGE_PROBE_SCRIPT));
    if (!result.pageUrl) result.pageUrl = parsed.url || null;
    if (!result.pageTitle) result.pageTitle = parsed.title || null;
    result.pageVideos = parsed.videos || [];
  } catch (error) {
    result.notes.push(
      "Page script unavailable (the target may live in a cross-origin iframe), so DOM details are missing.",
    );
  }
}

export async function collectWebStreams(bridge, options = {}) {
  const { reload = false, navigateTo = null, waitSeconds = 8, fresh = false } = options;
  const result = {
    session: bridge.session,
    pageUrl: null,
    pageTitle: null,
    capturedRequests: 0,
    captureStarted: false,
    needsUserAction: false,
    pageVideos: [],
    streams: [],
    notes: [],
  };

  const tab = await bridge.currentTab();
  if (tab) {
    result.pageUrl = tab.url || null;
    result.pageTitle = tab.title || null;
  }

  result.captureStarted = await ensureCapture(bridge, fresh);
  if (result.captureStarted) {
    result.notes.push(
      "Capture buffer was empty, so capture was restarted; the page must issue media requests again before they can be seen.",
    );
  }

  // Navigation happens after the capture is running, which is the only order that
  // lets the media requests of that page load show up in the buffer.
  if (navigateTo) {
    try {
      await bridge.navigate(navigateTo);
      result.pageUrl = navigateTo;
      result.notes.push(`Navigated to ${navigateTo} to trigger media requests.`);
    } catch (error) {
      result.notes.push(`Failed to navigate to ${navigateTo}: ${error.message}`);
    }
  } else if (reload && result.pageUrl) {
    try {
      await bridge.navigate(result.pageUrl);
      result.notes.push("Reloaded the page to trigger media requests again.");
    } catch (error) {
      result.notes.push(`Failed to reload the page: ${error.message}`);
    }
  }

  await sleep(Math.max(waitSeconds, 0) * 1000);

  const listing = await bridge.networkList();
  const requests = listing.requests || [];
  result.capturedRequests = requests.length;

  const streams = [];
  for (const item of selectRequests(requests)) {
    streams.push(await buildStream(bridge, item, result.notes));
  }

  const merged = mergeVariants(streams).sort((a, b) => {
    const left = rank(a);
    const right = rank(b);
    for (let i = 0; i < left.length; i += 1) {
      if (left[i] < right[i]) return -1;
      if (left[i] > right[i]) return 1;
    }
    return 0;
  });
  merged.forEach((stream, index) => {
    stream.id = `s${index + 1}`;
  });
  result.streams = merged;

  await observePage(bridge, result);

  if (streams.length === 0) {
    result.needsUserAction = true;
    result.notes.push(
      "No media request was captured. Confirm the page is actually playing; if the player " +
        "needs a click or a login, do that first and probe again without restarting the capture.",
    );
  }

  return result;
}
