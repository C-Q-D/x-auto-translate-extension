import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { JSDOM } from "jsdom";

const contentScriptUrl = pathToFileURL(fileURLToPath(new URL("../src/contentScript.js", import.meta.url))).href;

function setupDom(url, html) {
  const dom = new JSDOM(html, { url });
  const observed = [];
  const observers = [];
  const listeners = [];
  const sentMessages = [];

  class FakeIntersectionObserver {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      observers.push(this);
    }

    observe(element) {
      observed.push(element);
    }

    unobserve() {}

    disconnect() {}
  }

  dom.window.setInterval = () => 1;
  dom.window.clearInterval = () => {};
  dom.window.setTimeout = (callback) => {
    callback();
    return 1;
  };
  dom.window.clearTimeout = () => {};

  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.Node = dom.window.Node;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.MutationObserver = dom.window.MutationObserver;
  globalThis.IntersectionObserver = FakeIntersectionObserver;
  globalThis.chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: "0.1.1" }),
      sendMessage(message, callback) {
        sentMessages.push(message);
        callback?.({ ok: true });
      },
      onMessage: {
        addListener(listener) {
          listeners.push(listener);
        },
      },
    },
  };
  delete globalThis.__xatContentScriptLoaded;
  delete globalThis.__xatScan;

  return { dom, observed, observers, listeners, sentMessages };
}

async function loadContentScript() {
  await import(`${contentScriptUrl}?test=${Date.now()}-${Math.random()}`);
}

async function flushMutations() {
  await Promise.resolve();
  await Promise.resolve();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("content script observes detail-page tweets and dynamically inserted comments", async () => {
  const { dom, observed, observers, listeners, sentMessages } = setupDom(
    "https://x.com/openai/status/2071647677591466098",
    `
      <main>
        <article data-testid="tweet">
          <a href="/openai/status/2071647677591466098"><time>1小时前</time></a>
          <div data-testid="tweetText">Detail page tweet</div>
        </article>
      </main>
    `,
  );
  document.cookie = "ct0=csrf-token";

  await loadContentScript();
  assert.equal(observed.length, 1);
  assert.equal(document.querySelector("article").dataset.xatObserved, "1");

  document.querySelector("main").insertAdjacentHTML(
    "beforeend",
    `
      <article data-testid="tweet">
        <a href="/reply/status/3333333333333333333"><time>刚刚</time></a>
        <div data-testid="tweetText">Hydrated detail comment</div>
      </article>
    `,
  );
  await flushMutations();

  assert.equal(observed.length, 2);
  assert.equal(document.querySelectorAll("[data-xat-observed='1']").length, 2);

  let response;
  listeners[0]({ type: "XAT_CONTENT_STATUS" }, null, (value) => {
    response = value;
  });
  assert.equal(response.canProcess, true);
  assert.equal(response.articleCount, 2);
  assert.equal(response.observedCount, 2);

  observers[0].callback([{ isIntersecting: true, target: observed[1] }]);
  await flushMutations();
  await wait(650);

  const translationRequest = sentMessages.find((entry) => entry.type === "XAT_TRANSLATE_TWEET");
  assert.deepEqual(translationRequest.payload, {
    id: "3333333333333333333",
    url: "https://x.com/reply/status/3333333333333333333",
    csrfToken: "csrf-token",
    dstLang: "zh",
  });
  dom.window.close();
});

test("content script observes timeline tweets and reports popup status", async () => {
  const { dom, observed, listeners } = setupDom(
    "https://x.com/home",
    `
      <main>
        <article data-testid="tweet" data-xat-state="translated">
          <a href="/openai/status/2071647677591466098">time</a>
          <div data-testid="tweetText" data-xat-translation="1">译文</div>
          <button data-testid="tweet-text-show-more-link">显示更多</button>
        </article>
      </main>
    `,
  );

  await loadContentScript();

  assert.equal(observed.length, 1);
  assert.equal(document.querySelector("article").dataset.xatObserved, "1");

  let response;
  const handled = listeners[0]({ type: "XAT_CONTENT_STATUS" }, null, (value) => {
    response = value;
  });

  assert.equal(handled, false);
  assert.equal(response.ok, true);
  assert.equal(response.canProcess, true);
  assert.equal(response.articleCount, 1);
  assert.equal(response.observedCount, 1);
  assert.equal(response.showMoreCount, 1);
  assert.equal(response.translationCount, 1);
  assert.deepEqual(response.states, { translated: 1 });
  dom.window.close();
});

test("content script includes csrf token and zh target language in translation requests", async () => {
  const { dom, observed, observers, sentMessages } = setupDom(
    "https://x.com/home",
    `
      <main>
        <article data-testid="tweet">
          <a href="/openai/status/2071647677591466098">time</a>
          <div data-testid="tweetText">Timeline tweet</div>
        </article>
      </main>
    `,
  );
  document.cookie = "ct0=csrf-token";

  await loadContentScript();
  observers[0].callback([{ isIntersecting: true, target: observed[0] }]);
  await flushMutations();
  await wait(650);

  const message = sentMessages.find((entry) => entry.type === "XAT_TRANSLATE_TWEET");
  assert.deepEqual(message.payload, {
    id: "2071647677591466098",
    url: "https://x.com/openai/status/2071647677591466098",
    csrfToken: "csrf-token",
    dstLang: "zh",
  });
  dom.window.close();
});
