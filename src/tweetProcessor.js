// 本文件负责识别 X 页面里的帖子、评论和长文正文，并把可翻译内容交给后台翻译管线。
// 这里的 DOM 选择器需要尽量收窄到当前 article，避免把引用卡片或推荐内容误当成主内容。
const SHOW_MORE_SELECTOR = 'button[data-testid="tweet-text-show-more-link"]';
const TWEET_TEXT_SELECTOR = '[data-testid="tweetText"]';
const CARD_WRAPPER_SELECTOR = '[data-testid="card.wrapper"]';
const LONGFORM_READ_VIEW_SELECTOR = '[data-testid="twitterArticleReadView"], [data-testid="twitterArticleRichTextView"]';
const LONGFORM_TITLE_SELECTOR = '[data-testid="twitter-article-title"]';
const LONGFORM_BODY_SELECTOR = '[data-testid="longformRichTextComponent"]';
const INTERACTIVE_SELECTOR = 'button, [role="button"], a[href], [tabindex]:not([tabindex="-1"])';
const LONGFORM_CONTENT_TYPE = "longform";

const TRANSLATE_LABELS = [
  "显示翻译",
  "翻译帖子",
  "查看翻译",
  "Translate post",
  "Translate Tweet",
  "Show translation",
  "Translate",
];

const DEFAULT_OPTIONS = {
  autoExpand: true,
  autoTranslate: true,
  expandDelayMs: 500,
  translateInitialDelayMs: 250,
  translateRetryDelayMs: 700,
  translateRetries: 5,
  retryCooldownMs: 7000,
};

const STATUS_URL_PATTERN = /\/([^/?#]+)\/status\/(\d+)/;

function normalizeText(text) {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, "$1$2")
    .replace(/([，。！？；：、])\s+/g, "$1")
    .replace(/\s+([，。！？；：、,.!?;:%])/g, "$1");
}

function textOf(element) {
  return normalizeText(element?.innerText || element?.textContent || "");
}

function isVisible(element) {
  if (!element) {
    return false;
  }

  const style = element.ownerDocument?.defaultView?.getComputedStyle?.(element);
  if (style && (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")) {
    return false;
  }

  return !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true";
}

function isDisabled(element) {
  return element?.disabled || element?.getAttribute("aria-disabled") === "true";
}

function hasTranslateLabel(text) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return TRANSLATE_LABELS.some((label) => normalized === label);
}

function closestWithin(element, selector, root) {
  let current = element;
  while (current && current !== root.parentElement) {
    if (current.matches?.(selector)) {
      return current;
    }
    if (current === root) {
      break;
    }
    current = current.parentElement;
  }
  return null;
}

export function findTweetArticles(root = document) {
  const tweets = Array.from(root.querySelectorAll?.('article[data-testid="tweet"]') || []);
  const longformRoots = [
    ...(root.matches?.(LONGFORM_READ_VIEW_SELECTOR) ? [root] : []),
    ...Array.from(root.querySelectorAll?.(LONGFORM_READ_VIEW_SELECTOR) || []),
  ];
  const standaloneLongforms = longformRoots
    .filter((readView) => !readView.closest?.('article[data-testid="tweet"]'));
  return [...tweets, ...standaloneLongforms];
}

export function shouldProcessTimelinePage(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "x.com" && parsed.hostname !== "twitter.com") {
      return false;
    }
    return !/^\/i\/article\/\d+/.test(parsed.pathname);
  } catch {
    return false;
  }
}

function isInsideExcludedTweetContent(element, tweet) {
  const excludedContainer = element?.closest?.(`${CARD_WRAPPER_SELECTOR}, [role="link"]`);
  return Boolean(excludedContainer && excludedContainer !== tweet && tweet?.contains?.(excludedContainer));
}

function isEmbeddedStatusLink(link, tweet) {
  if (link?.closest?.('article[data-testid="tweet"]') !== tweet) {
    return true;
  }

  const nestedContainer = link.parentElement?.closest?.(`${CARD_WRAPPER_SELECTOR}, [role="link"]`);
  if (nestedContainer && tweet.contains(nestedContainer)) {
    return true;
  }

  const cardWrapper = link.closest?.(CARD_WRAPPER_SELECTOR);
  if (cardWrapper && tweet.contains(cardWrapper)) {
    return true;
  }

  return Boolean(link.matches?.('[role="link"]') && link.querySelector?.(TWEET_TEXT_SELECTOR));
}

export function findPrimaryTweetText(tweet) {
  return Array.from(tweet?.querySelectorAll?.(TWEET_TEXT_SELECTOR) || [])
    .find((tweetText) => {
      if (!isVisible(tweetText)) {
        return false;
      }
      if (tweetText.closest('article[data-testid="tweet"]') !== tweet) {
        return false;
      }
      if (isInsideExcludedTweetContent(tweetText, tweet)) {
        return false;
      }
      return Boolean(textOf(tweetText));
    }) || null;
}

export function findLongformTarget(tweet) {
  const selectors = [
    LONGFORM_BODY_SELECTOR,
    LONGFORM_READ_VIEW_SELECTOR,
    LONGFORM_TITLE_SELECTOR,
  ];

  if (
    tweet?.matches?.(LONGFORM_READ_VIEW_SELECTOR) &&
    !isInsideExcludedTweetContent(tweet, tweet)
  ) {
    return tweet;
  }

  for (const selector of selectors) {
    for (const target of tweet?.querySelectorAll?.(selector) || []) {
      if (
        target.closest?.('article[data-testid="tweet"]') === tweet &&
        !isInsideExcludedTweetContent(target, tweet)
      ) {
        return target;
      }
    }
  }

  return null;
}

export function isLongformTweet(tweet) {
  return Boolean(findLongformTarget(tweet));
}

export function extractLongformText(tweet) {
  const target = findLongformTarget(tweet);
  const readView = target?.matches?.(LONGFORM_READ_VIEW_SELECTOR)
    ? target
    : target?.closest?.(LONGFORM_READ_VIEW_SELECTOR);
  if (!readView || isInsideExcludedTweetContent(readView, tweet)) {
    return "";
  }

  // 长文由标题和富文本正文组成；后台第三方翻译依赖完整文本，所以这里按阅读顺序拼接。
  const parts = [
    textOf(readView.querySelector(LONGFORM_TITLE_SELECTOR)),
    textOf(readView.querySelector(LONGFORM_BODY_SELECTOR)),
  ].filter(Boolean);

  return normalizeText(parts.join("\n\n"));
}

export function findShowMoreButton(tweet) {
  return Array.from(tweet?.querySelectorAll?.(SHOW_MORE_SELECTOR) || [])
    .find((button) => {
      if (!isVisible(button) || isDisabled(button)) {
        return false;
      }
      if (button.closest('article[data-testid="tweet"]') !== tweet) {
        return false;
      }
      return !isInsideExcludedTweetContent(button, tweet);
    }) || null;
}

export function extractTweetText(tweet) {
  const tweetText = findPrimaryTweetText(tweet);
  return textOf(tweetText);
}

function createTranslationRequestPayload(tweet, metadata, expandedText) {
  const longformText = isLongformTweet(tweet) ? extractLongformText(tweet) : "";
  if (longformText) {
    return {
      ...metadata,
      contentType: LONGFORM_CONTENT_TYPE,
      text: longformText,
    };
  }

  return {
    ...metadata,
    text: expandedText || extractTweetText(tweet),
  };
}

export function getTweetMetadata(tweet) {
  const statusLinks = Array.from(tweet?.querySelectorAll?.('a[href*="/status/"]') || []);
  const candidates = statusLinks.filter((link) => !isEmbeddedStatusLink(link, tweet));
  const preferredLink = candidates.find((link) => link.querySelector("time")) || candidates[0];
  const statusLink = preferredLink?.getAttribute("href") || tweet?.ownerDocument?.location?.pathname || globalThis.location?.pathname || "";

  const match = statusLink?.match(STATUS_URL_PATTERN);
  if (!match) {
    return null;
  }

  return {
    id: match[2],
    url: new URL(`/${match[1]}/status/${match[2]}`, "https://x.com").toString(),
  };
}

export function replaceTweetTextWithTranslation(tweet, translation) {
  if (!tweet || !translation) {
    return null;
  }

  tweet.querySelector("[data-xat-status]")?.remove();
  const tweetText = findPrimaryTweetText(tweet);
  if (!tweetText) {
    return null;
  }

  for (const staleTranslation of tweet.querySelectorAll("[data-xat-translation]")) {
    if (staleTranslation === tweetText) {
      continue;
    }
    if (staleTranslation.matches(TWEET_TEXT_SELECTOR)) {
      staleTranslation.removeAttribute("data-xat-translation");
    } else {
      staleTranslation.remove();
    }
  }

  if (!tweetText.hasAttribute("data-xat-original-text")) {
    tweetText.setAttribute("data-xat-original-text", extractTweetText(tweet));
  }

  tweetText.setAttribute("data-xat-translation", "1");
  tweetText.style.whiteSpace = "pre-wrap";
  tweetText.textContent = translation;
  return tweetText;
}

export function renderLongformTranslation(tweet, translation) {
  const target = findLongformTarget(tweet);
  const readView = target?.matches?.(LONGFORM_READ_VIEW_SELECTOR)
    ? target
    : target?.closest?.(LONGFORM_READ_VIEW_SELECTOR);
  if (!readView || !translation) {
    return null;
  }

  tweet.querySelector("[data-xat-status]")?.remove();
  const existing = tweet.querySelector("[data-xat-longform-translation]");
  const translationNode = existing || tweet.ownerDocument.createElement("div");
  translationNode.setAttribute("data-xat-longform-translation", "1");
  translationNode.setAttribute("data-xat-translation", "1");
  if (!translationNode.hasAttribute("data-xat-original-text")) {
    translationNode.setAttribute("data-xat-original-text", extractLongformText(tweet));
  }

  // 长文富文本结构复杂，直接替换原节点容易破坏链接和媒体；独立译文块更稳定。
  translationNode.textContent = translation;
  translationNode.style.whiteSpace = "pre-wrap";
  translationNode.style.marginTop = "12px";
  translationNode.style.fontSize = "15px";
  translationNode.style.lineHeight = "22px";

  if (!existing && readView.parentElement) {
    readView.parentElement.insertBefore(translationNode, readView.nextSibling);
  }

  return translationNode;
}

function renderTranslationResult(tweet, translation) {
  return isLongformTweet(tweet)
    ? renderLongformTranslation(tweet, translation)
    : replaceTweetTextWithTranslation(tweet, translation);
}

function formatTranslationFailureMessage(tweet, result) {
  const error = result?.error || "";
  if (isLongformTweet(tweet)) {
    if (error === "third-party-provider-unavailable") {
      return "配置第三方翻译服务后可翻译长文";
    }
    return `长文暂时没有返回译文${error ? `：${error}` : ""}`;
  }

  return `X 暂时没有返回译文${error ? `：${error}` : ""}`;
}

export function renderTranslationStatus(tweet, message) {
  if (!tweet || !message) {
    return null;
  }

  const existing = tweet.querySelector("[data-xat-status]");
  if (existing) {
    existing.textContent = message;
    return existing;
  }

  const statusTarget = findPrimaryTweetText(tweet) || findLongformTarget(tweet);
  const status = tweet.ownerDocument.createElement("div");
  status.setAttribute("data-xat-status", "1");
  status.textContent = message;
  status.style.marginTop = "8px";
  status.style.color = "rgb(83, 100, 113)";
  status.style.fontSize = "13px";
  status.style.lineHeight = "18px";

  if (statusTarget?.parentElement) {
    statusTarget.parentElement.insertBefore(status, statusTarget.nextSibling);
  } else {
    tweet.append(status);
  }

  return status;
}

export function findTranslateButton(tweet) {
  if (!tweet) {
    return null;
  }

  const textMatches = Array.from(tweet.querySelectorAll("span, div, button, a"))
    .filter((element) => {
      if (
        !isVisible(element) ||
        element.closest?.(TWEET_TEXT_SELECTOR) ||
        element.querySelector?.(TWEET_TEXT_SELECTOR)
      ) {
        return false;
      }
      return hasTranslateLabel(textOf(element));
    });

  for (const element of textMatches) {
    const target = closestWithin(element, INTERACTIVE_SELECTOR, tweet);
    if (target && target !== tweet && isVisible(target) && !isDisabled(target)) {
      return target;
    }
  }

  return null;
}

export function createTweetProcessor(options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const wait = config.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = config.now || (() => Date.now());
  const onEvent = config.onEvent || (() => {});

  async function waitForStableText(tweet) {
    let previous = extractTweetText(tweet);
    await wait(config.expandDelayMs);
    let current = extractTweetText(tweet);

    if (current !== previous) {
      previous = current;
      await wait(Math.min(config.expandDelayMs, 400));
      current = extractTweetText(tweet);
    }

    return current || previous;
  }

  async function clickTranslateWhenAvailable(tweet) {
    await wait(config.translateInitialDelayMs);

    for (let attempt = 0; attempt <= config.translateRetries; attempt += 1) {
      const translateButton = findTranslateButton(tweet);
      if (translateButton) {
        translateButton.click();
        tweet.dataset.xatState = "translated";
        tweet.dataset.xatTranslatedAt = String(now());
        return true;
      }
      await wait(config.translateRetryDelayMs);
    }

    tweet.dataset.xatState = "expanded";
    tweet.dataset.xatLastAttempt = String(now());
    return false;
  }

  async function processTweet(tweet, staleRetries = 1) {
    if (
      !tweet ||
      tweet.dataset.xatState === "translated" ||
      tweet.dataset.xatState === "skipped" ||
      tweet.dataset.xatState === "processing"
    ) {
      return;
    }

    const lastAttempt = Number(tweet.dataset.xatLastAttempt || 0);
    if (tweet.dataset.xatState === "expanded" && now() - lastAttempt < config.retryCooldownMs) {
      return;
    }

    tweet.dataset.xatState = "processing";
    let expandedText = "";

    if (config.autoExpand) {
      const showMoreButton = findShowMoreButton(tweet);
      if (showMoreButton) {
        showMoreButton.click();
        onEvent("expanded", getTweetMetadata(tweet));
      }
      expandedText = await waitForStableText(tweet);
    }

    if (config.autoTranslate && typeof config.requestTranslation === "function") {
      const metadata = getTweetMetadata(tweet);
      if (!metadata) {
        tweet.dataset.xatState = "expanded";
        tweet.dataset.xatLastAttempt = String(now());
        return;
      }

      renderTranslationStatus(tweet, isLongformTweet(tweet) ? "正在获取长文译文..." : "正在获取 X 自带译文...");
      onEvent("translation-requested", metadata);
      const result = await config.requestTranslation(createTranslationRequestPayload(tweet, metadata, expandedText));
      const currentMetadata = getTweetMetadata(tweet);
      if (!tweet.isConnected) {
        tweet.querySelector("[data-xat-status]")?.remove();
        delete tweet.dataset.xatState;
        onEvent("translation-stale", metadata);
        return;
      }

      if (currentMetadata?.id !== metadata.id) {
        tweet.querySelector("[data-xat-status]")?.remove();
        delete tweet.dataset.xatState;
        delete tweet.dataset.xatLastAttempt;
        onEvent("translation-stale", metadata);
        if (staleRetries > 0) {
          return processTweet(tweet, staleRetries - 1);
        }
        tweet.dataset.xatState = "expanded";
        tweet.dataset.xatLastAttempt = String(now());
        return;
      }

      if (result?.translation) {
        renderTranslationResult(tweet, result.translation);
        tweet.dataset.xatState = "translated";
        tweet.dataset.xatTranslatedAt = String(now());
        onEvent("translation-rendered", metadata);
      } else if (result?.skipped) {
        tweet.querySelector("[data-xat-status]")?.remove();
        tweet.dataset.xatState = "skipped";
        tweet.dataset.xatSkippedAt = String(now());
      } else {
        renderTranslationStatus(tweet, formatTranslationFailureMessage(tweet, result));
        tweet.dataset.xatState = "expanded";
        tweet.dataset.xatLastAttempt = String(now());
        onEvent("translation-failed", { ...metadata, error: result?.error || "empty-result" });
      }
      return;
    }

    if (config.autoTranslate) {
      await clickTranslateWhenAvailable(tweet);
      return;
    }

    tweet.dataset.xatState = "expanded";
  }

  return {
    processTweet,
  };
}

export const selectors = {
  cardWrapper: CARD_WRAPPER_SELECTOR,
  longformBody: LONGFORM_BODY_SELECTOR,
  longformReadView: LONGFORM_READ_VIEW_SELECTOR,
  longformTitle: LONGFORM_TITLE_SELECTOR,
  showMore: SHOW_MORE_SELECTOR,
  tweetText: TWEET_TEXT_SELECTOR,
};
