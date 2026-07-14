import assert from "node:assert/strict";
import test from "node:test";

import { createBackgroundController } from "../src/background.js";

const TWEET_ID = "2071647677591466098";
const METADATA = {
  id: TWEET_ID,
  url: `https://x.com/openai/status/${TWEET_ID}`,
  csrfToken: "csrf-token",
  dstLang: "zh",
  text: "Hello from X",
};

function createChromeMock({ initialStorage = {} } = {}) {
  const calls = [];
  const listeners = [];
  const storage = { ...initialStorage };
  const chrome = {
    runtime: {
      onMessage: {
        addListener(listener) {
          calls.push(["runtime.onMessage.addListener", listener]);
          listeners.push(listener);
        },
      },
    },
    storage: {
      local: {
        async get(key) {
          calls.push(["storage.local.get", key]);
          return { [key]: storage[key] };
        },
        async set(value) {
          calls.push(["storage.local.set", value]);
          Object.assign(storage, value);
        },
        async setAccessLevel(value) {
          calls.push(["storage.local.setAccessLevel", value]);
        },
      },
    },
  };

  return { chrome, calls, listeners, storage };
}

function createFetchResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
    async json() {
      return typeof body === "string" ? JSON.parse(body) : body;
    },
  };
}

function createFetchMock({ responses = [createFetchResponse(200, { result: { text: "你好" } })] } = {}) {
  const calls = [];
  const queuedResponses = [...responses];
  const fetchApi = async (url, options) => {
    calls.push([url, options]);
    const next = queuedResponses.shift() || responses.at(-1);
    if (next instanceof Error) {
      throw next;
    }
    return next;
  };
  return { fetchApi, calls };
}

test("background calls X Grok translation API and returns result text", async () => {
  const { chrome, calls: chromeCalls } = createChromeMock();
  const { fetchApi, calls: fetchCalls } = createFetchMock();
  const controller = createBackgroundController(chrome, {
    fetch: fetchApi,
    transactionIdFactory: () => "transaction-id",
    now: () => 123456,
  });

  const result = await controller.translateTweet(METADATA);

  assert.deepEqual(result, { ok: true, translation: "你好", provider: "x" });
  assert.equal(fetchCalls.length, 1);
  const [url, options] = fetchCalls[0];
  assert.equal(url, "https://api.x.com/2/grok/translation.json");
  assert.equal(options.method, "POST");
  assert.equal(options.credentials, "include");
  assert.deepEqual(JSON.parse(options.body), {
    content_type: "POST",
    id: TWEET_ID,
    dst_lang: "zh",
  });
  assert.equal(options.headers.authorization.startsWith("Bearer "), true);
  assert.equal(options.headers["content-type"], "text/plain;charset=UTF-8");
  assert.equal(options.headers["x-csrf-token"], "csrf-token");
  assert.equal(options.headers["x-client-transaction-id"], "transaction-id");
  assert.equal(options.headers["x-twitter-active-user"], "yes");
  assert.equal(options.headers["x-twitter-auth-type"], "OAuth2Session");
  assert.equal(options.headers["x-twitter-client-language"], "zh-cn");
  assert.equal(chromeCalls.some(([name]) => name === "tabs.create"), false);
});

test("background routes translation through the configured provider pipeline", async () => {
  const { chrome } = createChromeMock();
  const providerCalls = [];
  const controller = createBackgroundController(chrome, {
    translationProviders: [
      {
        id: "test-provider",
        async translate(request) {
          providerCalls.push(request);
          return { ok: true, translation: "Provider 译文" };
        },
      },
    ],
  });

  const result = await controller.translateTweet(METADATA);

  assert.deepEqual(result, { ok: true, translation: "Provider 译文" });
  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].id, TWEET_ID);
  assert.equal(providerCalls[0].csrfToken, "csrf-token");
  assert.equal(providerCalls[0].dstLang, "zh");
  assert.equal(providerCalls[0].signal instanceof AbortSignal, true);
});

test("background rejects metadata when id does not match the status URL", async () => {
  const { chrome } = createChromeMock();
  const { fetchApi, calls: fetchCalls } = createFetchMock();
  const controller = createBackgroundController(chrome, { fetch: fetchApi });

  const result = await controller.translateTweet({
    ...METADATA,
    id: "1111111111111111111",
  });

  assert.deepEqual(result, { ok: false, error: "invalid-tweet-metadata" });
  assert.equal(fetchCalls.length, 0);
});

test("background rejects direct API translation without a csrf token", async () => {
  const { chrome } = createChromeMock();
  const { fetchApi, calls: fetchCalls } = createFetchMock();
  const controller = createBackgroundController(chrome, { fetch: fetchApi });

  const result = await controller.translateTweet({ ...METADATA, csrfToken: "" });

  assert.deepEqual(result, { ok: false, error: "missing-csrf-token" });
  assert.equal(fetchCalls.length, 0);
});

test("background returns failure for non-2xx translation API responses", async () => {
  const { chrome, storage } = createChromeMock({
    initialStorage: {
      xatProviderSettings: {
        tencent: { secretId: "AKIDEXAMPLE", secretKey: "example-secret" },
      },
    },
  });
  const { fetchApi, calls: fetchCalls } = createFetchMock({
    responses: [createFetchResponse(403, { errors: [{ message: "Forbidden" }] })],
  });
  let tencentCalls = 0;
  const controller = createBackgroundController(chrome, {
    fetch: fetchApi,
    tencentProviderFactory() {
      return {
        id: "tencent",
        async translate() {
          tencentCalls += 1;
          return { ok: true, translation: "不应调用", provider: "tencent" };
        },
      };
    },
  });

  const result = await controller.translateTweet(METADATA);

  assert.deepEqual(result, { ok: false, error: "translation-http-403" });
  assert.equal(fetchCalls.length, 1);
  assert.equal(tencentCalls, 0);
  assert.equal(storage.xatStats.failed, 1);
  assert.equal(storage.xatStats.lastEvent, "background-translation-failed");
  assert.equal(storage.xatStats.lastError, "translation-http-403");
});

test("background treats empty result text as skipped and caches it", async () => {
  const { chrome, storage } = createChromeMock();
  const { fetchApi, calls: fetchCalls } = createFetchMock({
    responses: [createFetchResponse(200, { result: { text: "" } })],
  });
  const controller = createBackgroundController(chrome, { fetch: fetchApi, now: () => 789012 });

  const first = await controller.translateTweet(METADATA);
  const second = await controller.translateTweet(METADATA);

  assert.deepEqual(first, { ok: false, skipped: true, error: "empty-translation" });
  assert.deepEqual(second, { ok: false, skipped: true, error: "empty-translation", cached: true });
  assert.equal(fetchCalls.length, 1);
  assert.equal(storage.xatStats.skipped, 1);
  assert.equal(storage.xatTranslationCache.skipped[TWEET_ID].updatedAt, 789012);
});

test("background retries malformed translation JSON before returning a later success", async () => {
  const { chrome, storage } = createChromeMock();
  const { fetchApi, calls: fetchCalls } = createFetchMock({
    responses: [
      createFetchResponse(200, '{"result":{"text":""}}\n<!doctype html>'),
      createFetchResponse(200, { result: { text: "重试后的译文" } }),
    ],
  });
  const controller = createBackgroundController(chrome, {
    fetch: fetchApi,
    now: () => 789012,
    wait: async () => {},
  });

  const result = await controller.translateTweet(METADATA);

  assert.deepEqual(result, { ok: true, translation: "重试后的译文", provider: "x" });
  assert.equal(fetchCalls.length, 2);
  assert.equal(storage.xatTranslationCache.translations[TWEET_ID].value, "重试后的译文");
  assert.equal(storage.xatStats?.failed || 0, 0);
});

test("background normalizes repeated malformed translation JSON failures", async () => {
  const { chrome, storage } = createChromeMock();
  const { fetchApi, calls: fetchCalls } = createFetchMock({
    responses: [createFetchResponse(200, '{"result":{"text":""}}\n<!doctype html>')],
  });
  const controller = createBackgroundController(chrome, {
    fetch: fetchApi,
    translationRetryAttempts: 2,
    wait: async () => {},
  });

  const result = await controller.translateTweet(METADATA);

  assert.deepEqual(result, { ok: false, error: "translation-json-parse-failed" });
  assert.equal(fetchCalls.length, 2);
  assert.equal(storage.xatStats.failed, 1);
  assert.equal(storage.xatStats.lastError, "translation-json-parse-failed");
  assert.equal(storage.xatTranslationCache, undefined);
});

test("background stops retrying after the translation request times out", async () => {
  const { chrome, storage } = createChromeMock();
  const { fetchApi, calls: fetchCalls } = createFetchMock({
    responses: [createFetchResponse(200, '{"result":{"text":""}}\n<!doctype html>')],
  });
  const retryWaits = [];
  const controller = createBackgroundController(chrome, {
    fetch: fetchApi,
    translationRetryAttempts: 3,
    translationRetryDelayMs: 1000,
    translationTimeoutMs: 1,
    wait: () => new Promise((resolve) => retryWaits.push(resolve)),
  });

  const result = await controller.translateTweet(METADATA);
  assert.deepEqual(result, { ok: false, error: "translation-request-timeout" });
  assert.equal(fetchCalls.length, 1);
  assert.equal(storage.xatStats.failed, 1);
  assert.equal(storage.xatStats.lastError, "translation-request-timeout");

  retryWaits[0]();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fetchCalls.length, 1);
});

test("background restores translated cache from storage after controller restart", async () => {
  const { chrome, storage } = createChromeMock();
  const { fetchApi, calls: fetchCalls } = createFetchMock();
  const firstController = createBackgroundController(chrome, { fetch: fetchApi, now: () => 123456 });

  const first = await firstController.translateTweet(METADATA);
  const secondController = createBackgroundController(chrome, { fetch: fetchApi, now: () => 123456 });
  const second = await secondController.translateTweet(METADATA);

  assert.deepEqual(first, { ok: true, translation: "你好", provider: "x" });
  assert.deepEqual(second, { ok: true, translation: "你好", provider: "x", cached: true });
  assert.equal(fetchCalls.length, 1);
  assert.equal(storage.xatTranslationCache.translations[TWEET_ID].updatedAt, 123456);
});

test("background reads legacy string translation cache entries", async () => {
  const { chrome } = createChromeMock({
    initialStorage: {
      xatTranslationCache: {
        translations: {
          [TWEET_ID]: "旧格式译文",
        },
        skipped: {},
      },
    },
  });
  const { fetchApi, calls: fetchCalls } = createFetchMock();
  const controller = createBackgroundController(chrome, { fetch: fetchApi });

  const result = await controller.translateTweet(METADATA);

  assert.deepEqual(result, { ok: true, translation: "旧格式译文", cached: true });
  assert.equal(fetchCalls.length, 0);
});

test("background reads legacy string skipped cache entries", async () => {
  const { chrome } = createChromeMock({
    initialStorage: {
      xatTranslationCache: {
        translations: {},
        skipped: {
          [TWEET_ID]: "empty-translation",
        },
      },
    },
  });
  const { fetchApi, calls: fetchCalls } = createFetchMock();
  const controller = createBackgroundController(chrome, { fetch: fetchApi });

  const result = await controller.translateTweet(METADATA);

  assert.deepEqual(result, { ok: false, skipped: true, error: "empty-translation", cached: true });
  assert.equal(fetchCalls.length, 0);
});

test("background retries expired translation cache entries", async () => {
  const { chrome, storage } = createChromeMock({
    initialStorage: {
      xatTranslationCache: {
        translations: {
          [TWEET_ID]: {
            value: "旧译文",
            updatedAt: 1000,
          },
        },
        skipped: {},
      },
    },
  });
  const { fetchApi, calls: fetchCalls } = createFetchMock({
    responses: [createFetchResponse(200, { result: { text: "新译文" } })],
  });
  const controller = createBackgroundController(chrome, {
    fetch: fetchApi,
    now: () => 1000 + 7 * 24 * 60 * 60 * 1000 + 1,
  });

  const result = await controller.translateTweet(METADATA);

  assert.deepEqual(result, { ok: true, translation: "新译文", provider: "x" });
  assert.equal(fetchCalls.length, 1);
  assert.equal(storage.xatTranslationCache.translations[TWEET_ID].value, "新译文");
});

test("background expires in-memory translation cache entries", async () => {
  let currentTime = 1000;
  const { chrome } = createChromeMock();
  const { fetchApi, calls: fetchCalls } = createFetchMock({
    responses: [
      createFetchResponse(200, { result: { text: "译文A" } }),
      createFetchResponse(200, { result: { text: "译文B" } }),
    ],
  });
  const controller = createBackgroundController(chrome, { fetch: fetchApi, now: () => currentTime });

  const first = await controller.translateTweet(METADATA);
  currentTime += 7 * 24 * 60 * 60 * 1000 + 1;
  const second = await controller.translateTweet(METADATA);

  assert.deepEqual(first, { ok: true, translation: "译文A", provider: "x" });
  assert.deepEqual(second, { ok: true, translation: "译文B", provider: "x" });
  assert.equal(fetchCalls.length, 2);
});

test("background deduplicates in-flight requests by tweet id", async () => {
  const { chrome } = createChromeMock();
  const fetchCalls = [];
  let resolveFetch;
  let resolveFetchStarted;
  const fetchStarted = new Promise((resolve) => {
    resolveFetchStarted = resolve;
  });
  const fetchApi = async (url, options) => {
    fetchCalls.push([url, options]);
    resolveFetchStarted();
    return new Promise((fetchResolve) => {
      resolveFetch = () => fetchResolve(createFetchResponse(200, { result: { text: "同一个译文" } }));
    });
  };
  const controller = createBackgroundController(chrome, { fetch: fetchApi });

  const firstPromise = controller.translateTweet(METADATA);
  await fetchStarted;
  const secondPromise = controller.translateTweet(METADATA);
  resolveFetch();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  assert.deepEqual(first, { ok: true, translation: "同一个译文", provider: "x" });
  assert.deepEqual(second, { ok: true, translation: "同一个译文", provider: "x" });
  assert.equal(fetchCalls.length, 1);
});

test("background times out hung direct API translations", async () => {
  const { chrome, storage } = createChromeMock();
  const fetchApi = async () => new Promise(() => {});
  const controller = createBackgroundController(chrome, {
    fetch: fetchApi,
    translationTimeoutMs: 1,
  });

  const result = await controller.translateTweet(METADATA);

  assert.deepEqual(result, { ok: false, error: "translation-request-timeout" });
  assert.equal(storage.xatStats.failed, 1);
  assert.equal(storage.xatStats.lastError, "translation-request-timeout");
});

test("background stores content script version in diagnostics", async () => {
  const { chrome, storage } = createChromeMock();
  const controller = createBackgroundController(chrome);

  await controller.recordDiagnostic({
    event: "content-script-active",
    extensionVersion: "0.1.0",
  });

  assert.equal(storage.xatStats.extensionVersion, "0.1.0");
  assert.equal(storage.xatStats.lastEvent, "content-script-active");
});

test("background counts longform unsupported diagnostics as skipped", async () => {
  const { chrome, storage } = createChromeMock();
  const controller = createBackgroundController(chrome);

  await controller.recordDiagnostic({
    event: "longform-unsupported",
    id: "2071912657133973977",
  });

  assert.equal(storage.xatStats.skipped, 1);
  assert.equal(storage.xatStats.lastEvent, "longform-unsupported");
  assert.equal(storage.xatStats.lastTweetId, "2071912657133973977");
});

test("background falls back from repeated X rate limits to configured Tencent translation", async () => {
  const { chrome, storage } = createChromeMock({
    initialStorage: {
      xatProviderSettings: {
        tencent: {
          secretId: "AKIDEXAMPLE",
          secretKey: "example-secret",
          region: "ap-guangzhou",
        },
      },
    },
  });
  const { fetchApi, calls: fetchCalls } = createFetchMock({
    responses: [createFetchResponse(429, { errors: [{ message: "Rate limited" }] })],
  });
  const tencentCalls = [];
  const providerConfigs = [];
  const controller = createBackgroundController(chrome, {
    fetch: fetchApi,
    translationRetryAttempts: 2,
    wait: async () => {},
    now: () => 1710000000000,
    tencentProviderFactory(config) {
      providerConfigs.push(config);
      return {
        id: "tencent",
        async translate(request) {
          tencentCalls.push(request);
          return { ok: true, translation: "来自腾讯云的译文", provider: "tencent" };
        },
      };
    },
  });

  const first = await controller.translateTweet(METADATA);
  const second = await createBackgroundController(chrome, {
    fetch: fetchApi,
    now: () => 1710000000000,
    tencentProviderFactory() {
      throw new Error("cached translations must not recreate providers");
    },
  }).translateTweet(METADATA);

  assert.deepEqual(first, { ok: true, translation: "来自腾讯云的译文", provider: "tencent" });
  assert.deepEqual(second, {
    ok: true,
    translation: "来自腾讯云的译文",
    provider: "tencent",
    cached: true,
  });
  assert.equal(fetchCalls.length, 2);
  assert.equal(providerConfigs[0].region, "ap-guangzhou");
  assert.equal(providerConfigs[0].secretId, "AKIDEXAMPLE");
  assert.equal(providerConfigs[0].secretKey, "example-secret");
  assert.equal(tencentCalls.length, 1);
  assert.equal(tencentCalls[0].text, "Hello from X");
  assert.equal(tencentCalls[0].sourceLanguage, "auto");
  assert.equal(tencentCalls[0].targetLanguage, "zh");
  assert.equal(storage.xatTranslationCache.translations[TWEET_ID].provider, "tencent");
});

test("background preserves the X rate-limit error when Tencent is not configured", async () => {
  const { chrome } = createChromeMock();
  const { fetchApi, calls: fetchCalls } = createFetchMock({
    responses: [createFetchResponse(429, { errors: [{ message: "Rate limited" }] })],
  });
  const controller = createBackgroundController(chrome, {
    fetch: fetchApi,
    translationRetryAttempts: 2,
    wait: async () => {},
  });

  const result = await controller.translateTweet(METADATA);

  assert.deepEqual(result, { ok: false, error: "translation-http-429" });
  assert.equal(fetchCalls.length, 2);
});

test("background saves Tencent credentials without exposing them in status", async () => {
  const { chrome, storage } = createChromeMock();
  const controller = createBackgroundController(chrome, { now: () => 1710000000000 });

  const saved = await controller.saveTencentConfig({
    secretId: "  AKIDEXAMPLE  ",
    secretKey: "  example-secret  ",
    region: " ap-shanghai ",
  });
  const status = await controller.getTencentConfigStatus();

  assert.deepEqual(saved, { ok: true, configured: true, region: "ap-shanghai" });
  assert.deepEqual(status, { ok: true, configured: true, region: "ap-shanghai" });
  assert.deepEqual(storage.xatProviderSettings.tencent, {
    secretId: "AKIDEXAMPLE",
    secretKey: "example-secret",
    region: "ap-shanghai",
    updatedAt: "2024-03-09T16:00:00.000Z",
  });
  assert.equal("secretId" in status, false);
  assert.equal("secretKey" in status, false);
});

test("background rejects incomplete Tencent credentials", async () => {
  const { chrome, storage } = createChromeMock();
  const controller = createBackgroundController(chrome);

  const result = await controller.saveTencentConfig({ secretId: "AKIDEXAMPLE", secretKey: "" });

  assert.deepEqual(result, { ok: false, error: "tencent-credentials-required" });
  assert.equal(storage.xatProviderSettings, undefined);
});

test("background tests the saved Tencent configuration through its provider", async () => {
  const { chrome } = createChromeMock({
    initialStorage: {
      xatProviderSettings: {
        tencent: {
          secretId: "AKIDEXAMPLE",
          secretKey: "example-secret",
          region: "ap-guangzhou",
        },
      },
    },
  });
  const factoryCalls = [];
  const translateCalls = [];
  const controller = createBackgroundController(chrome, {
    tencentProviderFactory(config) {
      factoryCalls.push(config);
      return {
        async translate(request) {
          translateCalls.push(request);
          return { ok: true, translation: "你好，腾讯云。", provider: "tencent" };
        },
      };
    },
  });

  const result = await controller.testTencentConfig();

  assert.deepEqual(result, { ok: true, translation: "你好，腾讯云。", provider: "tencent" });
  assert.equal(factoryCalls.length, 1);
  assert.equal(factoryCalls[0].secretId, "AKIDEXAMPLE");
  assert.equal(factoryCalls[0].secretKey, "example-secret");
  assert.deepEqual(translateCalls, [{
    text: "Hello, Tencent Cloud.",
    sourceLanguage: "en",
    targetLanguage: "zh",
  }]);
});

test("background deletes only the Tencent provider configuration", async () => {
  const { chrome, storage } = createChromeMock({
    initialStorage: {
      xatProviderSettings: {
        tencent: { secretId: "AKIDEXAMPLE", secretKey: "example-secret" },
        futureProvider: { enabled: true },
      },
    },
  });
  const controller = createBackgroundController(chrome);

  const result = await controller.deleteTencentConfig();

  assert.deepEqual(result, { ok: true, configured: false, region: "ap-guangzhou" });
  assert.deepEqual(storage.xatProviderSettings, { futureProvider: { enabled: true } });
});

test("background rejects provider configuration messages from page content scripts", () => {
  const { chrome, listeners } = createChromeMock();
  const controller = createBackgroundController(chrome);
  controller.registerMessageListener();
  const responses = [];

  const asynchronous = listeners[0](
    { type: "XAT_TENCENT_CONFIG_STATUS" },
    { tab: { id: 1 } },
    (response) => responses.push(response),
  );

  assert.equal(asynchronous, false);
  assert.deepEqual(responses, [{ ok: false, error: "untrusted-config-sender" }]);
});

test("background handles trusted Tencent configuration messages and restricts storage access", async () => {
  const { chrome, calls, listeners } = createChromeMock();
  const controller = createBackgroundController(chrome, { now: () => 1710000000000 });
  controller.registerMessageListener();

  const saveResponse = await new Promise((resolve) => {
    const asynchronous = listeners[0]({
      type: "XAT_TENCENT_CONFIG_SAVE",
      payload: {
        secretId: "AKIDEXAMPLE",
        secretKey: "example-secret",
        region: "ap-guangzhou",
      },
    }, {}, resolve);
    assert.equal(asynchronous, true);
  });
  const statusResponse = await new Promise((resolve) => {
    listeners[0]({ type: "XAT_TENCENT_CONFIG_STATUS" }, {}, resolve);
  });

  assert.deepEqual(saveResponse, { ok: true, configured: true, region: "ap-guangzhou" });
  assert.deepEqual(statusResponse, { ok: true, configured: true, region: "ap-guangzhou" });
  assert.deepEqual(
    calls.find(([name]) => name === "storage.local.setAccessLevel"),
    ["storage.local.setAccessLevel", { accessLevel: "TRUSTED_CONTEXTS" }],
  );
});
