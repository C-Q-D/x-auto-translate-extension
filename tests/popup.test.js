import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { JSDOM } from "jsdom";

async function flushAsyncWork() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("popup saves, tests, and deletes Tencent credentials through the background", async () => {
  const html = await readFile(new URL("../popup.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "chrome-extension://example/popup.html" });
  const messages = [];
  const chromeMock = {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: "0.2.0" }),
      sendMessage(message, callback) {
        messages.push(message);
        const responses = {
          XAT_TENCENT_CONFIG_STATUS: { ok: true, configured: false, region: "ap-guangzhou" },
          XAT_TENCENT_CONFIG_SAVE: { ok: true, configured: true, region: "ap-shanghai" },
          XAT_TENCENT_CONFIG_TEST: { ok: true, translation: "你好，腾讯云。", provider: "tencent" },
          XAT_TENCENT_CONFIG_DELETE: { ok: true, configured: false, region: "ap-guangzhou" },
        };
        callback(responses[message.type]);
      },
    },
    scripting: {
      executeScript(_options, callback) {
        callback();
      },
    },
    storage: {
      local: {
        async get() {
          return {};
        },
      },
    },
    tabs: {
      query(_query, callback) {
        callback([{ id: 1, url: "https://x.com/home" }]);
      },
      sendMessage(_tabId, _message, callback) {
        callback({
          ok: true,
          canProcess: true,
          articleCount: 1,
          translationCount: 0,
          showMoreCount: 0,
          states: {},
          version: "0.2.0",
        });
      },
    },
  };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.chrome = chromeMock;

  try {
    await import(`../popup.js?test=${Date.now()}`);
    await flushAsyncWork();
    assert.equal(document.getElementById("tencentStatus").textContent, "配置状态：未配置");

    document.getElementById("tencentSecretId").value = "AKIDEXAMPLE";
    document.getElementById("tencentSecretKey").value = "example-secret";
    document.getElementById("tencentRegion").value = "ap-shanghai";
    document.getElementById("tencentSave").click();
    await flushAsyncWork();

    assert.deepEqual(messages.at(-1), {
      type: "XAT_TENCENT_CONFIG_SAVE",
      payload: {
        secretId: "AKIDEXAMPLE",
        secretKey: "example-secret",
        region: "ap-shanghai",
      },
    });
    assert.equal(document.getElementById("tencentSecretKey").value, "");
    assert.equal(document.getElementById("tencentStatus").textContent, "配置状态：已保存（ap-shanghai）");

    document.getElementById("tencentTest").click();
    await flushAsyncWork();
    assert.equal(messages.at(-1).type, "XAT_TENCENT_CONFIG_TEST");
    assert.equal(document.getElementById("tencentStatus").textContent, "配置状态：测试成功：你好，腾讯云。");

    document.getElementById("tencentDelete").click();
    await flushAsyncWork();
    assert.equal(messages.at(-1).type, "XAT_TENCENT_CONFIG_DELETE");
    assert.equal(document.getElementById("tencentStatus").textContent, "配置状态：未配置");
  } finally {
    delete globalThis.chrome;
    delete globalThis.document;
    delete globalThis.window;
    dom.window.close();
  }
});
