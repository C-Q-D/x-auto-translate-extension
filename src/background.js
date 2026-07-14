import { createTranslationPipeline } from "./translationPipeline.js";

const TRANSLATION_TIMEOUT_MS = 45000;
const STATS_KEY = "xatStats";
const CACHE_KEY = "xatTranslationCache";
const MAX_CACHE_ENTRIES = 500;
const TRANSLATION_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SKIP_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const TRANSLATION_RETRY_ATTEMPTS = 3;
const TRANSLATION_RETRY_DELAY_MS = 700;
const TRANSLATION_ENDPOINT = "https://api.x.com/2/grok/translation.json";
const X_WEB_BEARER_TOKEN = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
const STAT_COUNTERS = {
  expanded: "expanded",
  "translation-requested": "requested",
  "translation-rendered": "translated",
  "translation-failed": "failed",
  "translation-skipped": "skipped",
  "longform-unsupported": "skipped",
  "processing-error": "failed",
  "background-translation-failed": "failed",
  "background-translation-skipped": "skipped",
};

function getStatusIdFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "x.com" && parsed.hostname !== "twitter.com") {
      return "";
    }
    return parsed.pathname.match(/\/[^/]+\/status\/(\d+)/)?.[1] || "";
  } catch {
    return "";
  }
}

function withTimeout(promise, timeoutMs, errorMessage, onTimeout) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      onTimeout?.();
      reject(new Error(errorMessage));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout])
    .finally(() => clearTimeout(timeoutId));
}

function pruneEntries(record, maxEntries = MAX_CACHE_ENTRIES) {
  const entries = Object.entries(record || {});
  if (entries.length <= maxEntries) {
    return Object.fromEntries(entries);
  }

  return Object.fromEntries(entries.slice(entries.length - maxEntries));
}

function normalizeCacheEntry(entry) {
  if (!entry) {
    return null;
  }

  if (typeof entry === "string") {
    return { value: entry, updatedAt: 0 };
  }

  if (typeof entry === "object" && typeof entry.value === "string") {
    return {
      value: entry.value,
      updatedAt: Number(entry.updatedAt || 0),
    };
  }

  return null;
}

function isFreshCacheEntry(entry, ttlMs, nowMs) {
  return entry && (entry.updatedAt === 0 || nowMs - entry.updatedAt <= ttlMs);
}

function normalizeTranslationText(text) {
  return typeof text === "string" ? text.trim() : "";
}

function createAbortController() {
  return typeof AbortController === "function" ? new AbortController() : null;
}

function isRetryableHttpStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function removeInternalRetryFields(result) {
  if (!result || typeof result !== "object") {
    return result;
  }

  const { retryable, ...publicResult } = result;
  return publicResult;
}

async function readJsonPayload(response) {
  if (typeof response?.text === "function") {
    const body = await response.text();
    try {
      return { payload: JSON.parse(body) };
    } catch {
      return { error: "translation-json-parse-failed", retryable: true };
    }
  }

  try {
    return { payload: await response.json() };
  } catch (error) {
    return {
      error: error instanceof SyntaxError ? "translation-json-parse-failed" : (error?.message || "translation-json-read-failed"),
      retryable: true,
    };
  }
}

function encodeBase64Bytes(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  if (typeof btoa === "function") {
    return btoa(binary);
  }

  return globalThis.Buffer?.from(binary, "binary").toString("base64") || "";
}

function generateClientTransactionId() {
  const bytes = new Uint8Array(64);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return encodeBase64Bytes(bytes);
}

function createTranslationHeaders(csrfToken, transactionId) {
  return {
    authorization: `Bearer ${X_WEB_BEARER_TOKEN}`,
    "content-type": "text/plain;charset=UTF-8",
    "x-client-transaction-id": transactionId,
    "x-csrf-token": csrfToken,
    "x-twitter-active-user": "yes",
    "x-twitter-auth-type": "OAuth2Session",
    "x-twitter-client-language": "zh-cn",
  };
}

export function createBackgroundController(chromeApi, options = {}) {
  const translationTimeoutMs = options.translationTimeoutMs ?? TRANSLATION_TIMEOUT_MS;
  const translationCacheTtlMs = options.translationCacheTtlMs ?? TRANSLATION_CACHE_TTL_MS;
  const skipCacheTtlMs = options.skipCacheTtlMs ?? SKIP_CACHE_TTL_MS;
  const translationRetryAttempts = Math.max(1, Number(options.translationRetryAttempts ?? TRANSLATION_RETRY_ATTEMPTS));
  const translationRetryDelayMs = Math.max(0, Number(options.translationRetryDelayMs ?? TRANSLATION_RETRY_DELAY_MS));
  const now = options.now || (() => Date.now());
  const wait = options.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const fetchApi = options.fetch || globalThis.fetch?.bind(globalThis);
  const transactionIdFactory = options.transactionIdFactory || generateClientTransactionId;
  const inFlight = new Map();
  const cache = new Map();
  const skipCache = new Map();
  const translationPipeline = createTranslationPipeline(options.translationProviders || [
    {
      id: "x",
      translate: requestTranslationFromApi,
    },
  ]);

  async function waitForRetryDelay(ms, signal) {
    if (signal?.aborted) {
      return false;
    }

    if (!signal?.addEventListener) {
      await wait(ms);
      return !signal?.aborted;
    }

    let abortListener;
    const retryDelay = wait(ms).then(() => true, () => true);
    const aborted = new Promise((resolve) => {
      abortListener = () => resolve(false);
      signal.addEventListener("abort", abortListener, { once: true });
    });
    const shouldContinue = await Promise.race([retryDelay, aborted]);
    signal.removeEventListener("abort", abortListener);
    return shouldContinue && !signal.aborted;
  }

  async function getPersistentCache() {
    if (!chromeApi.storage?.local) {
      return { translations: {}, skipped: {} };
    }

    const current = await chromeApi.storage.local.get(CACHE_KEY);
    const stored = current?.[CACHE_KEY] || {};
    return {
      translations: stored.translations || {},
      skipped: stored.skipped || {},
    };
  }

  async function readCachedResult(id) {
    const memoryTranslation = cache.get(id);
    if (isFreshCacheEntry(memoryTranslation, translationCacheTtlMs, now())) {
      return { ok: true, translation: memoryTranslation.value, cached: true };
    }
    if (memoryTranslation) {
      cache.delete(id);
    }

    const memorySkipped = skipCache.get(id);
    if (isFreshCacheEntry(memorySkipped, skipCacheTtlMs, now())) {
      return { ok: false, skipped: true, error: memorySkipped.value, cached: true };
    }
    if (memorySkipped) {
      skipCache.delete(id);
    }

    const persistent = await getPersistentCache();
    const translationEntry = normalizeCacheEntry(persistent.translations[id]);
    if (isFreshCacheEntry(translationEntry, translationCacheTtlMs, now())) {
      cache.set(id, translationEntry);
      return { ok: true, translation: translationEntry.value, cached: true };
    }

    const skippedEntry = normalizeCacheEntry(persistent.skipped[id]);
    if (isFreshCacheEntry(skippedEntry, skipCacheTtlMs, now())) {
      skipCache.set(id, skippedEntry);
      return { ok: false, skipped: true, error: skippedEntry.value, cached: true };
    }

    return null;
  }

  async function writeCachedResult(id, result) {
    if (!chromeApi.storage?.local || !id || !result) {
      return;
    }

    const persistent = await getPersistentCache();
    const translations = { ...persistent.translations };
    const skipped = { ...persistent.skipped };

    if (result.ok && result.translation) {
      translations[id] = { value: result.translation, updatedAt: now() };
      delete skipped[id];
    } else if (result.skipped) {
      skipped[id] = { value: result.error || "translation-skipped", updatedAt: now() };
      delete translations[id];
    } else {
      return;
    }

    await chromeApi.storage.local.set({
      [CACHE_KEY]: {
        translations: pruneEntries(translations),
        skipped: pruneEntries(skipped),
        updatedAt: new Date().toISOString(),
      },
    });
  }

  async function requestTranslationAttempt({ id, csrfToken, dstLang = "zh", signal }) {
    if (signal?.aborted) {
      return { ok: false, error: "translation-request-timeout" };
    }

    const response = await fetchApi(TRANSLATION_ENDPOINT, {
      method: "POST",
      credentials: "include",
      signal,
      headers: createTranslationHeaders(csrfToken, transactionIdFactory()),
      body: JSON.stringify({
        content_type: "POST",
        id,
        dst_lang: dstLang || "zh",
      }),
    });

    if (!response?.ok) {
      const status = response?.status || 0;
      return { ok: false, error: `translation-http-${status}`, retryable: isRetryableHttpStatus(status) };
    }

    const { payload, error, retryable } = await readJsonPayload(response);
    if (error) {
      return { ok: false, error, retryable };
    }

    const translation = normalizeTranslationText(payload?.result?.text);
    if (!translation) {
      return { ok: false, skipped: true, error: "empty-translation" };
    }

    return { ok: true, translation };
  }

  async function requestTranslationFromApi({ id, csrfToken, dstLang = "zh", signal }) {
    if (!csrfToken) {
      return { ok: false, error: "missing-csrf-token" };
    }

    if (!fetchApi) {
      return { ok: false, error: "translation-fetch-unavailable" };
    }

    let lastResult = null;
    for (let attempt = 1; attempt <= translationRetryAttempts; attempt += 1) {
      if (signal?.aborted) {
        return { ok: false, error: "translation-request-timeout" };
      }

      try {
        const result = await requestTranslationAttempt({ id, csrfToken, dstLang, signal });
        if (!result?.retryable) {
          return removeInternalRetryFields(result);
        }
        lastResult = result;
      } catch (error) {
        if (signal?.aborted || error?.name === "AbortError") {
          return { ok: false, error: "translation-request-timeout" };
        }
        lastResult = { ok: false, error: "translation-fetch-failed", retryable: true };
      }

      if (attempt < translationRetryAttempts) {
        const shouldContinue = await waitForRetryDelay(translationRetryDelayMs * attempt, signal);
        if (!shouldContinue) {
          return { ok: false, error: "translation-request-timeout" };
        }
      }
    }

    return removeInternalRetryFields(lastResult || { ok: false, error: "translation-failed" });
  }

  async function translateTweet({ id, url, csrfToken, dstLang = "zh" } = {}) {
    const urlStatusId = getStatusIdFromUrl(url);
    if (!id || !urlStatusId || urlStatusId !== id) {
      return { ok: false, error: "invalid-tweet-metadata" };
    }

    const cached = await readCachedResult(id);
    if (cached) {
      return cached;
    }

    if (inFlight.has(id)) {
      return inFlight.get(id);
    }

    const promise = (async () => {
      const abortController = createAbortController();
      try {
        const result = await withTimeout(
          translationPipeline.translate({ id, csrfToken, dstLang, signal: abortController?.signal }),
          translationTimeoutMs,
          "translation-request-timeout",
          () => abortController?.abort(),
        );
        if (result?.ok && result.translation) {
          cache.set(id, { value: result.translation, updatedAt: now() });
          await writeCachedResult(id, result);
        } else if (result?.skipped) {
          skipCache.set(id, { value: result?.error || "translation-skipped", updatedAt: now() });
          await writeCachedResult(id, result);
          await recordDiagnostic({
            event: "background-translation-skipped",
            id,
          });
        } else {
          await recordDiagnostic({
            event: "background-translation-failed",
            id,
            error: result?.error || "empty-result",
          });
        }
        return result;
      } catch (error) {
        await recordDiagnostic({
          event: "background-translation-failed",
          id,
          error: error?.message || "translation-failed",
        });
        return { ok: false, error: error?.message || "translation-failed" };
      } finally {
        inFlight.delete(id);
      }
    })();

    inFlight.set(id, promise);
    return promise;
  }

  async function recordDiagnostic(payload = {}) {
    if (!chromeApi.storage?.local) {
      return;
    }

    const event = payload.event || "unknown";
    const counter = STAT_COUNTERS[event];
    const current = await chromeApi.storage.local.get(STATS_KEY);
    const stats = current?.[STATS_KEY] || {};
    const next = {
      expanded: 0,
      requested: 0,
      translated: 0,
      failed: 0,
      skipped: 0,
      ...stats,
      extensionVersion: payload.extensionVersion || stats.extensionVersion || "",
      lastEvent: event,
      lastTweetId: payload.id || stats.lastTweetId || "",
      lastError: payload.error || "",
      updatedAt: new Date().toISOString(),
    };

    if (counter) {
      next[counter] = (Number(next[counter]) || 0) + 1;
    }

    await chromeApi.storage.local.set({ [STATS_KEY]: next });
  }

  function registerMessageListener() {
    chromeApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === "XAT_DIAGNOSTIC_EVENT") {
        recordDiagnostic(message.payload).then(() => sendResponse({ ok: true }));
        return true;
      }

      if (message?.type !== "XAT_TRANSLATE_TWEET") {
        return false;
      }

      translateTweet(message.payload)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error?.message || "translation-failed" }));

      return true;
    });
  }

  return {
    recordDiagnostic,
    registerMessageListener,
    translateTweet,
  };
}

if (typeof chrome !== "undefined" && chrome?.runtime?.onMessage) {
  createBackgroundController(chrome).registerMessageListener();
}
