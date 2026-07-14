// 本测试文件覆盖 X 页面 DOM 处理器的内容识别、自动展开、翻译请求和译文渲染行为。
// 重点保护主帖/评论/长文与引用卡片之间的边界，避免自动翻译误处理嵌套内容。
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import {
  createTweetProcessor,
  extractLongformText,
  extractTweetText,
  findTweetArticles,
  findShowMoreButton,
  findTranslateButton,
  getTweetMetadata,
  renderLongformTranslation,
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

test("does not use role-link quoted card show-more buttons for the main tweet", () => {
  setupDom(`
    <article data-testid="tweet">
      <div role="link">
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

test("extracts only the primary tweet text and ignores quoted cards", () => {
  setupDom(`
    <article data-testid="tweet">
      <div role="link">
        <div data-testid="tweetText">Quoted card text</div>
      </div>
      <div data-testid="card.wrapper">
        <div data-testid="tweetText">Quoted media card text</div>
      </div>
      <div data-testid="tweetText">Main detail comment text</div>
    </article>
  `);

  const tweet = document.querySelector("article");
  assert.equal(extractTweetText(tweet), "Main detail comment text");
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

test("ignores role-link quoted card status anchors when selecting metadata", () => {
  setupDom(`
    <article data-testid="tweet">
      <a role="link" href="/quoted/status/1111111111111111111">
        <time>昨天</time>
        <div data-testid="tweetText">Quoted tweet text</div>
      </a>
      <a href="/openai/status/2071647677591466098"><time>2小时</time></a>
      <div data-testid="tweetText">Main tweet</div>
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

test("replaces only the primary tweet text when quoted text is present", () => {
  setupDom(`
    <article data-testid="tweet">
      <div role="link">
        <div data-testid="tweetText">Quoted card text</div>
      </div>
      <div data-testid="tweetText">Main tweet text</div>
    </article>
  `);

  const tweet = document.querySelector("article");
  const replaced = replaceTweetTextWithTranslation(tweet, "主帖译文");

  assert.equal(replaced.textContent, "主帖译文");
  assert.equal(tweet.querySelector("[role='link'] [data-testid='tweetText']").textContent, "Quoted card text");
  assert.equal(tweet.querySelector("[data-xat-translation]").textContent, "主帖译文");
  assert.equal(tweet.querySelectorAll("[data-xat-translation]").length, 1);
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

test("renders translation status after primary tweet text when quoted text appears first", () => {
  setupDom(`
    <article data-testid="tweet">
      <div role="link">
        <div data-testid="tweetText">Quoted card text</div>
      </div>
      <div data-testid="tweetText">Main tweet text</div>
    </article>
  `);

  const tweet = document.querySelector("article");
  const status = renderTranslationStatus(tweet, "正在获取 X 自带译文...");

  assert.equal(status.parentElement, tweet.querySelectorAll("[data-testid='tweetText']")[1].parentElement);
  assert.equal(status.previousElementSibling.textContent, "Main tweet text");
  assert.equal(tweet.querySelector("[role='link'] [data-xat-status]"), null);
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
      text: "Expanded complete text",
    },
  ]);
  assert.equal(tweet.dataset.xatState, "translated");
  assert.equal(tweet.querySelector("[data-testid='tweetText']").textContent, "展开后的完整译文");
  assert.equal(tweet.querySelector("[data-testid='tweetText']").getAttribute("data-xat-original-text"), "Expanded complete text");
  assert.equal(tweet.querySelector("[data-testid='tweetText']").getAttribute("data-xat-translation"), "1");
  assert.equal(tweet.querySelector("[data-xat-translation-text]"), null);
  assert.equal(tweet.querySelector("[data-xat-status]"), null);
});

test("processor translates detail-page comment articles using their own metadata", async () => {
  setupDom(`
    <main aria-label="时间线：对话">
      <article data-testid="tweet">
        <a href="/author/status/1111111111111111111"><time>1小时前</time></a>
        <div data-testid="tweetText">Main post</div>
      </article>
      <article data-testid="tweet">
        <div role="link">
          <a href="/quoted/status/2222222222222222222"><time>昨天</time></a>
          <div data-testid="tweetText">Quoted comment card</div>
        </div>
        <a href="/reply/status/3333333333333333333"><time>刚刚</time></a>
        <div data-testid="tweetText">Visible reply text</div>
      </article>
    </main>
  `);
  const comment = document.querySelectorAll("article")[1];
  const requests = [];

  const processor = createTweetProcessor({
    wait: async () => {},
    now: () => 1000,
    requestTranslation: async (metadata) => {
      requests.push(metadata);
      return { translation: "可见回复译文" };
    },
  });

  await processor.processTweet(comment);

  assert.deepEqual(requests, [
    {
      id: "3333333333333333333",
      url: "https://x.com/reply/status/3333333333333333333",
      text: "Visible reply text",
    },
  ]);
  assert.equal(comment.querySelector("[data-xat-translation]").textContent, "可见回复译文");
  assert.equal(comment.querySelector("[role='link'] [data-testid='tweetText']").textContent, "Quoted comment card");
});

test("extracts primary X Article longform text in reading order", () => {
  setupDom(`
    <article data-testid="tweet">
      <a href="/writer/status/2071912657133973977"><time>2小时</time></a>
      <div data-testid="twitterArticleReadView">
        <div data-testid="twitter-article-title">Longform title</div>
        <div data-testid="longformRichTextComponent">
          <p>Longform body paragraph</p>
          <p>Second paragraph</p>
        </div>
      </div>
    </article>
  `);

  const tweet = document.querySelector("article");
  assert.equal(extractLongformText(tweet), "Longform title Longform body paragraph Second paragraph");
});

test("finds standalone X Article read views outside tweet articles", () => {
  setupDom(`
    <main>
      <div data-testid="twitterArticleReadView">
        <div data-testid="twitter-article-title">Standalone title</div>
        <div data-testid="longformRichTextComponent">Standalone body</div>
      </div>
    </main>
  `);

  const readView = document.querySelector("[data-testid='twitterArticleReadView']");
  assert.deepEqual(findTweetArticles(document), [readView]);
  assert.deepEqual(findTweetArticles(readView), [readView]);
});

test("processor translates standalone X Article read view using status URL metadata", async () => {
  const dom = setupDom(`
    <main>
      <div data-testid="twitterArticleReadView">
        <div data-testid="twitter-article-title">Standalone title</div>
        <div data-testid="longformRichTextComponent">Standalone body</div>
      </div>
    </main>
  `);
  dom.reconfigure({ url: "https://x.com/0xwhrrari/status/2071337983899271175" });
  const readView = document.querySelector("[data-testid='twitterArticleReadView']");
  const requests = [];

  const processor = createTweetProcessor({
    wait: async () => {},
    now: () => 1000,
    requestTranslation: async (metadata) => {
      requests.push(metadata);
      return { ok: true, translation: "独立长文译文", provider: "tencent" };
    },
  });

  await processor.processTweet(readView);

  assert.deepEqual(requests, [
    {
      id: "2071337983899271175",
      url: "https://x.com/0xwhrrari/status/2071337983899271175",
      contentType: "longform",
      text: "Standalone title Standalone body",
    },
  ]);
  assert.equal(readView.dataset.xatState, "translated");
  assert.equal(readView.parentElement.querySelector("[data-xat-longform-translation]").textContent, "独立长文译文");
});

test("processor requests translation for X Article longform text", async () => {
  setupDom(`
    <article data-testid="tweet">
      <a href="/writer/status/2071912657133973977"><time>2小时</time></a>
      <div data-testid="twitterArticleReadView">
        <div data-testid="twitter-article-title">Longform title</div>
        <div data-testid="longformRichTextComponent">
          <p>Longform body paragraph</p>
        </div>
      </div>
    </article>
  `);
  const tweet = document.querySelector("article");
  const events = [];
  const requests = [];

  const processor = createTweetProcessor({
    wait: async () => {},
    now: () => 1000,
    onEvent: (event, payload) => events.push([event, payload]),
    requestTranslation: async (metadata) => {
      requests.push(metadata);
      return { ok: false, error: "longform-provider-unavailable" };
    },
  });

  await processor.processTweet(tweet);

  assert.deepEqual(requests, [
    {
      id: "2071912657133973977",
      url: "https://x.com/writer/status/2071912657133973977",
      contentType: "longform",
      text: "Longform title Longform body paragraph",
    },
  ]);
  assert.equal(tweet.dataset.xatState, "expanded");
  assert.equal(tweet.querySelector("[data-xat-status]").textContent, "长文暂时没有返回译文：longform-provider-unavailable");
  assert.deepEqual(events.map(([event]) => event), ["translation-requested", "translation-failed"]);
});

test("renders longform translation as a stable block after the article read view", () => {
  setupDom(`
    <article data-testid="tweet">
      <a href="/writer/status/2071912657133973977"><time>2小时</time></a>
      <div data-testid="twitterArticleReadView">
        <div data-testid="twitter-article-title">Longform title</div>
        <div data-testid="longformRichTextComponent">
          <p>Longform body paragraph</p>
        </div>
      </div>
    </article>
  `);

  const tweet = document.querySelector("article");
  const translation = renderLongformTranslation(tweet, "长文译文");

  assert.equal(translation?.getAttribute("data-xat-longform-translation"), "1");
  assert.equal(translation.textContent, "长文译文");
  assert.equal(translation.previousElementSibling?.getAttribute("data-testid"), "twitterArticleReadView");
  assert.equal(translation.getAttribute("data-xat-original-text"), "Longform title Longform body paragraph");
});

test("processor renders returned longform translation without replacing the original read view", async () => {
  setupDom(`
    <article data-testid="tweet">
      <a href="/writer/status/2071912657133973977"><time>2小时</time></a>
      <div data-testid="twitterArticleReadView">
        <div data-testid="twitter-article-title">Longform title</div>
        <div data-testid="longformRichTextComponent">
          <p>Longform body paragraph</p>
        </div>
      </div>
    </article>
  `);
  const tweet = document.querySelector("article");

  const processor = createTweetProcessor({
    wait: async () => {},
    now: () => 1000,
    requestTranslation: async () => ({ ok: true, translation: "第三方长文译文", provider: "tencent" }),
  });

  await processor.processTweet(tweet);

  assert.equal(tweet.dataset.xatState, "translated");
  assert.equal(tweet.dataset.xatTranslatedAt, "1000");
  assert.equal(tweet.querySelector("[data-xat-longform-translation]").textContent, "第三方长文译文");
  assert.equal(tweet.querySelector("[data-testid='twitterArticleReadView'] [data-testid='twitter-article-title']").textContent, "Longform title");
  assert.equal(tweet.querySelector("[data-xat-status]"), null);
});

test("processor explains missing third-party providers for longform translation", async () => {
  setupDom(`
    <article data-testid="tweet">
      <a href="/writer/status/2071912657133973977"><time>2小时</time></a>
      <div data-testid="twitterArticleReadView">
        <div data-testid="twitter-article-title">Longform title</div>
        <div data-testid="longformRichTextComponent">
          <p>Longform body paragraph</p>
        </div>
      </div>
    </article>
  `);
  const tweet = document.querySelector("article");

  const processor = createTweetProcessor({
    wait: async () => {},
    now: () => 1000,
    requestTranslation: async () => ({ ok: false, error: "third-party-provider-unavailable" }),
  });

  await processor.processTweet(tweet);

  assert.equal(tweet.dataset.xatState, "expanded");
  assert.equal(tweet.querySelector("[data-xat-status]").textContent, "配置第三方翻译服务后可翻译长文");
});

test("processor requests only primary longform when a quoted longform appears first", async () => {
  setupDom(`
    <article data-testid="tweet">
      <a href="/writer/status/2071912657133973977"><time>2小时</time></a>
      <div role="link">
        <div data-testid="twitterArticleReadView">
          <div data-testid="twitter-article-title">Quoted longform title</div>
          <div data-testid="longformRichTextComponent">
            <p>Quoted longform body paragraph</p>
          </div>
        </div>
      </div>
      <div data-testid="twitterArticleReadView">
        <div data-testid="twitter-article-title">Primary longform title</div>
        <div data-testid="longformRichTextComponent">
          <p>Primary longform body paragraph</p>
        </div>
      </div>
    </article>
  `);
  const tweet = document.querySelector("article");
  const requests = [];

  const processor = createTweetProcessor({
    wait: async () => {},
    now: () => 1000,
    requestTranslation: async (metadata) => {
      requests.push(metadata);
      return { ok: false, error: "longform-provider-unavailable" };
    },
  });

  await processor.processTweet(tweet);

  assert.deepEqual(requests, [
    {
      id: "2071912657133973977",
      url: "https://x.com/writer/status/2071912657133973977",
      contentType: "longform",
      text: "Primary longform title Primary longform body paragraph",
    },
  ]);
  assert.equal(tweet.dataset.xatState, "expanded");
});

test("processor translates a normal tweet when it quotes an X Article card", async () => {
  setupDom(`
    <article data-testid="tweet">
      <a href="/openai/status/2071647677591466098"><time>2小时</time></a>
      <div data-testid="tweetText">Normal tweet with quoted article</div>
      <div role="link">
        <a href="/writer/status/2071912657133973977"><time>昨天</time></a>
        <div data-testid="twitterArticleReadView">
          <div data-testid="twitter-article-title">Quoted longform title</div>
          <div data-testid="longformRichTextComponent">
            <p>Quoted longform body paragraph</p>
          </div>
        </div>
      </div>
    </article>
  `);
  const tweet = document.querySelector("article");
  const requests = [];
  const events = [];

  const processor = createTweetProcessor({
    wait: async () => {},
    now: () => 1000,
    onEvent: (event, payload) => events.push([event, payload]),
    requestTranslation: async (metadata) => {
      requests.push(metadata);
      return { translation: "带引用长文卡片的普通帖译文" };
    },
  });

  await processor.processTweet(tweet);

  assert.deepEqual(requests, [
    {
      id: "2071647677591466098",
      url: "https://x.com/openai/status/2071647677591466098",
      text: "Normal tweet with quoted article",
    },
  ]);
  assert.equal(tweet.dataset.xatState, "translated");
  assert.equal(tweet.querySelector("[data-xat-translation]").textContent, "带引用长文卡片的普通帖译文");
  assert.equal(tweet.querySelector("[data-xat-status]"), null);
  assert.deepEqual(events.map(([event]) => event), ["translation-requested", "translation-rendered"]);
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
    text: "First tweet",
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

test("allows X status detail pages while rejecting unsupported hosts and direct article pages", () => {
  assert.equal(shouldProcessTimelinePage("https://x.com/openai/status/2071647677591466098"), true);
  assert.equal(shouldProcessTimelinePage("https://twitter.com/openai/status/2071647677591466098"), true);
  assert.equal(shouldProcessTimelinePage("https://x.com/home"), true);
  assert.equal(shouldProcessTimelinePage("https://x.com/search?q=codex"), true);
  assert.equal(shouldProcessTimelinePage("https://x.com/i/article/2071912379319787520"), false);
  assert.equal(shouldProcessTimelinePage("https://example.com/openai/status/2071647677591466098"), false);
});
