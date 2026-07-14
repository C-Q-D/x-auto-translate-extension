// 本测试文件覆盖 X 页面 DOM 处理器的内容识别、自动展开、翻译请求和译文渲染行为。
// 重点保护主帖/评论/长文与引用卡片之间的边界，避免自动翻译误处理嵌套内容。
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import {
  createTweetProcessor,
  extractLongformText,
  extractTweetText,
  findLongformTextBlocks,
  findProcessTargetFromNode,
  findTweetArticles,
  findShowMoreButton,
  findTranslateButton,
  findXArticleTargets,
  getTweetMetadata,
  isLongformTranslationComplete,
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

test("finds only primary X Article targets and ignores ordinary tweets with quoted article cards", () => {
  setupDom(`
    <main>
      <article data-testid="tweet">
        <a href="/openai/status/2071647677591466098"><time>刚刚</time></a>
        <div data-testid="tweetText">Normal tweet with quoted article</div>
        <div role="link">
          <div data-testid="twitterArticleReadView">
            <div data-testid="longformRichTextComponent">Quoted article body</div>
          </div>
        </div>
      </article>
      <div data-testid="twitterArticleRichTextView">
        <div data-testid="longformRichTextComponent">Standalone article body</div>
      </div>
    </main>
  `);

  const standaloneArticle = document.querySelector("[data-testid='twitterArticleRichTextView']");
  assert.deepEqual(findXArticleTargets(document), [standaloneArticle]);
});

test("processor translates standalone X Article rich text view using status URL metadata", async () => {
  const dom = setupDom(`
    <main>
      <span class="css-1jxf684 r-bcqeeo r-1ttztb7 r-qvutc0 r-poiln3">How I Use Claude Cowork to Run Like a One-Person Company</span>
      <div data-testid="twitterArticleRichTextView">
        <div class="DraftEditor-root">
          <div data-testid="longformRichTextComponent" contenteditable="false">
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
      </div>
    </main>
  `);
  dom.reconfigure({ url: "https://x.com/0xwhrrari/status/2071337983899271175" });
  const readView = document.querySelector("[data-testid='twitterArticleRichTextView']");
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
      text: "How I Use Claude Cowork to Run Like a One-Person Company",
    },
    {
      id: "2071337983899271175",
      url: "https://x.com/0xwhrrari/status/2071337983899271175",
      contentType: "longform",
      text: "Emails. Reports. Formatting.",
    },
    {
      id: "2071337983899271175",
      url: "https://x.com/0xwhrrari/status/2071337983899271175",
      contentType: "longform",
      text: "Most knowledge workers spend time on necessary work.",
    },
  ]);
  assert.equal(readView.dataset.xatState, "translated");
  assert.equal(document.querySelectorAll("[data-xat-longform-block-translation='1']").length, 3);
  assert.equal(document.querySelector("[data-xat-longform-translation]"), null);
});

test("processor waits for standalone X Article rich text body before requesting translation", async () => {
  const dom = setupDom(`
    <main>
      <div data-testid="twitterArticleRichTextView">
        <div class="DraftEditor-root">
          <div data-testid="longformRichTextComponent" contenteditable="false"></div>
        </div>
      </div>
    </main>
  `);
  dom.reconfigure({ url: "https://x.com/0xwhrrari/status/2071337983899271175" });
  const readView = document.querySelector("[data-testid='twitterArticleRichTextView']");
  const body = document.querySelector("[data-testid='longformRichTextComponent']");
  const requests = [];
  const events = [];
  let now = 1000;

  const processor = createTweetProcessor({
    wait: async () => {},
    now: () => now,
    onEvent: (event, payload) => events.push([event, payload]),
    requestTranslation: async (metadata) => {
      requests.push(metadata);
      return { ok: true, translation: "正文加载后的译文", provider: "tencent" };
    },
  });

  await processor.processTweet(readView);

  assert.deepEqual(requests, []);
  assert.equal(readView.dataset.xatState, "expanded");
  assert.equal(readView.parentElement.querySelector("[data-xat-status]").textContent, "正在等待长文正文加载...");
  assert.deepEqual(events.map(([event]) => event), ["translation-waiting-content"]);

  body.innerHTML = `
    <div data-contents="true">
      <div class="longform-unstyled" data-block="true">
        <span data-text="true">Hydrated article body.</span>
      </div>
    </div>
  `;
  delete readView.dataset.xatLastAttempt;
  now = 9000;
  await processor.processTweet(readView);

  assert.deepEqual(requests, [
    {
      id: "2071337983899271175",
      url: "https://x.com/0xwhrrari/status/2071337983899271175",
      contentType: "longform",
      text: "Hydrated article body.",
    },
  ]);
  assert.equal(readView.dataset.xatState, "translated");
  assert.equal(body.textContent.trim(), "正文加载后的译文");
  assert.equal(body.querySelector("[data-text='true']").getAttribute("data-xat-longform-block-translation"), "1");
});

test("maps rich text mutations inside standalone X Article back to the article read view", () => {
  setupDom(`
    <main>
      <div data-testid="twitterArticleRichTextView">
        <div data-testid="longformRichTextComponent">
          <span data-text="true">Hydrated article body.</span>
        </div>
      </div>
    </main>
  `);

  const readView = document.querySelector("[data-testid='twitterArticleRichTextView']");
  const textNode = document.querySelector("[data-text='true']");
  assert.equal(findProcessTargetFromNode(textNode), readView);
  assert.equal(findProcessTargetFromNode(textNode.firstChild), readView);
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
      text: "Longform title",
    },
    {
      id: "2071912657133973977",
      url: "https://x.com/writer/status/2071912657133973977",
      contentType: "longform",
      text: "Longform body paragraph",
    },
  ]);
  assert.equal(tweet.dataset.xatState, "expanded");
  assert.equal(
    tweet.querySelector("[data-xat-status]").textContent,
    "长文已翻译 0/2 个内容节点，2 个暂未完成：longform-provider-unavailable",
  );
  assert.deepEqual(events.map(([event]) => event), ["translation-requested", "translation-failed"]);
});

test("finds X Article text nodes in reading order and skips markdown code blocks", () => {
  setupDom(`
    <article data-testid="tweet">
      <a href="/writer/status/2071912657133973977"><time>2小时</time></a>
      <div data-testid="twitterArticleReadView">
        <div data-testid="twitter-article-title"><span>Longform title</span></div>
        <div data-testid="twitterArticleRichTextView">
          <div data-testid="longformRichTextComponent">
            <div data-contents="true">
              <div class="longform-unstyled" data-block="true">
                <div class="public-DraftStyleDefault-block">
                  <span data-text="true">First paragraph with </span>
                  <a href="https://example.com"><span data-text="true">a link</span></a>
                </div>
              </div>
              <ul class="public-DraftStyleDefault-ul">
                <li class="longform-unordered-list-item" data-block="true">
                  <span data-text="true">List item</span>
                </li>
              </ul>
              <section data-block="true" contenteditable="false">
                <div data-testid="markdown-code-block">
                  <button>复制到剪贴板</button>
                  <pre><code><span data-text="true">Code sample</span></code></pre>
                </div>
              </section>
              <section data-block="true"><div role="separator"></div></section>
            </div>
          </div>
        </div>
      </div>
    </article>
  `);

  const tweet = document.querySelector("article");
  const blocks = findLongformTextBlocks(tweet);

  assert.deepEqual(blocks.map((block) => block.text), [
    "Longform title",
    "First paragraph with",
    "a link",
    "List item",
  ]);
  assert.deepEqual(blocks.map((block) => block.kind), ["title", "body", "body", "body"]);
});

test("translates prose beside a markdown code block without collecting code descendants", () => {
  setupDom(`
    <main>
      <div data-testid="twitterArticleRichTextView">
        <div data-testid="longformRichTextComponent">
          <div>
            <p><span data-text="true">Prose beside code</span></p>
            <div data-block="true" data-testid="markdown-code-block">
              <button>复制到剪贴板</button>
              <pre><code><span data-text="true">const answer = 42;</span></code></pre>
            </div>
          </div>
        </div>
      </div>
    </main>
  `);

  const blocks = findLongformTextBlocks(document.querySelector("[data-testid='twitterArticleRichTextView']"));

  assert.deepEqual(blocks.map((block) => block.text), ["Prose beside code"]);
});

test("uses only non-interactive leaf elements when longform data-text markers are absent", async () => {
  const dom = setupDom(`
    <main>
      <div data-testid="twitterArticleRichTextView">
        <div data-testid="longformRichTextComponent">
          <div data-block="true">
            <p>Plain paragraph</p>
            <a href="https://example.com/plain">Plain link</a>
            <button>Copy article</button>
          </div>
        </div>
      </div>
    </main>
  `);
  dom.reconfigure({ url: "https://x.com/writer/status/2071912657133973977" });
  const readView = document.querySelector("[data-testid='twitterArticleRichTextView']");
  const requests = [];
  const processor = createTweetProcessor({
    wait: async () => {},
    now: () => 1000,
    requestTranslation: async ({ text }) => {
      requests.push(text);
      return { ok: true, translation: `${text} translated`, provider: "tencent" };
    },
  });

  await processor.processTweet(readView);

  assert.deepEqual(requests, ["Plain paragraph", "Plain link"]);
  assert.equal(readView.querySelector("p").textContent, "Plain paragraph translated");
  assert.equal(readView.querySelector("a").textContent, "Plain link translated");
  assert.equal(readView.querySelector("a").getAttribute("href"), "https://example.com/plain");
  assert.equal(readView.querySelector("button").textContent, "Copy article");
});

test("wraps and translates bare inline text around a link without removing the link", async () => {
  const dom = setupDom(`
    <main>
      <div data-testid="twitterArticleRichTextView">
        <div data-testid="longformRichTextComponent">
          <p>Read <a href="https://example.com/docs">the docs</a> before continuing</p>
        </div>
      </div>
    </main>
  `);
  dom.reconfigure({ url: "https://x.com/writer/status/2071912657133973977" });
  const readView = document.querySelector("[data-testid='twitterArticleRichTextView']");
  const requests = [];
  const processor = createTweetProcessor({
    wait: async () => {},
    now: () => 1000,
    requestTranslation: async ({ text }) => {
      requests.push(text);
      return { ok: true, translation: `[${text}]`, provider: "tencent" };
    },
  });

  await processor.processTweet(readView);

  assert.deepEqual(requests, ["Read", "the docs", "before continuing"]);
  assert.equal(readView.querySelector("a").getAttribute("href"), "https://example.com/docs");
  assert.equal(readView.querySelector("a").textContent, "[the docs]");
  assert.equal(readView.querySelector("p").textContent.replace(/\s+/g, " ").trim(), "[Read] [the docs] [before continuing]");
  assert.equal(readView.dataset.xatState, "translated");
});

test("processor replaces each X Article block in place without creating an aggregate translation", async () => {
  setupDom(`
    <article data-testid="tweet">
      <a href="/writer/status/2071912657133973977"><time>2小时</time></a>
      <div data-testid="twitterArticleReadView">
        <div data-testid="twitter-article-title"><span>Longform title</span></div>
        <div data-testid="longformRichTextComponent">
          <div data-contents="true">
            <div class="longform-unstyled" data-block="true">
              <div class="public-DraftStyleDefault-block">
                <span data-text="true">First paragraph with </span>
                <a href="https://example.com"><span data-text="true">a link</span></a>
              </div>
            </div>
            <ul class="public-DraftStyleDefault-ul">
              <li class="longform-unordered-list-item" data-block="true">
                <span data-text="true">List item</span>
              </li>
            </ul>
            <section data-block="true" contenteditable="false">
              <div data-testid="markdown-code-block">
                <button>复制到剪贴板</button>
                <pre><code><span data-text="true">Code sample</span></code></pre>
              </div>
            </section>
          </div>
        </div>
      </div>
    </article>
  `);
  const tweet = document.querySelector("article");
  const translations = new Map([
    ["Longform title", "长文标题"],
    ["First paragraph with", "第一段包含"],
    ["a link", "一个链接"],
    ["List item", "列表项"],
  ]);
  const requests = [];

  const processor = createTweetProcessor({
    wait: async () => {},
    now: () => 1000,
    requestTranslation: async (payload) => {
      requests.push(payload);
      return { ok: true, translation: translations.get(payload.text), provider: "tencent" };
    },
  });

  await processor.processTweet(tweet);

  assert.deepEqual(requests.map((request) => request.text), [
    "Longform title",
    "First paragraph with",
    "a link",
    "List item",
  ]);
  assert.equal(tweet.dataset.xatState, "translated");
  assert.equal(tweet.dataset.xatTranslatedAt, "1000");
  assert.equal(tweet.querySelector("[data-testid='twitter-article-title']").textContent, "长文标题");
  assert.equal(
    tweet.querySelector(".public-DraftStyleDefault-block").textContent.replace(/\s+/g, " ").trim(),
    "第一段包含 一个链接",
  );
  assert.equal(tweet.querySelector(".public-DraftStyleDefault-block a").getAttribute("href"), "https://example.com");
  assert.equal(tweet.querySelector(".public-DraftStyleDefault-block a").textContent, "一个链接");
  assert.equal(tweet.querySelector("ul").children.length, 1);
  assert.equal(tweet.querySelector("li").textContent.trim(), "列表项");
  assert.equal(tweet.querySelector("[data-testid='markdown-code-block'] code").textContent, "Code sample");
  assert.ok(tweet.querySelector("[data-testid='markdown-code-block'] button"));
  assert.equal(
    tweet.querySelector("[data-testid='markdown-code-block'] [data-xat-longform-block-translation='1']"),
    null,
  );
  assert.equal(tweet.querySelector("[data-xat-longform-translation]"), null);
  assert.equal(tweet.querySelectorAll("[data-xat-longform-block-translation='1']").length, 4);
  assert.equal(isLongformTranslationComplete(tweet), true);
  assert.equal(tweet.querySelector("[data-xat-status]"), null);
});

test("processor renders each X Article block as soon as that block translation resolves", async () => {
  setupDom(`
    <article data-testid="tweet">
      <a href="/writer/status/2071912657133973977"><time>2小时</time></a>
      <div data-testid="twitterArticleReadView">
        <div data-testid="twitter-article-title">Longform title</div>
        <div data-testid="longformRichTextComponent">
          <div data-block="true">Body paragraph</div>
        </div>
      </div>
    </article>
  `);
  const tweet = document.querySelector("article");
  const resolvers = new Map();
  const processor = createTweetProcessor({
    wait: async () => {},
    now: () => 1000,
    requestTranslation: (payload) => new Promise((resolve) => resolvers.set(payload.text, resolve)),
  });

  const processing = processor.processTweet(tweet);
  await new Promise((resolve) => setImmediate(resolve));
  resolvers.get("Body paragraph")({ ok: true, translation: "正文译文", provider: "tencent" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(tweet.querySelector("[data-block='true']").textContent, "正文译文");
  assert.equal(tweet.querySelector("[data-testid='twitter-article-title']").textContent, "Longform title");
  assert.equal(tweet.dataset.xatState, "processing");

  resolvers.get("Longform title")({ ok: true, translation: "标题译文", provider: "tencent" });
  await processing;

  assert.equal(tweet.querySelector("[data-testid='twitter-article-title']").textContent, "标题译文");
  assert.equal(tweet.dataset.xatState, "translated");
});

test("processor discards a stale block result and retranslates the hydrated source text", async () => {
  setupDom(`
    <article data-testid="tweet">
      <a href="/writer/status/2071912657133973977"><time>2小时</time></a>
      <div data-testid="twitterArticleReadView">
        <div data-testid="longformRichTextComponent">
          <div data-block="true"><span data-text="true">Original paragraph</span></div>
        </div>
      </div>
    </article>
  `);
  const tweet = document.querySelector("article");
  const textNode = tweet.querySelector("[data-text='true']");
  const requests = [];
  let resolveOriginal;
  let markOriginalRequested;
  const originalRequested = new Promise((resolve) => {
    markOriginalRequested = resolve;
  });
  const processor = createTweetProcessor({
    longformConcurrency: 1,
    longformRequestIntervalMs: 0,
    wait: async () => {},
    now: () => 1000,
    requestTranslation: ({ text }) => {
      requests.push(text);
      if (text === "Original paragraph") {
        markOriginalRequested();
        return new Promise((resolve) => {
          resolveOriginal = resolve;
        });
      }
      return Promise.resolve({ ok: true, translation: "Hydrated translation", provider: "tencent" });
    },
  });

  const processing = processor.processTweet(tweet);
  await originalRequested;
  textNode.textContent = "Hydrated paragraph";
  resolveOriginal({ ok: true, translation: "Stale translation", provider: "tencent" });
  await processing;

  assert.deepEqual(requests, ["Original paragraph", "Hydrated paragraph"]);
  assert.equal(textNode.textContent, "Hydrated translation");
  assert.equal(textNode.getAttribute("data-xat-original-text"), "Hydrated paragraph");
  assert.equal(tweet.dataset.xatState, "translated");
});

test("processor retries a rate-limited X Article block with bounded backoff", async () => {
  const dom = setupDom(`
    <main>
      <div data-testid="twitterArticleRichTextView">
        <div data-testid="longformRichTextComponent">
          <div data-block="true">Rate limited paragraph</div>
        </div>
      </div>
    </main>
  `);
  dom.reconfigure({ url: "https://x.com/writer/status/2071912657133973977" });
  const readView = document.querySelector("[data-testid='twitterArticleRichTextView']");
  const waits = [];
  let attempts = 0;
  const processor = createTweetProcessor({
    longformRequestIntervalMs: 0,
    longformRetries: 2,
    longformRetryDelayMs: 1000,
    wait: async (ms) => waits.push(ms),
    now: () => 1000,
    requestTranslation: async () => {
      attempts += 1;
      if (attempts === 1) {
        return { ok: false, error: "tencent-rate-limited", retryable: true };
      }
      return { ok: true, translation: "限流重试后的译文", provider: "tencent" };
    },
  });

  await processor.processTweet(readView);

  assert.equal(attempts, 2);
  assert.deepEqual(waits, [1000]);
  assert.equal(document.querySelector("[data-block='true']").textContent, "限流重试后的译文");
  assert.equal(readView.dataset.xatState, "translated");
});

test("processor retries only X Article blocks that failed previously", async () => {
  setupDom(`
    <article data-testid="tweet">
      <a href="/writer/status/2071912657133973977"><time>2小时</time></a>
      <div data-testid="twitterArticleReadView">
        <div data-testid="twitter-article-title">Longform title</div>
        <div data-testid="longformRichTextComponent">
          <div data-block="true">Body paragraph</div>
        </div>
      </div>
    </article>
  `);
  const tweet = document.querySelector("article");
  const requests = [];
  let bodyAttempts = 0;
  const processor = createTweetProcessor({
    wait: async () => {},
    now: () => 1000,
    requestTranslation: async (payload) => {
      requests.push(payload.text);
      if (payload.text === "Body paragraph" && bodyAttempts++ === 0) {
        return { ok: false, error: "tencent-temporary-failure" };
      }
      return { ok: true, translation: `${payload.text} translated`, provider: "tencent" };
    },
  });

  await processor.processTweet(tweet);

  assert.equal(tweet.dataset.xatState, "expanded");
  assert.equal(tweet.querySelector("[data-testid='twitter-article-title']").textContent, "Longform title translated");
  assert.equal(tweet.querySelector("[data-block='true']").textContent, "Body paragraph");
  assert.equal(isLongformTranslationComplete(tweet), false);

  delete tweet.dataset.xatState;
  delete tweet.dataset.xatLastAttempt;
  await processor.processTweet(tweet);

  assert.deepEqual(requests, ["Longform title", "Body paragraph", "Body paragraph"]);
  assert.equal(tweet.querySelector("[data-block='true']").textContent, "Body paragraph translated");
  assert.equal(tweet.dataset.xatState, "translated");
  assert.equal(isLongformTranslationComplete(tweet), true);
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
      text: "Primary longform title",
    },
    {
      id: "2071912657133973977",
      url: "https://x.com/writer/status/2071912657133973977",
      contentType: "longform",
      text: "Primary longform body paragraph",
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
