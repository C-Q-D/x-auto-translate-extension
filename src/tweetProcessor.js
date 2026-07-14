// 本文件负责识别 X 页面里的帖子、评论和长文正文，并把可翻译内容交给后台翻译管线。
// 这里的 DOM 选择器需要尽量收窄到当前 article，避免把引用卡片或推荐内容误当成主内容。
const SHOW_MORE_SELECTOR = 'button[data-testid="tweet-text-show-more-link"]';
const TWEET_TEXT_SELECTOR = '[data-testid="tweetText"]';
const CARD_WRAPPER_SELECTOR = '[data-testid="card.wrapper"]';
const LONGFORM_READ_VIEW_SELECTOR = '[data-testid="twitterArticleReadView"], [data-testid="twitterArticleRichTextView"]';
const LONGFORM_TITLE_SELECTOR = '[data-testid="twitter-article-title"]';
const LONGFORM_TITLE_FALLBACK_SELECTOR = "span.css-1jxf684.r-bcqeeo.r-1ttztb7.r-qvutc0.r-poiln3";
const LONGFORM_BODY_SELECTOR = '[data-testid="longformRichTextComponent"]';
const LONGFORM_TEXT_LEAF_SELECTOR = '[data-text="true"]';
const LONGFORM_CODE_BLOCK_SELECTOR = '[data-testid="markdown-code-block"]';
const LONGFORM_GENERATED_LEAF_ATTRIBUTE = "data-xat-longform-text-leaf";
const LONGFORM_BLOCK_TRANSLATION_ATTRIBUTE = "data-xat-longform-block-translation";
const LONGFORM_TRANSLATED_TEXT_ATTRIBUTE = "data-xat-translated-text";
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
  longformConcurrency: 3,
  longformRequestIntervalMs: 220,
  longformRetries: 2,
  longformRetryDelayMs: 1000,
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

/**
 * 读取长文文字节点的原文。
 * 已翻译节点优先读取首次替换前保存的原文，避免重试时把中文译文再次送去翻译。
 *
 * @param {Element | null | undefined} element 当前文字承载节点。
 * @returns {string} 规范化后的原文；节点无文字时返回空字符串。
 * @sideEffects 本函数只读取 DOM 属性和文本，不修改页面。
 */
function getLongformOriginalText(element) {
  return normalizeText(element?.getAttribute?.("data-xat-original-text") || textOf(element));
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

/**
 * 根据 DOM 变化节点找到应该重新处理的最外层目标。
 *
 * @param {Node | Element | null | undefined} node MutationObserver 捕获到的变化节点或其父节点。
 * @returns {Element | null} 返回普通帖子 article 或独立 X Article 长文容器；找不到可处理目标时返回 null。
 * @sideEffects 本函数只读取 DOM，不修改节点状态。
 */
export function findProcessTargetFromNode(node) {
  const element = node?.nodeType === 1 ? node : node?.parentElement;
  if (!element) {
    return null;
  }

  // X Article 详情页会先渲染独立长文容器，再逐步把 Draft 富文本正文塞进去；
  // 这里把容器内部任意变化都归并到最外层长文块，便于内容脚本重新调度。
  const standaloneLongform = element.closest?.(LONGFORM_READ_VIEW_SELECTOR);
  if (standaloneLongform && !standaloneLongform.closest?.('article[data-testid="tweet"]')) {
    return standaloneLongform;
  }

  return element.closest?.('article[data-testid="tweet"]') || null;
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

/**
 * 查找页面中真正可作为 X Article 长文处理的目标。
 *
 * @param {ParentNode | Element | Document} root 扫描范围，默认是当前 document。
 * @returns {Element[]} 返回包含主长文正文的 tweet article 或独立长文容器；不包含普通帖子和引用卡片。
 * @sideEffects 本函数只读取 DOM，不修改页面。
 */
export function findXArticleTargets(root = document) {
  return findTweetArticles(root).filter((target) => isLongformTweet(target));
}

/**
 * 查找 X Article 的标题元素。
 * 新版 X 的真实标题没有稳定 data-testid，只保留通用文本 class；因此从正文容器向前选择最近的非交互文本元素。
 *
 * @param {Element} readView 长文正文阅读容器。
 * @returns {Element | null} 匹配到的标题元素；没有可靠候选时返回 null。
 * @sideEffects 本函数只读取 DOM，不修改页面。
 */
function findLongformTitle(readView) {
  const legacyTitle = readView?.querySelector?.(LONGFORM_TITLE_SELECTOR);
  if (legacyTitle) {
    return legacyTitle;
  }

  const scope = readView?.closest?.('article[data-testid="tweet"], main') || readView?.parentElement;
  const followingFlag = readView?.ownerDocument?.defaultView?.Node?.DOCUMENT_POSITION_FOLLOWING || 4;
  const candidates = Array.from(scope?.querySelectorAll?.(LONGFORM_TITLE_FALLBACK_SELECTOR) || [])
    .filter((candidate) => {
      if (!textOf(candidate) || candidate.closest("a[href], button, [role='button'], [role='link']")) {
        return false;
      }
      return Boolean(candidate.compareDocumentPosition(readView) & followingFlag);
    });

  if (candidates.length > 0) {
    return candidates.at(-1);
  }

  // 部分页面把标题测试节点放在正文阅读容器外层；仅在用户提供的文本 class 找不到时使用该兼容回退。
  const legacyCandidates = Array.from(scope?.querySelectorAll?.(LONGFORM_TITLE_SELECTOR) || [])
    .filter((candidate) => (
      textOf(candidate) && Boolean(candidate.compareDocumentPosition(readView) & followingFlag)
    ));
  return legacyCandidates.at(-1) || null;
}

/**
 * 为混合行内容器中的裸文本创建最小 span 叶节点。
 * 例如 `Read <a>docs</a> later` 的两段裸文本没有可挂载状态的元素；包装后可以逐段替换且不删除链接。
 *
 * @param {Element} container 标题或正文内容块。
 * @returns {void}
 * @sideEffects 仅把带元素兄弟的非空裸文本节点包进扩展标记的内联 span；代码块和按钮内容保持原样。
 */
function ensureLongformTextLeafWrappers(container) {
  const document = container?.ownerDocument;
  const nodeFilter = document?.defaultView?.NodeFilter;
  if (!document?.createTreeWalker || !nodeFilter) {
    return;
  }

  const walker = document.createTreeWalker(container, nodeFilter.SHOW_TEXT);
  const textNodes = [];
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    textNodes.push(current);
  }

  for (const textNode of textNodes) {
    const parent = textNode.parentElement;
    if (
      !normalizeText(textNode.nodeValue || "") ||
      !parent ||
      parent.children.length === 0 ||
      parent.closest("button, [role='button']") ||
      parent.closest(LONGFORM_CODE_BLOCK_SELECTOR) ||
      parent.closest(`${LONGFORM_TEXT_LEAF_SELECTOR}, [${LONGFORM_GENERATED_LEAF_ATTRIBUTE}]`)
    ) {
      continue;
    }

    const wrapper = document.createElement("span");
    wrapper.setAttribute(LONGFORM_GENERATED_LEAF_ATTRIBUTE, "1");
    parent.insertBefore(wrapper, textNode);
    wrapper.append(textNode);
  }
}

/**
 * 从一个长文内容块中找出真正承载可见文字的叶节点。
 * Draft.js 标记、兼容包装节点和无子元素的普通节点会统一按 DOM 阅读顺序返回。
 *
 * @param {Element} container 标题或正文内容块。
 * @returns {Element[]} 按 DOM 顺序排列的文字承载节点。
 * @sideEffects 必要时为混合行内裸文本创建最小 span，外层链接、列表和按钮结构不变。
 */
function findLongformTextLeaves(container) {
  if (!container) {
    return [];
  }

  ensureLongformTextLeafWrappers(container);
  const markedSelector = `${LONGFORM_TEXT_LEAF_SELECTOR}, [${LONGFORM_GENERATED_LEAF_ATTRIBUTE}]`;
  const descendants = Array.from(container.querySelectorAll?.("*") || []);
  const candidates = new Set([
    ...(container.matches?.(markedSelector) ? [container] : []),
    ...Array.from(container.querySelectorAll?.(markedSelector) || []),
    ...[container, ...descendants].filter((element) => element.children.length === 0),
  ]);
  const followingFlag = container.ownerDocument?.defaultView?.Node?.DOCUMENT_POSITION_FOLLOWING || 4;

  return Array.from(candidates)
    .filter((element) => (
      !element.closest("button, [role='button']") &&
      !element.closest(LONGFORM_CODE_BLOCK_SELECTOR) &&
      isVisible(element) &&
      getLongformOriginalText(element)
    ))
    .sort((left, right) => {
      if (left === right) {
        return 0;
      }
      return left.compareDocumentPosition(right) & followingFlag ? -1 : 1;
    });
}

/**
 * 动态枚举当前 X Article 的可翻译文字节点。
 * 节点数量完全取决于当前文章 DOM，不使用固定数量或固定索引；空分隔符、纯媒体块和代码块会被忽略。
 * 代码块内部可能同样带有 data-text 属性，因此既在内容块层跳过，也在叶节点入队时做祖先校验。
 *
 * @param {Element} tweet 包含长文的 tweet article 或独立长文阅读容器。
 * @returns {Array<{element: Element, kind: "title" | "body", text: string}>} 按阅读顺序排列的翻译单元。
 * @sideEffects 已翻译节点从属性读取原文；无元素承载的混合行内裸文本会被包装成最小 span。
 */
export function findLongformTextBlocks(tweet) {
  const target = findLongformTarget(tweet);
  const readView = target?.matches?.(LONGFORM_READ_VIEW_SELECTOR)
    ? target
    : target?.closest?.(LONGFORM_READ_VIEW_SELECTOR);
  if (!readView || isInsideExcludedTweetContent(readView, tweet)) {
    return [];
  }

  const blocks = [];
  const seenElements = new Set();
  const appendElements = (elements, kind) => {
    for (const element of elements) {
      const text = getLongformOriginalText(element);
      if (
        !text ||
        seenElements.has(element) ||
        element.closest?.(LONGFORM_CODE_BLOCK_SELECTOR)
      ) {
        continue;
      }
      seenElements.add(element);
      blocks.push({ element, kind, text });
    }
  };

  appendElements(findLongformTextLeaves(findLongformTitle(readView)), "title");

  const body = readView.matches?.(LONGFORM_BODY_SELECTOR)
    ? readView
    : readView.querySelector?.(LONGFORM_BODY_SELECTOR);
  if (!body) {
    return blocks;
  }

  // 始终从正文顶层向下收集叶节点，避免代码块内部的 data-block 让同级普通段落被遗漏。
  const contentBlocks = body.children.length > 0 ? Array.from(body.children) : [body];

  for (const contentBlock of contentBlocks) {
    // 代码块自身或其内部 data-block 必须跳过；父块中的普通文字仍交给叶节点过滤器处理。
    if (
      contentBlock.matches?.(LONGFORM_CODE_BLOCK_SELECTOR) ||
      contentBlock.closest?.(LONGFORM_CODE_BLOCK_SELECTOR)
    ) {
      continue;
    }

    const textLeaves = findLongformTextLeaves(contentBlock);
    if (textLeaves.length > 0 && !(contentBlock.matches?.("section") && textLeaves[0] === contentBlock)) {
      appendElements(textLeaves, "body");
    }
  }

  return blocks;
}

/**
 * 判断当前文章中已发现的所有文字节点是否都有译文。
 * 后续 hydrate 新增的节点没有翻译标记，因此会让文章重新进入补译流程。
 *
 * @param {Element} tweet 长文处理目标。
 * @returns {boolean} 至少存在一个文字节点且全部完成原位替换时返回 true。
 * @sideEffects 本函数只读取 DOM，不修改状态。
 */
export function isLongformTranslationComplete(tweet) {
  const blocks = findLongformTextBlocks(tweet);
  return blocks.length > 0 && blocks.every(({ element }) => (
    element.getAttribute(LONGFORM_BLOCK_TRANSLATION_ATTRIBUTE) === "1"
  ));
}

/**
 * 把单个长文文字节点原位替换为译文。
 * 仅修改文字叶节点，保留链接、列表、标题、代码框和复制按钮等外层结构。
 *
 * @param {{element: Element, text: string}} block 当前翻译单元及其原文。
 * @param {string} translation 第三方服务返回的译文。
 * @returns {Element | null} 完成替换的文字节点；参数无效时返回 null。
 * @sideEffects 保存原文和译文属性、写入翻译标记并修改节点文本。
 */
function replaceLongformTextBlock(block, translation) {
  const element = block?.element;
  const normalizedTranslation = normalizeText(translation || "");
  if (!element || !normalizedTranslation) {
    return null;
  }

  if (!element.hasAttribute("data-xat-original-text")) {
    element.setAttribute("data-xat-original-text", block.text);
  }

  const renderedText = element.textContent || "";
  const leadingWhitespace = renderedText.match(/^\s*/)?.[0] || "";
  const trailingWhitespace = renderedText.match(/\s*$/)?.[0] || "";
  element.setAttribute(LONGFORM_BLOCK_TRANSLATION_ATTRIBUTE, "1");
  element.setAttribute("data-xat-translation", "1");
  element.setAttribute(LONGFORM_TRANSLATED_TEXT_ATTRIBUTE, normalizedTranslation);
  element.textContent = `${leadingWhitespace}${normalizedTranslation}${trailingWhitespace}`;
  return element;
}

export function extractLongformText(tweet) {
  return normalizeText(findLongformTextBlocks(tweet).map(({ text }) => text).join("\n\n"));
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

function formatTranslationFailureMessage(tweet, result) {
  const error = result?.error || "";
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

/**
 * 清理旧版本遗留的整篇聚合译文节点。
 * 独立长文容器的旧译文可能位于目标前后，因此同时检查容器内部和相邻兄弟节点。
 *
 * @param {Element} tweet 长文处理目标。
 * @returns {void}
 * @sideEffects 删除扩展旧版本创建的 `data-xat-longform-translation` 节点。
 */
function removeLegacyLongformTranslations(tweet) {
  const candidates = [
    ...Array.from(tweet?.querySelectorAll?.("[data-xat-longform-translation]") || []),
    tweet?.previousElementSibling,
    tweet?.nextElementSibling,
  ];
  for (const candidate of new Set(candidates)) {
    if (candidate?.matches?.("[data-xat-longform-translation]")) {
      candidate.remove();
    }
  }
}

/**
 * 生成长文部分翻译失败后的可读状态。
 *
 * @param {Element} tweet 当前长文目标。
 * @param {Array<object>} failures 本轮失败结果。
 * @returns {string} 面向用户的中文状态说明。
 * @sideEffects 本函数只读取当前块级状态，不修改 DOM。
 */
function formatLongformFailureMessage(tweet, failures) {
  const blocks = findLongformTextBlocks(tweet);
  const translatedCount = blocks.filter(({ element }) => (
    element.getAttribute(LONGFORM_BLOCK_TRANSLATION_ATTRIBUTE) === "1"
  )).length;
  const pendingCount = Math.max(0, blocks.length - translatedCount);
  const firstError = failures.find((result) => result?.error)?.error || "";
  if (translatedCount === 0 && firstError === "third-party-provider-unavailable") {
    return "配置第三方翻译服务后可翻译长文";
  }
  return `长文已翻译 ${translatedCount}/${blocks.length} 个内容节点，${pendingCount} 个暂未完成${firstError ? `：${firstError}` : ""}`;
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

  /**
   * 按动态发现的文字节点并发翻译长文，并在单个请求完成后立即原位替换。
   * 同一轮失败的节点不会立刻死循环重试；手动触发或后续调度只会补译仍未完成的节点。
   *
   * @param {Element} tweet 长文处理目标。
   * @param {{id: string, url: string}} metadata 当前文章元数据。
   * @param {number} staleRetries DOM 被 X 复用后允许的剩余重试次数。
   * @returns {Promise<void>} 所有当前可处理节点完成或失败后结束。
   * @sideEffects 发起多次后台翻译请求、逐节点替换文本，并更新文章级处理状态和诊断事件。
   */
  async function processLongformTweet(tweet, metadata, staleRetries) {
    removeLegacyLongformTranslations(tweet);
    const initialBlocks = findLongformTextBlocks(tweet);
    if (initialBlocks.length === 0) {
      renderTranslationStatus(tweet, "正在等待长文正文加载...");
      tweet.dataset.xatState = "expanded";
      tweet.dataset.xatLastAttempt = String(now());
      onEvent("translation-waiting-content", metadata);
      return;
    }

    const failedElements = new Set();
    const failures = [];
    const maxConcurrency = Math.min(3, Math.max(1, Number(config.longformConcurrency) || 1));
    const requestIntervalMs = Math.max(0, Number(config.longformRequestIntervalMs) || 0);
    const retryAttempts = Math.max(0, Number(config.longformRetries) || 0);
    const retryDelayMs = Math.max(0, Number(config.longformRetryDelayMs) || 0);
    let nextRequestAt = now();
    let stale = false;

    /**
     * 为并发工作线程预留全局请求启动时隙。
     * 三个工作线程共享同一时间轴，避免每个节点同时冲击腾讯云频率限制。
     *
     * @returns {Promise<void>} 到达预定启动时间后结束。
     * @sideEffects 递增本篇文章的下一请求时间，并可能等待一段时间。
     */
    async function waitForLongformRequestSlot() {
      const currentTime = now();
      const scheduledAt = Math.max(currentTime, nextRequestAt);
      nextRequestAt = scheduledAt + requestIntervalMs;
      const delayMs = scheduledAt - currentTime;
      if (delayMs > 0) {
        await wait(delayMs);
      }
    }

    /**
     * 检查翻译结果是否仍属于当前连接中的同一篇文章。
     *
     * @returns {boolean} DOM 仍连接且文章 ID 未变化时返回 true。
     * @sideEffects 本函数只读取 DOM 和 URL 元数据。
     */
    function isCurrentArticle() {
      return Boolean(tweet.isConnected && getTweetMetadata(tweet)?.id === metadata.id);
    }

    /**
     * 判断一个请求中的文字节点是否仍是当前文章里的同一份原文。
     * X 可能在请求期间原地 hydrate 节点或把节点移动进代码块；旧结果必须丢弃并让下一轮重新枚举。
     *
     * @param {{element: Element, text: string}} block 发起请求时记录的翻译单元。
     * @returns {boolean} 节点仍可翻译且原文未变化时返回 true。
     * @sideEffects 本函数只重新扫描当前文章，不修改 DOM。
     */
    function isCurrentLongformBlock(block) {
      if (!block?.element?.isConnected || block.element.closest?.(LONGFORM_CODE_BLOCK_SELECTOR)) {
        return false;
      }

      return findLongformTextBlocks(tweet).some((currentBlock) => (
        currentBlock.element === block.element && currentBlock.text === block.text
      ));
    }

    /**
     * 翻译一个文字节点并立即写回。
     *
     * @param {{element: Element, kind: string, text: string}} block 当前翻译单元。
     * @returns {Promise<void>} 单节点请求及渲染完成后结束。
     * @sideEffects 发送后台请求；成功时替换节点，失败时记录本轮失败并更新进度状态。
     */
    async function translateLongformBlock(block) {
      let result;
      for (let attempt = 0; attempt <= retryAttempts; attempt += 1) {
        await waitForLongformRequestSlot();
        if (!isCurrentArticle()) {
          stale = true;
          return;
        }
        if (!isCurrentLongformBlock(block)) {
          return;
        }

        try {
          result = await config.requestTranslation({
            ...metadata,
            contentType: LONGFORM_CONTENT_TYPE,
            text: block.text,
          });
        } catch (error) {
          result = { ok: false, error: error?.message || "translation-failed" };
        }

        if (result?.translation || !result?.retryable || attempt >= retryAttempts) {
          break;
        }

        // 限流和临时故障使用有上限的线性退避；永久错误直接进入部分失败状态，避免无意义重复请求。
        await wait(retryDelayMs * (attempt + 1));
      }

      if (!isCurrentArticle()) {
        stale = true;
        return;
      }
      if (!isCurrentLongformBlock(block)) {
        return;
      }

      if (result?.translation) {
        replaceLongformTextBlock(block, result.translation);
      } else {
        failedElements.add(block.element);
        failures.push(result || { ok: false, error: "empty-result" });
      }

      const currentBlocks = findLongformTextBlocks(tweet);
      const finishedCount = currentBlocks.filter(({ element }) => (
        element.getAttribute(LONGFORM_BLOCK_TRANSLATION_ATTRIBUTE) === "1" || failedElements.has(element)
      )).length;
      renderTranslationStatus(tweet, `正在翻译长文 ${finishedCount}/${currentBlocks.length}...`);
    }

    /**
     * 使用固定大小工作池处理一批节点。
     *
     * @param {Array<{element: Element, kind: string, text: string}>} blocks 本批待翻译节点。
     * @returns {Promise<void>} 本批工作线程全部结束后完成。
     * @sideEffects 并发调用 `translateLongformBlock`。
     */
    async function translateLongformBatch(blocks) {
      let nextIndex = 0;
      const workerCount = Math.min(maxConcurrency, blocks.length);
      await Promise.all(Array.from({ length: workerCount }, async () => {
        while (!stale && nextIndex < blocks.length) {
          const index = nextIndex;
          nextIndex += 1;
          await translateLongformBlock(blocks[index]);
        }
      }));
    }

    const initiallyTranslated = initialBlocks.filter(({ element }) => (
      element.getAttribute(LONGFORM_BLOCK_TRANSLATION_ATTRIBUTE) === "1"
    )).length;
    renderTranslationStatus(tweet, `正在翻译长文 ${initiallyTranslated}/${initialBlocks.length}...`);
    onEvent("translation-requested", metadata);

    // 正文可能在请求期间继续 hydrate；每批结束后重新动态枚举，只追加处理新出现且本轮未失败的节点。
    while (!stale) {
      const pendingBlocks = findLongformTextBlocks(tweet).filter(({ element }) => (
        element.getAttribute(LONGFORM_BLOCK_TRANSLATION_ATTRIBUTE) !== "1" && !failedElements.has(element)
      ));
      if (pendingBlocks.length === 0) {
        break;
      }
      await translateLongformBatch(pendingBlocks);
    }

    if (stale) {
      tweet.querySelector("[data-xat-status]")?.remove();
      delete tweet.dataset.xatState;
      onEvent("translation-stale", metadata);
      if (tweet.isConnected && staleRetries > 0) {
        return processTweet(tweet, staleRetries - 1);
      }
      return;
    }

    if (isLongformTranslationComplete(tweet)) {
      tweet.querySelector("[data-xat-status]")?.remove();
      tweet.dataset.xatState = "translated";
      tweet.dataset.xatTranslatedAt = String(now());
      onEvent("translation-rendered", metadata);
      return;
    }

    renderTranslationStatus(tweet, formatLongformFailureMessage(tweet, failures));
    tweet.dataset.xatState = "expanded";
    tweet.dataset.xatLastAttempt = String(now());
    onEvent("translation-failed", {
      ...metadata,
      error: failures.find((result) => result?.error)?.error || "partial-longform-translation",
    });
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
    const longform = isLongformTweet(tweet);

    if (config.autoExpand && !longform) {
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

      if (longform) {
        await processLongformTweet(tweet, metadata, staleRetries);
        return;
      }

      renderTranslationStatus(tweet, "正在获取 X 自带译文...");
      const payload = createTranslationRequestPayload(tweet, metadata, expandedText);

      onEvent("translation-requested", metadata);
      const result = await config.requestTranslation(payload);
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
        replaceTweetTextWithTranslation(tweet, result.translation);
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
