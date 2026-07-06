import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import {
  createTweetProcessor,
  extractTweetText,
  findShowMoreButton,
  findTranslateButton,
  getTweetMetadata,
  replaceTweetTextWithTranslation,
  renderTranslationStatus,
  shouldProcessTimelinePage,
} from "../src/tweetProcessor.js";

function setupDom(html) {
  const dom = new JSDOM(html, { url: "https://x.com/home" });
  globalThis.document = dom.window.document;
  globalThis.Node = dom.window.Node;
  globalThis.HTMLElement = dom.window.HTMLElement;
  return dom;
}

test("finds the X show-more button by data-testid inside a tweet", () => {
  setupDom(`
    <article data-testid="tweet">
      <div data-testid="tweetText">Short text</div>
      <button data-testid="tweet-text-show-more-link"><span>显示更多</span></button>
    </article>
  `);

  const tweet = document.querySelector("article");
  assert.equal(findShowMoreButton(tweet)?.textContent.trim(), "显示更多");
});

test("does not treat reply expansion controls as tweet text show-more buttons", () => {
  setupDom(`
    <article data-testid="tweet">
      <button role="button"><span>显示更多回复</span></button>
      <button data-testid="tweet-text-show-more-link"><span>显示更多</span></button>
    </article>
  `);

  const tweet = document.querySelector("article");
  assert.equal(findShowMoreButton(tweet)?.getAttribute("data-testid"), "tweet-text-show-more-link");
});

test("does not use quoted card show-more buttons for the main tweet", () => {
  setupDom(`
    <article data-testid="tweet">
      <div data-testid="card.wrapper">
        <button data-testid="tweet-text-show-more-link" data-target="quoted"><span>显示更多</span></button>
      </div>
      <div data-testid="tweetText">Main folded text</div>
      <button data-testid="tweet-text-show-more-link" data-target="main"><span>显示更多</span></button>
    </article>
  `);

  const tweet = document.querySelector("article");
  assert.equal(findShowMoreButton(tweet)?.getAttribute("data-target"), "main");
});

test("extracts full tweet text from data-testid tweetText after expansion", () => {
  setupDom(`
    <article data-testid="tweet">
      <div data-testid="tweetText">
        <span>Hello</span>
        <span> world</span>
      </div>
    </article>
  `);

  const tweet = document.querySelector("article");
  assert.equal(extractTweetText(tweet), "Hello world");
});

test("normalizes CJK spacing introduced by nested tweet text nodes", () => {
  setupDom(`
    <article data-testid="tweet">
      <div data-testid="tweetText">
        <span>你好，</span>
        <span>世界</span>
        <span>。</span>
      </div>
    </article>
  `);

  const tweet = document.querySelector("article");
  assert.equal(extractTweetText(tweet), "你好，世界。");
});

test("finds a visible translate control by localized text", () => {
  setupDom(`
    <article data-testid="tweet">
      <div role="button">
        <span><span>显示翻译</span></span>
      </div>
    </article>
  `);

  const tweet = document.querySelector("article");
  assert.equal(findTranslateButton(tweet)?.textContent.trim(), "显示翻译");
});

test("prefers interactive ancestors when translate text is nested in spans", () => {
  setupDom(`
    <article data-testid="tweet">
      <div role="button" data-click-target="translate">
        <span class="css-1jxf684"><span>显示翻译</span></span>
      </div>
    </article>
  `);

  const tweet = document.querySelector("article");
  assert.equal(findTranslateButton(tweet)?.getAttribute("data-click-target"), "translate");
});

test("does not treat plain tweet text containing translate words as a translate control", () => {
  setupDom(`
    <article data-testid="tweet">
      <div data-testid="tweetText">
        <span>这里有几个字：显示翻译，但它是正文。</span>
      </div>
    </article>
  `);

  const tweet = document.querySelector("article");
  assert.equal(findTranslateButton(tweet), null);
});

test("does not treat an interactive tweet text wrapper as a translate control", () => {
  setupDom(`
    <article data-testid="tweet">
      <div role="button" data-click-target="body">
        <div data-testid="tweetText"><span>显示翻译</span></div>
      </div>
    </article>
  `);

  const tweet = document.querySelector("article");
  assert.equal(findTranslateButton(tweet), null);
});

test("processor expands before translating and marks tweets once", async () => {
  const dom = setupDom(`
    <article data-testid="tweet">
      <div data-testid="tweetText">Folded</div>
      <button data-testid="tweet-text-show-more-link">显示更多</button>
      <div role="button" data-click-target="translate"><span>显示翻译</span></div>
    </article>
  `);
  const tweet = document.querySelector("article");
  const events = [];
  const showMore = findShowMoreButton(tweet);
  const translate = findTranslateButton(tweet);
  showMore.click = () => {
    events.push("expand");
    document.querySelector("[data-testid='tweetText']").textContent = "Expanded complete text";
  };
  translate.click = () => events.push("translate");

  const processor = createTweetProcessor({
    wait: async () => {},
    now: () => 1000,
  });

  await processor.processTweet(tweet);
  await processor.processTweet(tweet);

  assert.deepEqual(events, ["expand", "translate"]);
  assert.equal(tweet.dataset.xatState, "translated");
  assert.equal(extractTweetText(tweet), "Expanded complete text");
  dom.window.close();
});

test("extracts tweet id and status URL from tweet links", () => {
  setupDom(`
    <article data-testid="tweet">
      <a href="/openai/status/2071647677591466098">time</a>
      <div data-testid="tweetText">Hello</div>
    </article>
  `);

  const tweet = document.querySelector("article");
  assert.deepEqual(getTweetMetadata(tweet), {
    id: "2071647677591466098",
    url: "https://x.com/openai/status/2071647677591466098",
  });
});

test("prefers the timestamp status link and normalizes analytics suffixes", () => {
  setupDom(`
    <article data-testid="tweet">
      <a href="/quoted/status/1111111111111111111">quoted preview</a>
      <a href="/openai/status/2071647677591466098/analytics">25万</a>
      <a href="/openai/status/2071647677591466098"><time>2小时</time></a>
      <div data-testid="tweetText">Hello</div>
    </article>
  `);

  const tweet = document.querySelector("article");
  assert.deepEqual(getTweetMetadata(tweet), {
    id: "2071647677591466098",
    url: "https://x.com/openai/status/2071647677591466098",
  });
});

test("ignores quoted tweet timestamp links when selecting metadata", () => {
  setupDom(`
    <article data-testid="tweet">
      <div data-testid="tweetText">Main tweet</div>
      <div role="link">
        <a href="/quoted/status/1111111111111111111"><time>昨天</time></a>
        <div data-testid="tweetText">Quoted tweet text</div>
      </div>
      <a href="/openai/status/2071647677591466098"><time>2小时</time></a>
    </article>
  `);

  const tweet = document.querySelector("article");
  assert.deepEqual(getTweetMetadata(tweet), {
    id: "2071647677591466098",
    url: "https://x.com/openai/status/2071647677591466098",
  });
});

test("replaces tweet text with a returned translation once", () => {
  setupDom(`
    <article data-testid="tweet">
      <div data-testid="tweetText">Hello world</div>
    </article>
  `);

  const tweet = document.querySelector("article");
  replaceTweetTextWithTranslation(tweet, "你好，世界");
  replaceTweetTextWithTranslation(tweet, "再次更新的译文");

  const tweetText = tweet.querySelector("[data-testid='tweetText']");
  assert.equal(tweetText.textContent, "再次更新的译文");
  assert.equal(tweetText.getAttribute("data-xat-original-text"), "Hello world");
  assert.equal(tweetText.getAttribute("data-xat-translation"), "1");
  assert.equal(tweet.querySelectorAll("[data-xat-translation]").length, 1);
  assert.equal(tweet.querySelector("[data-xat-translation-text]"), null);
});

test("renders and replaces translation status messages", () => {
  setupDom(`
    <article data-testid="tweet">
      <div data-testid="tweetText">Hello world</div>
    </article>
  `);

  const tweet = document.querySelector("article");
  renderTranslationStatus(tweet, "正在获取 X 自带译文...");
  renderTranslationStatus(tweet, "X 暂时没有返回译文");

  const statuses = tweet.querySelectorAll("[data-xat-status]");
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].textContent, "X 暂时没有返回译文");
});

test("processor requests direct API translation after expansion and replaces tweet text", async () => {
  setupDom(`
    <article data-testid="tweet">
      <a href="/openai/status/2071647677591466098">time</a>
      <div data-testid="tweetText">Folded</div>
      <button data-testid="tweet-text-show-more-link">显示更多</button>
    </article>
  `);
  const tweet = document.querySelector("article");
  const showMore = findShowMoreButton(tweet);
  const requests = [];
  showMore.click = () => {
    document.querySelector("[data-testid='tweetText']").textContent = "Expanded complete text";
  };

  const processor = createTweetProcessor({
    wait: async () => {},
    now: () => 1000,
    requestTranslation: async (metadata) => {
      requests.push(metadata);
      return { translation: "展开后的完整译文" };
    },
  });

  await processor.processTweet(tweet);

  assert.deepEqual(requests, [
    {
      id: "2071647677591466098",
      url: "https://x.com/openai/status/2071647677591466098",
    },
  ]);
  assert.equal(tweet.dataset.xatState, "translated");
  assert.equal(tweet.querySelector("[data-testid='tweetText']").textContent, "展开后的完整译文");
  assert.equal(tweet.querySelector("[data-testid='tweetText']").getAttribute("data-xat-original-text"), "Expanded complete text");
  assert.equal(tweet.querySelector("[data-testid='tweetText']").getAttribute("data-xat-translation"), "1");
  assert.equal(tweet.querySelector("[data-xat-translation-text]"), null);
  assert.equal(tweet.querySelector("[data-xat-status]"), null);
});

test("processor retries the current tweet after X reuses the article", async () => {
  setupDom(`
    <article data-testid="tweet">
      <a data-status href="/openai/status/1111111111111111111">time</a>
      <div data-testid="tweetText">First tweet</div>
    </article>
  `);
  const tweet = document.querySelector("article");
  let resolveTranslation;
  const translationReady = new Promise((resolve) => {
    resolveTranslation = resolve;
  });
  let resolveRequested;
  const requested = new Promise((resolve) => {
    resolveRequested = resolve;
  });
  const requests = [];

  const processor = createTweetProcessor({
    wait: async () => {},
    now: () => 1000,
    requestTranslation: async (metadata) => {
      requests.push(metadata);
      if (metadata.id === "1111111111111111111") {
        resolveRequested(metadata);
        return translationReady;
      }
      return { translation: "第二条的译文" };
    },
  });

  const processing = processor.processTweet(tweet);
  assert.deepEqual(await requested, {
    id: "1111111111111111111",
    url: "https://x.com/openai/status/1111111111111111111",
  });
  tweet.querySelector("[data-status]").setAttribute("href", "/openai/status/2222222222222222222");
  tweet.querySelector("[data-testid='tweetText']").textContent = "Second tweet";
  resolveTranslation({ translation: "第一条的译文" });
  await processing;

  assert.deepEqual(requests.map((request) => request.id), [
    "1111111111111111111",
    "2222222222222222222",
  ]);
  assert.equal(tweet.querySelector("[data-testid='tweetText']").textContent, "第二条的译文");
  assert.equal(tweet.querySelector("[data-testid='tweetText']").getAttribute("data-xat-original-text"), "Second tweet");
  assert.equal(tweet.querySelector("[data-xat-status]"), null);
  assert.equal(tweet.dataset.xatState, "translated");
});

test("processor silently skips tweets when X has no translation control", async () => {
  setupDom(`
    <article data-testid="tweet">
      <a href="/openai/status/2071647677591466098">time</a>
      <div data-testid="tweetText">中文正文</div>
    </article>
  `);
  const tweet = document.querySelector("article");
  const events = [];

  const processor = createTweetProcessor({
    wait: async () => {},
    now: () => 1000,
    onEvent: (event, payload) => events.push([event, payload]),
    requestTranslation: async () => ({ ok: false, skipped: true, error: "translate-button-not-found" }),
  });

  await processor.processTweet(tweet);
  await processor.processTweet(tweet);

  assert.equal(tweet.dataset.xatState, "skipped");
  assert.equal(tweet.querySelector("[data-xat-status]"), null);
  assert.equal(tweet.querySelector("[data-xat-translation]"), null);
  assert.deepEqual(events.map(([event]) => event), ["translation-requested"]);
});

test("skips X status detail pages to avoid recursive background translation tabs", () => {
  assert.equal(shouldProcessTimelinePage("https://x.com/openai/status/2071647677591466098"), false);
  assert.equal(shouldProcessTimelinePage("https://twitter.com/openai/status/2071647677591466098"), false);
  assert.equal(shouldProcessTimelinePage("https://x.com/home"), true);
  assert.equal(shouldProcessTimelinePage("https://x.com/search?q=codex"), true);
});
