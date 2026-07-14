function toPublicResult(result) {
  if (!result || typeof result !== "object") {
    return { ok: false, error: "translation-provider-invalid-result" };
  }

  const { fallback, ...publicResult } = result;
  return publicResult;
}

export function createTranslationPipeline(providers = []) {
  if (!Array.isArray(providers)) {
    throw new TypeError("translation providers must be an array");
  }

  const orderedProviders = providers.map((provider) => {
    if (!provider?.id || typeof provider.translate !== "function") {
      throw new TypeError("each translation provider must have an id and translate function");
    }
    return provider;
  });

  async function translate(request) {
    if (orderedProviders.length === 0) {
      return { ok: false, error: "translation-provider-unavailable" };
    }

    let lastResult;
    for (const provider of orderedProviders) {
      lastResult = await provider.translate(request);
      if (!lastResult?.fallback) {
        return toPublicResult(lastResult);
      }
    }

    return toPublicResult(lastResult);
  }

  return { translate };
}
