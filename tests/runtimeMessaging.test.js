import assert from "node:assert/strict";
import test from "node:test";

import { sendRuntimeMessage } from "../src/runtimeMessaging.js";

test("sendRuntimeMessage resolves callback responses", async () => {
  const chrome = {
    runtime: {
      sendMessage(message, callback) {
        callback({ ok: true, echo: message.type });
      },
    },
  };

  const result = await sendRuntimeMessage({ type: "PING" }, chrome);

  assert.deepEqual(result, { ok: true, echo: "PING" });
});

test("sendRuntimeMessage converts runtime lastError into an error result", async () => {
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage(_message, callback) {
        chrome.runtime.lastError = { message: "Receiving end does not exist" };
        callback();
      },
    },
  };

  const result = await sendRuntimeMessage({ type: "PING" }, chrome);

  assert.deepEqual(result, { ok: false, error: "Receiving end does not exist" });
});

test("sendRuntimeMessage supports promise-returning runtimes", async () => {
  const chrome = {
    runtime: {
      sendMessage() {
        return Promise.resolve({ ok: true, promise: true });
      },
    },
  };

  const result = await sendRuntimeMessage({ type: "PING" }, chrome);

  assert.deepEqual(result, { ok: true, promise: true });
});

test("sendRuntimeMessage converts promise rejections into error results", async () => {
  const chrome = {
    runtime: {
      sendMessage() {
        return Promise.reject(new Error("promise failed"));
      },
    },
  };

  const result = await sendRuntimeMessage({ type: "PING" }, chrome);

  assert.deepEqual(result, { ok: false, error: "promise failed" });
});

test("sendRuntimeMessage reports unavailable runtime messaging", async () => {
  const result = await sendRuntimeMessage({ type: "PING" }, {});

  assert.deepEqual(result, { ok: false, error: "runtime-messaging-unavailable" });
});
