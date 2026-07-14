// 本文件负责扩展后台消息处理、翻译请求路由、缓存和第三方翻译服务配置管理。
// 普通帖子默认优先使用 X 自带接口，只有可兜底失败时才交给第三方 provider。
import { createTranslationPipeline } from "./translationPipeline.js";
import { createTencentTranslationProvider } from "./providers/tencentTranslationProvider.js";

const TRANSLATION_TIMEOUT_MS = 45000;
const STATS_KEY = "xatStats";
const CACHE_KEY = "xatTranslationCache";
const PROVIDER_SETTINGS_KEY = "xatProviderSettings";
const DEFAULT_TENCENT_REGION = "ap-guangzhou";
const MAX_CACHE_ENTRIES = 500;
const TRANSLATION_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SKIP_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const TRANSLATION_RETRY_ATTEMPTS = 3;
const TRANSLATION_RETRY_DELAY_MS = 700;
const TRANSLATION_ENDPOINT = "https://api.x.com/2/grok/translation.json";
const X_WEB_BEARER_TOKEN = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
const LONGFORM_CONTENT_TYPE = "longform";
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
      ...(entry.provider ? { provider: entry.provider } : {}),
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

function shouldFallbackFromX(result) {
  if (!result || result.ok || result.skipped) {
    return false;
  }

  return [
    "translation-fetch-failed",
    "translation-json-parse-failed",
    "translation-json-read-failed",
  ].includes(result.error) || /^translation-http-(408|425|429|5\d\d)$/.test(result.error || "");
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
  const tencentProviderFactory = options.tencentProviderFactory || createTencentTranslationProvider;
  const inFlight = new Map();
  const cache = new Map();
  const skipCache = new Map();
  const configuredTranslationPipeline = options.translationProviders
    ? createTranslationPipeline(options.translationProviders)
    : null;

  async function getProviderSettings() {
    if (!chromeApi.storage?.local) {
      return {};
    }

    const stored = await chromeApi.storage.local.get(PROVIDER_SETTINGS_KEY);
    return stored?.[PROVIDER_SETTINGS_KEY] || {};
  }

  async function getTencentConfigStatus() {
    const config = (await getProviderSettings()).tencent;
    return {
      ok: true,
      configured: Boolean(config?.secretId && config?.secretKey),
      region: config?.region || DEFAULT_TENCENT_REGION,
    };
  }

  async function saveTencentConfig(payload = {}) {
    const secretId = typeof payload.secretId === "string" ? payload.secretId.trim() : "";
    const secretKey = typeof payload.secretKey === "string" ? payload.secretKey.trim() : "";
    const region = typeof payload.region === "string" && payload.region.trim()
      ? payload.region.trim()
      : DEFAULT_TENCENT_REGION;

    if (!secretId || !secretKey) {
      return { ok: false, error: "tencent-credentials-required" };
    }

    const settings = await getProviderSettings();
    await chromeApi.storage.local.set({
      [PROVIDER_SETTINGS_KEY]: {
        ...settings,
        tencent: {
          secretId,
          secretKey,
          region,
          updatedAt: new Date(now()).toISOString(),
        },
      },
    });

    return { ok: true, configured: true, region };
  }

  async function deleteTencentConfig() {
    const settings = await getProviderSettings();
    const { tencent: _tencent, ...remainingSettings } = settings;
    await chromeApi.storage.local.set({ [PROVIDER_SETTINGS_KEY]: remainingSettings });
    return { ok: true, configured: false, region: DEFAULT_TENCENT_REGION };
  }

  async function testTencentConfig() {
    const config = (await getProviderSettings()).tencent;
    if (!config?.secretId || !config?.secretKey) {
      return { ok: false, error: "tencent-credentials-missing", category: "auth_failed" };
    }

    const provider = tencentProviderFactory({
      ...config,
      fetch: fetchApi,
      crypto: options.crypto || globalThis.crypto,
      now,
    });
    const result = await provider.translate({
      text: "Hello, Tencent Cloud.",
      sourceLanguage: "en",
      targetLanguage: "zh",
    });

    if (result?.ok) {
      return {
        ok: true,
        translation: result.translation,
        provider: "tencent",
      };
    }

    return {
      ok: false,
      error: result?.error || "tencent-test-failed",
      ...(result?.category ? { category: result.category } : {}),
      ...(result?.providerCode ? { providerCode: result.providerCode } : {}),
    };
  }

  async function createThirdPartyProviderAdapters() {
    const providers = [];
    const tencentConfig = (await getProviderSettings()).tencent;
    if (tencentConfig?.secretId && tencentConfig?.secretKey) {
      const tencentProvider = tencentProviderFactory({
        ...tencentConfig,
        fetch: fetchApi,
        crypto: options.crypto || globalThis.crypto,
        now,
      });
      providers.push({
        id: tencentProvider.id || "tencent",
        translate(providerRequest) {
          return tencentProvider.translate({
            ...providerRequest,
            sourceLanguage: "auto",
            targetLanguage: providerRequest.dstLang || "zh",
          });
        },
      });
    }

    return providers;
  }

  async function translateWithProviders(request) {
    if (configuredTranslationPipeline) {
      return configuredTranslationPipeline.translate(request);
    }

    // X provider 只在可重试/限流/服务异常时声明 fallback，避免业务性失败误走第三方。
    const providers = [{
      id: "x",
      async translate(providerRequest) {
        const result = await requestTranslationFromApi(providerRequest);
        const normalizedResult = result?.ok ? { ...result, provider: "x" } : result;
        return shouldFallbackFromX(normalizedResult)
          ? { ...normalizedResult, fallback: true }
          : normalizedResult;
      },
    }, ...(await createThirdPartyProviderAdapters())];

    return createTranslationPipeline(providers).translate(request);
  }

  async function translateWithThirdPartyProviders(request) {
    if (configuredTranslationPipeline) {
      return configuredTranslationPipeline.translate(request);
    }

    const providers = await createThirdPartyProviderAdapters();
    if (providers.length === 0) {
      return { ok: false, error: "third-party-provider-unavailable" };
    }

    return createTranslationPipeline(providers).translate(request);
  }

  async function translateByContentType(request) {
    // 长文正文不是 X 自带帖子译文接口的稳定能力，直接交给第三方 provider 管线处理。
    if (request?.contentType === LONGFORM_CONTENT_TYPE) {
      return translateWithThirdPartyProviders(request);
    }

    return translateWithProviders(request);
  }

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
      return {
        ok: true,
        translation: memoryTranslation.value,
        ...(memoryTranslation.provider ? { provider: memoryTranslation.provider } : {}),
        cached: true,
      };
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
      return {
        ok: true,
        translation: translationEntry.value,
        ...(translationEntry.provider ? { provider: translationEntry.provider } : {}),
        cached: true,
      };
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
      translations[id] = {
        value: result.translation,
        updatedAt: now(),
        ...(result.provider ? { provider: result.provider } : {}),
      };
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

  async function translateTweet({ id, url, csrfToken, dstLang = "zh", text = "", contentType = "" } = {}) {
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
          translateByContentType({ id, csrfToken, dstLang, text, contentType, signal: abortController?.signal }),
          translationTimeoutMs,
          "translation-request-timeout",
          () => abortController?.abort(),
        );
        if (result?.ok && result.translation) {
          cache.set(id, {
            value: result.translation,
            updatedAt: now(),
            ...(result.provider ? { provider: result.provider } : {}),
          });
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
    chromeApi.storage?.local?.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" })
      .catch((error) => console.warn("Unable to restrict extension storage access", error));

    chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.type === "XAT_DIAGNOSTIC_EVENT") {
        recordDiagnostic(message.payload).then(() => sendResponse({ ok: true }));
        return true;
      }

      const tencentConfigHandlers = {
        XAT_TENCENT_CONFIG_STATUS: getTencentConfigStatus,
        XAT_TENCENT_CONFIG_SAVE: () => saveTencentConfig(message.payload),
        XAT_TENCENT_CONFIG_DELETE: deleteTencentConfig,
        XAT_TENCENT_CONFIG_TEST: testTencentConfig,
      };
      const tencentConfigHandler = tencentConfigHandlers[message?.type];
      if (tencentConfigHandler) {
        if (sender?.tab) {
          sendResponse({ ok: false, error: "untrusted-config-sender" });
          return false;
        }

        tencentConfigHandler()
          .then(sendResponse)
          .catch((error) => sendResponse({ ok: false, error: error?.message || "tencent-config-failed" }));
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
    deleteTencentConfig,
    getTencentConfigStatus,
    recordDiagnostic,
    registerMessageListener,
    saveTencentConfig,
    testTencentConfig,
    translateTweet,
  };
}

if (typeof chrome !== "undefined" && chrome?.runtime?.onMessage) {
  createBackgroundController(chrome).registerMessageListener();
}
