// Client for the Kimi Browser Extension daemon.
//
// This tool never launches a browser: the daemon drives the user's real Chrome,
// and we only read the current tab's network activity and evaluate page scripts
// through its local HTTP endpoint.

const DEFAULT_ENDPOINT = "http://127.0.0.1:10086/command";

export class BridgeUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "BridgeUnavailableError";
  }
}

export class BridgeCallError extends Error {
  constructor(message) {
    super(message);
    this.name = "BridgeCallError";
  }
}

export function createBridge(session, options = {}) {
  const endpoint = options.endpoint || DEFAULT_ENDPOINT;
  const timeoutMs = options.timeoutMs || 120000;

  async function call(action, args = {}) {
    const body = JSON.stringify({ action, args, session });
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new BridgeUnavailableError(
        `Cannot reach the browser extension daemon at ${endpoint}: ${error.message}. ` +
          "Make sure the Kimi Browser Extension daemon is running.",
      );
    }

    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new BridgeCallError(`Daemon returned a non-JSON response: ${text.slice(0, 200)}`);
    }

    if (!parsed.ok) {
      throw new BridgeCallError(
        parsed.error?.message || JSON.stringify(parsed.error) || "unknown daemon error",
      );
    }
    return parsed.data || {};
  }

  return {
    session,
    call,
    async listTabs() {
      return (await call("list_tabs")).tabs || [];
    },
    async currentTab() {
      const tabs = (await call("list_tabs")).tabs || [];
      return tabs.find((tab) => tab.active) || tabs[tabs.length - 1] || null;
    },
    async navigate(url, { newTab = false, groupTitle = null } = {}) {
      const args = { url };
      if (newTab) args.newTab = true;
      if (groupTitle) args.group_title = groupTitle;
      return call("navigate", args);
    },
    async evaluate(code) {
      return (await call("evaluate", { code })).value;
    },
    async networkList(filter) {
      return call("network", filter ? { cmd: "list", filter } : { cmd: "list" });
    },
    async networkStart() {
      return call("network", { cmd: "start" });
    },
    async networkDetail(requestId) {
      return call("network", { cmd: "detail", requestId });
    },
  };
}

export const PAGE_PROBE_SCRIPT = `(() => {
  const videos = Array.from(document.querySelectorAll("video"));
  return JSON.stringify({
    title: document.title,
    url: location.href,
    videos: videos.map((video) => ({
      src: video.getAttribute("src"),
      currentSrc: video.currentSrc || null,
      duration: Number.isFinite(video.duration) ? video.duration : null,
      width: video.videoWidth || null,
      height: video.videoHeight || null,
      paused: video.paused,
      readyState: video.readyState,
      hasMediaKeys: Boolean(video.mediaKeys),
    })),
  });
})()`;
