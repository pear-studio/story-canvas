function normalizedUrl(value) {
  return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
}

function normalizedHostIdentity(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .split(".")[0]
    .replace(/[^a-z0-9]/g, "");
}

function endpointHostIdentity(value) {
  try {
    return normalizedHostIdentity(new URL(value).hostname);
  } catch {
    return "";
  }
}

export function configuredComfyUiUrls(config = {}) {
  if (!Array.isArray(config.comfyui_urls)) return [];
  return [...new Set(config.comfyui_urls.map(normalizedUrl).filter(Boolean))];
}

export function primaryComfyUiUrl(config = {}) {
  return configuredComfyUiUrls(config)[0] ?? "";
}

export function resolveComfyUiUrls({ sharedUrls = [], localUrls = [], hostName = "" } = {}) {
  const shared = configuredComfyUiUrls({ comfyui_urls: sharedUrls });
  const local = configuredComfyUiUrls({ comfyui_urls: localUrls });
  const self = normalizedHostIdentity(hostName);
  let insertedLocal = false;
  const resolved = [];

  for (const url of shared) {
    if (self && endpointHostIdentity(url) === self) {
      if (!insertedLocal) resolved.push(...local);
      insertedLocal = true;
      continue;
    }
    resolved.push(url);
  }
  if (!insertedLocal) resolved.push(...local);
  return configuredComfyUiUrls({ comfyui_urls: resolved });
}

export function createComfyEndpointSelector({
  urls = [],
  probe,
  clock = Date.now,
} = {}) {
  const endpoints = configuredComfyUiUrls({ comfyui_urls: urls });
  if (typeof probe !== "function") throw new TypeError("ComfyUI endpoint probe is required");
  let currentUrl = endpoints[0] ?? null;
  let states = endpoints.map((url, index) => ({
    status: "checking", url, endpoint_index: index, version: null, checked_at: null,
  }));
  let refreshPromise = null;

  function snapshot() {
    const selected = states.find((item) => item.url === currentUrl) ?? null;
    return {
      status: selected?.status ?? "unavailable",
      reason: endpoints.length ? selected?.status === "unavailable" ? "endpoint_unavailable" : null : "not_configured",
      url: currentUrl,
      endpoint_index: selected?.endpoint_index ?? null,
      endpoint_count: endpoints.length,
      version: selected?.version ?? null,
      checked_at: selected?.checked_at ?? null,
    };
  }

  function refresh() {
    if (refreshPromise) return refreshPromise;
    states = states.map((item) => ({ ...item, status: "checking" }));
    refreshPromise = (async () => {
      const checkedAt = new Date(clock()).toISOString();
      states = await Promise.all(endpoints.map(async (url, index) => {
        try {
          const value = await probe(url);
          return { status: "available", url, endpoint_index: index, version: typeof value?.version === "string" ? value.version : null, checked_at: checkedAt };
        } catch {
          return { status: "unavailable", url, endpoint_index: index, version: null, checked_at: checkedAt };
        }
      }));
      if (!states.some((item) => item.url === currentUrl && item.status === "available")) {
        currentUrl = states.find((item) => item.status === "available")?.url ?? currentUrl ?? endpoints[0] ?? null;
      }
      return snapshot();
    })().finally(() => { refreshPromise = null; });
    return refreshPromise;
  }

  return {
    urls: () => [...endpoints],
    currentUrl: () => currentUrl ?? "",
    status: snapshot,
    endpoints: () => states.map((item) => ({ ...item })),
    refresh,
    select(url) {
      const endpoint = states.find((item) => item.url === normalizedUrl(url));
      if (!endpoint) return { selected: false, reason: "not_found" };
      if (endpoint.status !== "available") return { selected: false, reason: "unavailable" };
      currentUrl = endpoint.url;
      return { selected: true, endpoint: snapshot() };
    },
  };
}
