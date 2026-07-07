(() => {
  // src/background.js
  var TRANSLATION_TIMEOUT_MS = 45e3;
  var STATS_KEY = "xatStats";
  var CACHE_KEY = "xatTranslationCache";
  var MAX_CACHE_ENTRIES = 500;
  var TRANSLATION_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
  var SKIP_CACHE_TTL_MS = 6 * 60 * 60 * 1e3;
  var TRANSLATION_ENDPOINT = "https://api.x.com/2/grok/translation.json";
  var X_WEB_BEARER_TOKEN = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
  var STAT_COUNTERS = {
    expanded: "expanded",
    "translation-requested": "requested",
    "translation-rendered": "translated",
    "translation-failed": "failed",
    "translation-skipped": "skipped",
    "longform-unsupported": "skipped",
    "processing-error": "failed",
    "background-translation-failed": "failed",
    "background-translation-skipped": "skipped"
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
  function withTimeout(promise, timeoutMs, errorMessage) {
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
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
        updatedAt: Number(entry.updatedAt || 0)
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
      "x-twitter-client-language": "zh-cn"
    };
  }
  function createBackgroundController(chromeApi, options = {}) {
    const translationTimeoutMs = options.translationTimeoutMs ?? TRANSLATION_TIMEOUT_MS;
    const translationCacheTtlMs = options.translationCacheTtlMs ?? TRANSLATION_CACHE_TTL_MS;
    const skipCacheTtlMs = options.skipCacheTtlMs ?? SKIP_CACHE_TTL_MS;
    const now = options.now || (() => Date.now());
    const fetchApi = options.fetch || globalThis.fetch?.bind(globalThis);
    const transactionIdFactory = options.transactionIdFactory || generateClientTransactionId;
    const inFlight = /* @__PURE__ */ new Map();
    const cache = /* @__PURE__ */ new Map();
    const skipCache = /* @__PURE__ */ new Map();
    async function getPersistentCache() {
      if (!chromeApi.storage?.local) {
        return { translations: {}, skipped: {} };
      }
      const current = await chromeApi.storage.local.get(CACHE_KEY);
      const stored = current?.[CACHE_KEY] || {};
      return {
        translations: stored.translations || {},
        skipped: stored.skipped || {}
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
          updatedAt: (/* @__PURE__ */ new Date()).toISOString()
        }
      });
    }
    async function requestTranslationFromApi({ id, csrfToken, dstLang = "zh" }) {
      if (!csrfToken) {
        return { ok: false, error: "missing-csrf-token" };
      }
      if (!fetchApi) {
        return { ok: false, error: "translation-fetch-unavailable" };
      }
      const response = await fetchApi(TRANSLATION_ENDPOINT, {
        method: "POST",
        credentials: "include",
        headers: createTranslationHeaders(csrfToken, transactionIdFactory()),
        body: JSON.stringify({
          content_type: "POST",
          id,
          dst_lang: dstLang || "zh"
        })
      });
      if (!response?.ok) {
        return { ok: false, error: `translation-http-${response?.status || 0}` };
      }
      const payload = await response.json();
      const translation = normalizeTranslationText(payload?.result?.text);
      if (!translation) {
        return { ok: false, skipped: true, error: "empty-translation" };
      }
      return { ok: true, translation };
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
        try {
          const result = await withTimeout(
            requestTranslationFromApi({ id, csrfToken, dstLang }),
            translationTimeoutMs,
            "translation-request-timeout"
          );
          if (result?.ok && result.translation) {
            cache.set(id, { value: result.translation, updatedAt: now() });
            await writeCachedResult(id, result);
          } else if (result?.skipped) {
            skipCache.set(id, { value: result?.error || "translation-skipped", updatedAt: now() });
            await writeCachedResult(id, result);
            await recordDiagnostic({
              event: "background-translation-skipped",
              id
            });
          } else {
            await recordDiagnostic({
              event: "background-translation-failed",
              id,
              error: result?.error || "empty-result"
            });
          }
          return result;
        } catch (error) {
          await recordDiagnostic({
            event: "background-translation-failed",
            id,
            error: error?.message || "translation-failed"
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
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
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
        translateTweet(message.payload).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error?.message || "translation-failed" }));
        return true;
      });
    }
    return {
      recordDiagnostic,
      registerMessageListener,
      translateTweet
    };
  }
  if (typeof chrome !== "undefined" && chrome?.runtime?.onMessage) {
    createBackgroundController(chrome).registerMessageListener();
  }
})();
