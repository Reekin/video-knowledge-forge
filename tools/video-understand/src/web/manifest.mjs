// Playlist parsing: turn a captured manifest body into selectable renditions,
// side tracks, duration, encryption state, and live/VOD status.

const ATTRIBUTE = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;

function parseAttributes(line) {
  const body = line.includes(":") ? line.slice(line.indexOf(":") + 1) : "";
  const attributes = {};
  for (const match of body.matchAll(ATTRIBUTE)) {
    let value = match[2];
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    attributes[match[1]] = value;
  }
  return attributes;
}

function toInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function resolve(baseUrl, uri) {
  try {
    return new URL(uri, baseUrl).toString();
  } catch (error) {
    return uri;
  }
}

function encryptionFromMethod(method) {
  if (!method) return null;
  const normalized = String(method).trim().toUpperCase();
  if (normalized === "NONE") return "none";
  if (normalized === "AES-128") return "aes-128";
  if (normalized.startsWith("SAMPLE-AES")) return "sample-aes";
  return normalized.toLowerCase();
}

export function parseM3u8(text, baseUrl) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const variants = [];
  const tracks = [];
  let duration = 0;
  let segmentCount = 0;
  let hasEndList = false;
  let encryption = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (line.startsWith("#EXT-X-STREAM-INF")) {
      const attributes = parseAttributes(line);
      let uri = "";
      let lookahead = index + 1;
      while (lookahead < lines.length) {
        if (!lines[lookahead].startsWith("#")) {
          uri = lines[lookahead];
          break;
        }
        lookahead += 1;
      }
      if (uri) {
        variants.push({
          url: resolve(baseUrl, uri),
          resolution: attributes.RESOLUTION || null,
          bandwidth: toInt(attributes.BANDWIDTH),
          averageBandwidth: toInt(attributes["AVERAGE-BANDWIDTH"]),
          codecs: attributes.CODECS || null,
          frameRate: attributes["FRAME-RATE"] || null,
        });
        index = lookahead;
      }
      continue;
    }

    if (line.startsWith("#EXT-X-MEDIA")) {
      const attributes = parseAttributes(line);
      const mediaType = String(attributes.TYPE || "").toLowerCase();
      if (mediaType === "audio" || mediaType === "subtitles" || mediaType === "closed-captions") {
        tracks.push({
          kind: mediaType === "audio" ? "audio" : "subtitles",
          url: attributes.URI ? resolve(baseUrl, attributes.URI) : null,
          groupId: attributes["GROUP-ID"] || null,
          name: attributes.NAME || null,
          language: attributes.LANGUAGE || null,
          default: String(attributes.DEFAULT || "").toUpperCase() === "YES",
        });
      }
      continue;
    }

    if (line.startsWith("#EXT-X-KEY")) {
      encryption = encryptionFromMethod(parseAttributes(line).METHOD) || encryption;
      continue;
    }

    if (line.startsWith("#EXTINF")) {
      const value = Number.parseFloat(line.slice(line.indexOf(":") + 1).split(",")[0]);
      if (!Number.isNaN(value)) {
        duration += value;
        segmentCount += 1;
      }
      continue;
    }

    if (line.startsWith("#EXT-X-ENDLIST")) hasEndList = true;
  }

  if (variants.length > 0) {
    return { kind: "master", variants, tracks, duration: null, live: null, encryption: null, segmentCount: null };
  }

  return {
    kind: "media",
    variants: [],
    tracks,
    duration: segmentCount > 0 ? Number(duration.toFixed(3)) : null,
    live: !hasEndList,
    encryption: encryption || "none",
    segmentCount: segmentCount > 0 ? segmentCount : null,
  };
}

export function parseMpd(text, baseUrl) {
  // Minimal DASH support: list the declared representations. No real target has
  // been verified against this path yet.
  const representations = text.match(/<Representation\b[^>]*>/g) || [];
  const variants = [];
  for (const tag of representations) {
    const attribute = (name) => {
      const match = tag.match(new RegExp(`${name}="([^"]*)"`));
      return match ? match[1] : null;
    };
    const width = attribute("width");
    const height = attribute("height");
    variants.push({
      url: baseUrl,
      resolution: width && height ? `${width}x${height}` : null,
      bandwidth: toInt(attribute("bandwidth")),
      averageBandwidth: null,
      codecs: attribute("codecs"),
      frameRate: attribute("frameRate"),
    });
  }
  if (variants.length === 0) {
    return { kind: "media", variants: [], tracks: [], duration: null, live: null, encryption: null, segmentCount: null };
  }
  return { kind: "master", variants, tracks: [], duration: null, live: null, encryption: null, segmentCount: null };
}
