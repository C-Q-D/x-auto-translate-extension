// 本测试文件覆盖内容脚本在 X 页面中的观察、状态上报和翻译消息转发行为。
// 重点保护详情页评论、时间线帖子和独立 X Article 长文都能被调度处理。
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
  // 内容脚本和处理器都通过 globalThis 读定时器；测试中必须把全局定时器切到当前 JSDOM，避免上个用例的异步任务污染下个用例。
  globalThis.setTimeout = dom.window.setTimeout;
  globalThis.clearTimeout = dom.window.clearTimeout;
  globalThis.chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: "0.2.0" }),
      sendMessage(message, callback) {
        sentMessages.push(message);
        if (message.type === "XAT_TRANSLATE_TWEET") {
          callback?.({ ok: true, translation: "内容脚本测试译文" });
          return;
        }
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
    text: "Hydrated detail comment",
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

test("content script observes standalone X Article read views on status pages", async () => {
  const { dom, observed, observers, listeners, sentMessages } = setupDom(
    "https://x.com/0xwhrrari/status/2071337983899271175",
    `
      <main>
        <span class="css-1jxf684 r-bcqeeo r-1ttztb7 r-qvutc0 r-poiln3">How I Use Claude Cowork to Run Like a One-Person Company</span>
        <div data-testid="twitterArticleRichTextView">
          <div data-testid="longformRichTextComponent">
            <div data-contents="true">
              <div class="longform-unstyled" data-block="true">
                <span data-text="true">Emails. Reports. Formatting.</span>
              </div>
              <div class="longform-unstyled" data-block="true">
                <span data-text="true">Most knowledge workers spend time on necessary work.</span>
              </div>
            </div>
          </div>
        </div>
      </main>
    `,
  );
  document.cookie = "ct0=csrf-token";

  await loadContentScript();

  const readView = document.querySelector("[data-testid='twitterArticleRichTextView']");
  assert.equal(observed.length, 1);
  assert.equal(observed[0], readView);
  assert.equal(readView.dataset.xatObserved, "1");

  let response;
  listeners[0]({ type: "XAT_CONTENT_STATUS" }, null, (value) => {
    response = value;
  });
  assert.equal(response.articleCount, 1);
  assert.equal(response.observedCount, 1);

  observers[0].callback([{ isIntersecting: true, target: readView }]);
  await flushMutations();
  await wait(650);

  const message = sentMessages.find((entry) => entry.type === "XAT_TRANSLATE_TWEET");
  assert.deepEqual(message.payload, {
    id: "2071337983899271175",
    url: "https://x.com/0xwhrrari/status/2071337983899271175",
    contentType: "longform",
    text: "Emails. Reports. Formatting. Most knowledge workers spend time on necessary work.",
    csrfToken: "csrf-token",
    dstLang: "zh",
  });
  dom.window.close();
});

test("content script reschedules standalone X Article when rich text hydrates after the shell", async () => {
  const { dom, observed, observers, sentMessages } = setupDom(
    "https://x.com/0xwhrrari/status/2071337983899271175",
    `
      <main>
        <div data-testid="twitterArticleRichTextView">
          <div class="DraftEditor-root">
            <div data-testid="longformRichTextComponent" contenteditable="false"></div>
          </div>
        </div>
      </main>
    `,
  );
  document.cookie = "ct0=csrf-token";

  await loadContentScript();

  const readView = document.querySelector("[data-testid='twitterArticleRichTextView']");
  const body = document.querySelector("[data-testid='longformRichTextComponent']");
  observers[0].callback([{ isIntersecting: true, target: observed[0] }]);
  await flushMutations();
  await wait(650);

  assert.equal(sentMessages.some((entry) => entry.type === "XAT_TRANSLATE_TWEET"), false);
  assert.equal(readView.dataset.xatState, "expanded");
  assert.equal(readView.parentElement.querySelector("[data-xat-status]").textContent, "正在等待长文正文加载...");

  body.insertAdjacentHTML(
    "beforeend",
    `
      <div data-contents="true">
        <div class="longform-unstyled" data-block="true">
          <span data-text="true">Hydrated article body.</span>
        </div>
      </div>
    `,
  );
  await flushMutations();
  await wait(650);

  const message = sentMessages.find((entry) => entry.type === "XAT_TRANSLATE_TWEET");
  assert.deepEqual(message.payload, {
    id: "2071337983899271175",
    url: "https://x.com/0xwhrrari/status/2071337983899271175",
    contentType: "longform",
    text: "Hydrated article body.",
    csrfToken: "csrf-token",
    dstLang: "zh",
  });
  dom.window.close();
});

test("manual article translation only processes X Article longform targets", async () => {
  const { dom, listeners, sentMessages } = setupDom(
    "https://x.com/0xwhrrari/status/2071337983899271175",
    `
      <main>
        <article data-testid="tweet">
          <a href="/reply/status/3333333333333333333"><time>刚刚</time></a>
          <div data-testid="tweetText">普通评论不应该被手动文章翻译处理</div>
        </article>
        <div data-testid="twitterArticleRichTextView">
          <div data-testid="longformRichTextComponent">
            <span data-text="true">Manual article body.</span>
          </div>
        </div>
      </main>
    `,
  );
  document.cookie = "ct0=csrf-token";

  await loadContentScript();

  let response;
  const handledValues = listeners.map((listener) => listener(
    { type: "XAT_FORCE_TRANSLATE_ARTICLE" },
    null,
    (value) => {
      response = value;
    },
  ));
  await flushMutations();
  await wait(650);
  await flushMutations();

  assert.deepEqual(handledValues, [false, true]);
  assert.deepEqual(response, { ok: true, message: "文章翻译：已完成" });
  const translationMessages = sentMessages.filter((entry) => entry.type === "XAT_TRANSLATE_TWEET");
  assert.equal(translationMessages.length, 1);
  assert.deepEqual(translationMessages[0].payload, {
    id: "2071337983899271175",
    url: "https://x.com/0xwhrrari/status/2071337983899271175",
    contentType: "longform",
    text: "Manual article body.",
    csrfToken: "csrf-token",
    dstLang: "zh",
  });
  assert.equal(document.querySelector("[data-testid='tweetText']").getAttribute("data-xat-translation"), null);
  dom.window.close();
});

test("manual article translation does not fall back to ordinary tweets", async () => {
  const { dom, listeners, sentMessages } = setupDom(
    "https://x.com/openai/status/2071647677591466098",
    `
      <main>
        <article data-testid="tweet">
          <a href="/openai/status/2071647677591466098"><time>刚刚</time></a>
          <div data-testid="tweetText">Ordinary tweet only</div>
        </article>
      </main>
    `,
  );

  await loadContentScript();

  let response;
  listeners.forEach((listener) => listener(
    { type: "XAT_FORCE_TRANSLATE_ARTICLE" },
    null,
    (value) => {
      response = value;
    },
  ));
  await flushMutations();

  assert.deepEqual(response, { ok: false, error: "当前页面未找到 X 长文" });
  assert.equal(sentMessages.some((entry) => entry.type === "XAT_TRANSLATE_TWEET"), false);
  assert.equal(document.querySelector("[data-testid='tweetText']").textContent, "Ordinary tweet only");
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
    text: "Timeline tweet",
    csrfToken: "csrf-token",
    dstLang: "zh",
  });
  dom.window.close();
});
