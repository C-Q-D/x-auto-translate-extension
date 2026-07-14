const TENCENT_ENDPOINT = "https://tmt.tencentcloudapi.com/";
const TENCENT_HOST = "tmt.tencentcloudapi.com";
const TENCENT_SERVICE = "tmt";
const TENCENT_ACTION = "TextTranslate";
const TENCENT_VERSION = "2018-03-21";
const TENCENT_ALGORITHM = "TC3-HMAC-SHA256";
const TENCENT_MAX_TEXT_LENGTH = 2000;

const textEncoder = new TextEncoder();

function toHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toBytes(value) {
  return typeof value === "string" ? textEncoder.encode(value) : value;
}

async function sha256Hex(cryptoApi, value) {
  const digest = await cryptoApi.subtle.digest("SHA-256", toBytes(value));
  return toHex(new Uint8Array(digest));
}

async function hmacSha256(cryptoApi, key, value) {
  const cryptoKey = await cryptoApi.subtle.importKey(
    "raw",
    toBytes(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await cryptoApi.subtle.sign("HMAC", cryptoKey, toBytes(value));
  return new Uint8Array(signature);
}

function codePointLength(value) {
  return Array.from(value).length;
}

function createFailure(error, category, options = {}) {
  return {
    ok: false,
    error,
    category,
    fallback: options.fallback ?? true,
    retryable: options.retryable ?? false,
    ...(options.providerCode ? { providerCode: options.providerCode } : {}),
  };
}

export function classifyTencentError(providerCode = "", httpStatus = 0) {
  if (providerCode === "FailedOperation.NoFreeAmount") {
    return createFailure("tencent-quota-exhausted", "quota_exhausted", { providerCode });
  }

  if (
    providerCode.startsWith("RequestLimitExceeded") ||
    providerCode === "LimitExceeded.LimitedAccessFrequency" ||
    httpStatus === 429
  ) {
    return createFailure("tencent-rate-limited", "rate_limited", {
      providerCode,
      retryable: true,
    });
  }

  if (providerCode.startsWith("AuthFailure") || providerCode.startsWith("UnauthorizedOperation")) {
    return createFailure("tencent-auth-failed", "auth_failed", { providerCode });
  }

  if (providerCode === "FailedOperation.UserNotRegistered") {
    return createFailure("tencent-service-not-enabled", "service_not_enabled", { providerCode });
  }

  if (
    providerCode === "FailedOperation.ServiceIsolate" ||
    providerCode === "FailedOperation.StopUsing"
  ) {
    return createFailure("tencent-billing-problem", "billing_problem", { providerCode });
  }

  if (
    (providerCode.includes("Unsupported") && providerCode.includes("Language")) ||
    providerCode.includes("UnSupportedTargetLanguage") ||
    providerCode === "FailedOperation.LanguageRecognitionErr"
  ) {
    return createFailure("tencent-unsupported-language", "unsupported_language", { providerCode });
  }

  if (
    providerCode.startsWith("InvalidParameter") ||
    providerCode === "UnsupportedOperation.TextTooLong" ||
    httpStatus === 400
  ) {
    return createFailure("tencent-invalid-request", "invalid_request", {
      providerCode,
      fallback: false,
    });
  }

  if (
    providerCode.startsWith("InternalError") ||
    providerCode === "ServiceUnavailable" ||
    providerCode.startsWith("FailedOperation.Request") ||
    httpStatus >= 500
  ) {
    return createFailure("tencent-temporary-failure", "temporary_failure", {
      providerCode,
      retryable: true,
    });
  }

  if (httpStatus === 401 || httpStatus === 403) {
    return createFailure("tencent-auth-failed", "auth_failed", { providerCode });
  }

  return createFailure(
    providerCode ? `tencent-${providerCode}` : `tencent-http-${httpStatus || 0}`,
    "provider_failure",
    { providerCode },
  );
}

async function createAuthorization({ cryptoApi, secretId, secretKey, payload, timestamp }) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const canonicalHeaders = [
    "content-type:application/json; charset=utf-8",
    `host:${TENCENT_HOST}`,
    `x-tc-action:${TENCENT_ACTION.toLowerCase()}`,
    "",
  ].join("\n");
  const signedHeaders = "content-type;host;x-tc-action";
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    await sha256Hex(cryptoApi, payload),
  ].join("\n");
  const credentialScope = `${date}/${TENCENT_SERVICE}/tc3_request`;
  const stringToSign = [
    TENCENT_ALGORITHM,
    timestamp,
    credentialScope,
    await sha256Hex(cryptoApi, canonicalRequest),
  ].join("\n");
  const secretDate = await hmacSha256(cryptoApi, `TC3${secretKey}`, date);
  const secretService = await hmacSha256(cryptoApi, secretDate, TENCENT_SERVICE);
  const secretSigning = await hmacSha256(cryptoApi, secretService, "tc3_request");
  const signature = toHex(await hmacSha256(cryptoApi, secretSigning, stringToSign));

  return `${TENCENT_ALGORITHM} Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

export function createTencentTranslationProvider(config = {}) {
  const fetchApi = config.fetch || globalThis.fetch?.bind(globalThis);
  const cryptoApi = config.crypto || globalThis.crypto;
  const now = config.now || (() => Date.now());
  const region = config.region || "ap-guangzhou";

  async function translate(request = {}) {
    const text = typeof request.text === "string" ? request.text.trim() : "";
    if (!text) {
      return createFailure("tencent-text-required", "invalid_request", { fallback: false });
    }
    if (codePointLength(text) > TENCENT_MAX_TEXT_LENGTH) {
      return createFailure("tencent-text-too-long", "invalid_request", { fallback: false });
    }
    if (!config.secretId || !config.secretKey) {
      return createFailure("tencent-credentials-missing", "auth_failed");
    }
    if (!fetchApi) {
      return createFailure("tencent-fetch-unavailable", "configuration_error");
    }
    if (!cryptoApi?.subtle) {
      return createFailure("tencent-crypto-unavailable", "configuration_error");
    }

    const payload = JSON.stringify({
      SourceText: text,
      Source: request.sourceLanguage || "auto",
      Target: request.targetLanguage || "zh",
      ProjectId: 0,
    });
    const timestamp = Math.floor(now() / 1000);
    const authorization = await createAuthorization({
      cryptoApi,
      secretId: config.secretId,
      secretKey: config.secretKey,
      payload,
      timestamp,
    });
    const headers = {
      Authorization: authorization,
      "Content-Type": "application/json; charset=utf-8",
      "X-TC-Action": TENCENT_ACTION,
      "X-TC-Version": TENCENT_VERSION,
      "X-TC-Timestamp": String(timestamp),
      "X-TC-Region": region,
    };
    if (config.token) {
      headers["X-TC-Token"] = config.token;
    }

    let response;
    try {
      response = await fetchApi(TENCENT_ENDPOINT, {
        method: "POST",
        headers,
        body: payload,
        signal: request.signal,
      });
    } catch (error) {
      if (error?.name === "AbortError" || request.signal?.aborted) {
        return createFailure("tencent-request-timeout", "temporary_failure", { retryable: true });
      }
      return createFailure("tencent-network-failure", "temporary_failure", { retryable: true });
    }

    let body;
    try {
      body = JSON.parse(await response.text());
    } catch {
      return createFailure("tencent-invalid-response", "temporary_failure", { retryable: true });
    }

    const result = body?.Response || {};
    if (!response.ok || result.Error) {
      return classifyTencentError(result.Error?.Code || "", response.status || 0);
    }

    const translation = typeof result.TargetText === "string" ? result.TargetText.trim() : "";
    if (!translation) {
      return createFailure("tencent-empty-translation", "provider_failure");
    }

    return {
      ok: true,
      translation,
      provider: "tencent",
      sourceLanguage: result.Source || request.sourceLanguage || "auto",
      targetLanguage: result.Target || request.targetLanguage || "zh",
      usage: {
        characters: Number(result.UsedAmount ?? codePointLength(text)),
      },
    };
  }

  return {
    id: "tencent",
    translate,
  };
}
