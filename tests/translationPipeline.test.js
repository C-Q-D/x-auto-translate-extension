import assert from "node:assert/strict";
import test from "node:test";

import { createTranslationPipeline } from "../src/translationPipeline.js";

test("translation pipeline tries the next provider only after an explicit fallback", async () => {
  const calls = [];
  const pipeline = createTranslationPipeline([
    {
      id: "x",
      async translate(request) {
        calls.push(["x", request]);
        return { ok: false, error: "x-rate-limited", fallback: true };
      },
    },
    {
      id: "next",
      async translate(request) {
        calls.push(["next", request]);
        return { ok: true, translation: "下一家译文" };
      },
    },
  ]);

  const request = { text: "hello", targetLanguage: "zh" };
  const result = await pipeline.translate(request);

  assert.deepEqual(result, { ok: true, translation: "下一家译文" });
  assert.deepEqual(calls, [["x", request], ["next", request]]);
});

test("translation pipeline stops after a provider returns a terminal result", async () => {
  let nextProviderCalled = false;
  const pipeline = createTranslationPipeline([
    {
      id: "x",
      async translate() {
        return { ok: false, error: "invalid-request" };
      },
    },
    {
      id: "next",
      async translate() {
        nextProviderCalled = true;
        return { ok: true, translation: "不应调用" };
      },
    },
  ]);

  const result = await pipeline.translate({ text: "hello" });

  assert.deepEqual(result, { ok: false, error: "invalid-request" });
  assert.equal(nextProviderCalled, false);
});

test("translation pipeline removes fallback control data from its public result", async () => {
  const pipeline = createTranslationPipeline([
    {
      id: "x",
      async translate() {
        return { ok: false, error: "temporary-failure", fallback: true };
      },
    },
  ]);

  const result = await pipeline.translate({ text: "hello" });

  assert.deepEqual(result, { ok: false, error: "temporary-failure" });
});

test("translation pipeline reports when no provider is configured", async () => {
  const pipeline = createTranslationPipeline([]);

  const result = await pipeline.translate({ text: "hello" });

  assert.deepEqual(result, { ok: false, error: "translation-provider-unavailable" });
});
