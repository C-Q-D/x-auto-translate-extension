// 本测试文件覆盖腾讯云机器翻译 provider 的签名、错误分类、长文本分块和请求契约。
// provider 是第三方翻译管线的一环，测试需要保护限额边界和长文聚合顺序。
import assert from "node:assert/strict";
import { createHash, createHmac, webcrypto } from "node:crypto";
import test from "node:test";

import {
  classifyTencentError,
  createTencentTranslationProvider,
} from "../src/providers/tencentTranslationProvider.js";

const SECRET_ID = "AKIDEXAMPLE";
const SECRET_KEY = "example-secret-key";
const NOW_MS = 1710000000000;

function createResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}

function createFetchMock(response) {
  const calls = [];
  return {
    calls,
    async fetch(url, options) {
      calls.push([url, options]);
      return response;
    },
  };
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key, value) {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function expectedAuthorization(payload) {
  const timestamp = Math.floor(NOW_MS / 1000);
  const date = new Date(NOW_MS).toISOString().slice(0, 10);
  const canonicalHeaders = [
    "content-type:application/json; charset=utf-8",
    "host:tmt.tencentcloudapi.com",
    "x-tc-action:texttranslate",
    "",
  ].join("\n");
  const signedHeaders = "content-type;host;x-tc-action";
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    sha256(payload),
  ].join("\n");
  const scope = `${date}/tmt/tc3_request`;
  const stringToSign = ["TC3-HMAC-SHA256", timestamp, scope, sha256(canonicalRequest)].join("\n");
  const secretDate = hmac(Buffer.from(`TC3${SECRET_KEY}`), date);
  const secretService = hmac(secretDate, "tmt");
  const secretSigning = hmac(secretService, "tc3_request");
  const signature = createHmac("sha256", secretSigning).update(stringToSign, "utf8").digest("hex");
  return `TC3-HMAC-SHA256 Credential=${SECRET_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

test("Tencent provider signs and translates one text", async () => {
  const fetchMock = createFetchMock(createResponse(200, {
    Response: {
      RequestId: "request-id",
      Source: "en",
      Target: "zh",
      TargetText: "你好，世界！",
      UsedAmount: 13,
    },
  }));
  const provider = createTencentTranslationProvider({
    secretId: SECRET_ID,
    secretKey: SECRET_KEY,
    region: "ap-guangzhou",
    fetch: fetchMock.fetch,
    crypto: webcrypto,
    now: () => NOW_MS,
  });

  const result = await provider.translate({
    text: "Hello, world!",
    sourceLanguage: "en",
    targetLanguage: "zh",
  });

  assert.deepEqual(result, {
    ok: true,
    translation: "你好，世界！",
    provider: "tencent",
    sourceLanguage: "en",
    targetLanguage: "zh",
    usage: { characters: 13 },
  });
  assert.equal(fetchMock.calls.length, 1);
  const [url, options] = fetchMock.calls[0];
  assert.equal(url, "https://tmt.tencentcloudapi.com/");
  assert.equal(options.method, "POST");
  assert.deepEqual(JSON.parse(options.body), {
    SourceText: "Hello, world!",
    Source: "en",
    Target: "zh",
    ProjectId: 0,
  });
  assert.equal(options.headers.Authorization, expectedAuthorization(options.body));
  assert.equal(options.headers["X-TC-Action"], "TextTranslate");
  assert.equal(options.headers["X-TC-Version"], "2018-03-21");
  assert.equal(options.headers["X-TC-Region"], "ap-guangzhou");
});

test("Tencent provider maps free quota exhaustion to a fallback result", async () => {
  const fetchMock = createFetchMock(createResponse(200, {
    Response: {
      Error: {
        Code: "FailedOperation.NoFreeAmount",
        Message: "No free amount",
      },
      RequestId: "request-id",
    },
  }));
  const provider = createTencentTranslationProvider({
    secretId: SECRET_ID,
    secretKey: SECRET_KEY,
    fetch: fetchMock.fetch,
    crypto: webcrypto,
    now: () => NOW_MS,
  });

  const result = await provider.translate({ text: "Hello" });

  assert.deepEqual(result, {
    ok: false,
    error: "tencent-quota-exhausted",
    category: "quota_exhausted",
    fallback: true,
    retryable: false,
    providerCode: "FailedOperation.NoFreeAmount",
  });
});

test("Tencent provider distinguishes short rate limits from quota exhaustion", async () => {
  const result = classifyTencentError("LimitExceeded.LimitedAccessFrequency", 200);

  assert.deepEqual(result, {
    ok: false,
    error: "tencent-rate-limited",
    category: "rate_limited",
    fallback: true,
    retryable: true,
    providerCode: "LimitExceeded.LimitedAccessFrequency",
  });
});

test("Tencent provider treats signature failures as authentication errors", async () => {
  const result = classifyTencentError("AuthFailure.SignatureFailure", 200);

  assert.deepEqual(result, {
    ok: false,
    error: "tencent-auth-failed",
    category: "auth_failed",
    fallback: true,
    retryable: false,
    providerCode: "AuthFailure.SignatureFailure",
  });
});

test("Tencent provider maps unsupported source languages without disabling the provider", async () => {
  const result = classifyTencentError("UnsupportedOperation.UnsupportedSourceLanguage", 200);

  assert.deepEqual(result, {
    ok: false,
    error: "tencent-unsupported-language",
    category: "unsupported_language",
    fallback: true,
    retryable: false,
    providerCode: "UnsupportedOperation.UnsupportedSourceLanguage",
  });
});

test("Tencent provider splits long text into limited concurrent requests and merges translations", async () => {
  let activeRequests = 0;
  let maxActiveRequests = 0;
  const calls = [];
  const provider = createTencentTranslationProvider({
    secretId: SECRET_ID,
    secretKey: SECRET_KEY,
    fetch: async (url, options) => {
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      calls.push([url, options]);
      const callIndex = calls.length;
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeRequests -= 1;
      const { SourceText } = JSON.parse(options.body);
      return createResponse(200, {
        Response: {
          RequestId: `request-${callIndex}`,
          Source: "en",
          Target: "zh",
          TargetText: `译文${callIndex}:${SourceText.length}`,
          UsedAmount: SourceText.length,
        },
      });
    },
    crypto: webcrypto,
    now: () => NOW_MS,
    maxConcurrentRequests: 3,
  });

  const result = await provider.translate({ text: "a".repeat(4500), targetLanguage: "zh" });

  assert.equal(result.ok, true);
  assert.equal(result.translation, "译文1:2000\n\n译文2:2000\n\n译文3:500");
  assert.equal(result.usage.characters, 4500);
  assert.equal(calls.length, 3);
  assert.equal(maxActiveRequests, 3);
  for (const [, options] of calls) {
    assert.ok(JSON.parse(options.body).SourceText.length <= 2000);
  }
});

test("Tencent provider returns the first failed chunk result when long text chunk translation fails", async () => {
  const fetchMock = createFetchMock(createResponse(200, {
    Response: {
      Error: {
        Code: "LimitExceeded.LimitedAccessFrequency",
        Message: "Rate limited",
      },
      RequestId: "request-id",
    },
  }));
  const provider = createTencentTranslationProvider({
    secretId: SECRET_ID,
    secretKey: SECRET_KEY,
    fetch: fetchMock.fetch,
    crypto: webcrypto,
  });

  const result = await provider.translate({ text: "a".repeat(2001) });

  assert.deepEqual(result, {
    ok: false,
    error: "tencent-rate-limited",
    category: "rate_limited",
    fallback: true,
    retryable: true,
    providerCode: "LimitExceeded.LimitedAccessFrequency",
  });
  assert.equal(fetchMock.calls.length, 2);
});

test("Tencent provider reports missing credentials before signing", async () => {
  const provider = createTencentTranslationProvider({ crypto: webcrypto });

  const result = await provider.translate({ text: "Hello" });

  assert.deepEqual(result, {
    ok: false,
    error: "tencent-credentials-missing",
    category: "auth_failed",
    fallback: true,
    retryable: false,
  });
});
