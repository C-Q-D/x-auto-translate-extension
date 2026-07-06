import assert from "node:assert/strict";
import test from "node:test";

import { createBackgroundController } from "../src/background.js";

const TWEET_ID = "2071647677591466098";
const METADATA = {
  id: TWEET_ID,
  url: `https://x.com/openai/status/${TWEET_ID}`,
  csrfToken: "csrf-token",
  dstLang: "zh",
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
      },
    },
  };

  return { chrome, calls, listeners, storage };
}

function createFetchResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
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

  assert.deepEqual(result, { ok: true, translation: "你好" });
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
  const { chrome, storage } = createChromeMock();
  const { fetchApi } = createFetchMock({
    responses: [createFetchResponse(403, { errors: [{ message: "Forbidden" }] })],
  });
  const controller = createBackgroundController(chrome, { fetch: fetchApi });

  const result = await controller.translateTweet(METADATA);

  assert.deepEqual(result, { ok: false, error: "translation-http-403" });
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

test("background restores translated cache from storage after controller restart", async () => {
  const { chrome, storage } = createChromeMock();
  const { fetchApi, calls: fetchCalls } = createFetchMock();
  const firstController = createBackgroundController(chrome, { fetch: fetchApi, now: () => 123456 });

  const first = await firstController.translateTweet(METADATA);
  const secondController = createBackgroundController(chrome, { fetch: fetchApi, now: () => 123456 });
  const second = await secondController.translateTweet(METADATA);

  assert.deepEqual(first, { ok: true, translation: "你好" });
  assert.deepEqual(second, { ok: true, translation: "你好", cached: true });
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

  assert.deepEqual(result, { ok: true, translation: "新译文" });
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

  assert.deepEqual(first, { ok: true, translation: "译文A" });
  assert.deepEqual(second, { ok: true, translation: "译文B" });
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

  assert.deepEqual(first, { ok: true, translation: "同一个译文" });
  assert.deepEqual(second, { ok: true, translation: "同一个译文" });
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
