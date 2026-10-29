function joinUrl(baseUrl, pathname) {
  return `${String(baseUrl).replace(/\/+$/, "")}${pathname}`;
}

function extractTextParts(parts = []) {
  return parts
    .map((part) => part?.text)
    .filter((value) => typeof value === "string" && value.trim() !== "")
    .join("\n\n")
    .trim();
}

// The official Gemini API rejects Bearer keys and expects x-goog-api-key; relay gateways use Bearer.
function buildAuthHeaders(baseUrl, apiKey) {
  const host = new URL(baseUrl).hostname.toLowerCase();
  return host === "generativelanguage.googleapis.com"
    ? { "x-goog-api-key": apiKey }
    : { Authorization: `Bearer ${apiKey}` };
}

// A media part is either inline base64 ({ mimeType, data }) or a remote URI ({ mimeType, fileUri }).
function toRequestPart(part) {
  return part.data
    ? { inline_data: { mime_type: part.mimeType, data: part.data } }
    : { file_data: { mime_type: part.mimeType, file_uri: part.fileUri } };
}

export async function generateVideoUnderstanding({
  apiKey,
  baseUrl,
  model,
  prompt,
  mediaParts,
  timeoutMs,
}) {
  const url = joinUrl(baseUrl, `/v1beta/models/${encodeURIComponent(model)}:generateContent`);
  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }, ...mediaParts.map(toRequestPart)],
      },
    ],
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...buildAuthHeaders(baseUrl, apiKey),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const rawText = await response.text();
  let payload;
  try {
    payload = JSON.parse(rawText);
  } catch (error) {
    const parseError = new Error(
      `Provider returned non-JSON response (${response.status}): ${rawText.slice(0, 600)}`,
    );
    parseError.status = response.status;
    parseError.rawText = rawText;
    throw parseError;
  }

  if (!response.ok) {
    const message = payload?.error?.message || rawText.slice(0, 600);
    const requestError = new Error(`Provider request failed (${response.status}): ${message}`);
    requestError.status = response.status;
    requestError.payload = payload;
    throw requestError;
  }

  const text = extractTextParts(payload?.candidates?.[0]?.content?.parts);
  return {
    text,
    raw: payload,
  };
}
