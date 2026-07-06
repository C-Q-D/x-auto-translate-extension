export function sendRuntimeMessage(message, chromeApi = globalThis.chrome) {
  if (!chromeApi?.runtime?.sendMessage) {
    return Promise.resolve({ ok: false, error: "runtime-messaging-unavailable" });
  }

  return new Promise((resolve) => {
    let settled = false;

    function settle(value) {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    }

    try {
      const maybePromise = chromeApi.runtime.sendMessage(message, (response) => {
        const error = chromeApi.runtime.lastError;
        if (error) {
          settle({ ok: false, error: error.message || "runtime-message-failed" });
          return;
        }
        settle(response ?? { ok: false, error: "empty-runtime-response" });
      });

      if (maybePromise?.then) {
        maybePromise
          .then((response) => settle(response ?? { ok: false, error: "empty-runtime-response" }))
          .catch((error) => settle({ ok: false, error: error?.message || "runtime-message-failed" }));
      }
    } catch (error) {
      settle({ ok: false, error: error?.message || "runtime-message-failed" });
    }
  });
}
