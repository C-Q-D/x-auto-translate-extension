(() => {
  // src/tweetProcessor.js
  var SHOW_MORE_SELECTOR = 'button[data-testid="tweet-text-show-more-link"]';
  var TWEET_TEXT_SELECTOR = '[data-testid="tweetText"]';
  var CARD_WRAPPER_SELECTOR = '[data-testid="card.wrapper"]';
  var LONGFORM_READ_VIEW_SELECTOR = '[data-testid="twitterArticleReadView"], [data-testid="twitterArticleRichTextView"]';
  var LONGFORM_TITLE_SELECTOR = '[data-testid="twitter-article-title"]';
  var LONGFORM_TITLE_FALLBACK_SELECTOR = "span.css-1jxf684.r-bcqeeo.r-1ttztb7.r-qvutc0.r-poiln3";
  var LONGFORM_BODY_SELECTOR = '[data-testid="longformRichTextComponent"]';
  var LONGFORM_TEXT_LEAF_SELECTOR = '[data-text="true"]';
  var LONGFORM_CODE_BLOCK_SELECTOR = '[data-testid="markdown-code-block"]';
  var LONGFORM_GENERATED_LEAF_ATTRIBUTE = "data-xat-longform-text-leaf";
  var LONGFORM_BLOCK_TRANSLATION_ATTRIBUTE = "data-xat-longform-block-translation";
  var LONGFORM_TRANSLATED_TEXT_ATTRIBUTE = "data-xat-translated-text";
  var LONGFORM_VIEW_TOGGLE_SELECTOR = '[data-xat-longform-toggle="1"]';
  var LONGFORM_ORIGINAL_VIEW = "original";
  var LONGFORM_TRANSLATION_VIEW = "translation";
  var INTERACTIVE_SELECTOR = 'button, [role="button"], a[href], [tabindex]:not([tabindex="-1"])';
  var LONGFORM_CONTENT_TYPE = "longform";
  var TRANSLATE_LABELS = [
    "\u663E\u793A\u7FFB\u8BD1",
    "\u7FFB\u8BD1\u5E16\u5B50",
    "\u67E5\u770B\u7FFB\u8BD1",
    "Translate post",
    "Translate Tweet",
    "Show translation",
    "Translate"
  ];
  var DEFAULT_OPTIONS = {
    autoExpand: true,
    autoTranslate: true,
    expandDelayMs: 500,
    translateInitialDelayMs: 250,
    translateRetryDelayMs: 700,
    translateRetries: 5,
    retryCooldownMs: 7e3,
    longformConcurrency: 3,
    longformRequestIntervalMs: 220,
    longformRetries: 2,
    longformRetryDelayMs: 1e3
  };
  var STATUS_URL_PATTERN = /\/([^/?#]+)\/status\/(\d+)/;
  function normalizeText(text) {
    return text.replace(/\s+/g, " ").trim().replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, "$1$2").replace(/([，。！？；：、])\s+/g, "$1").replace(/\s+([，。！？；：、,.!?;:%])/g, "$1");
  }
  function textOf(element) {
    return normalizeText(element?.innerText || element?.textContent || "");
  }
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
  function findTweetArticles(root = document) {
    const tweets = Array.from(root.querySelectorAll?.('article[data-testid="tweet"]') || []);
    const longformRoots = [
      ...root.matches?.(LONGFORM_READ_VIEW_SELECTOR) ? [root] : [],
      ...Array.from(root.querySelectorAll?.(LONGFORM_READ_VIEW_SELECTOR) || [])
    ];
    const standaloneLongforms = longformRoots.filter((readView) => !readView.closest?.('article[data-testid="tweet"]'));
    return [...tweets, ...standaloneLongforms];
  }
  function findProcessTargetFromNode(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    if (!element) {
      return null;
    }
    const standaloneLongform = element.closest?.(LONGFORM_READ_VIEW_SELECTOR);
    if (standaloneLongform && !standaloneLongform.closest?.('article[data-testid="tweet"]')) {
      return standaloneLongform;
    }
    const scope = element.closest?.("main") || element.ownerDocument;
    const standaloneCandidates = Array.from(scope?.querySelectorAll?.(LONGFORM_READ_VIEW_SELECTOR) || []).filter((candidate) => !candidate.closest?.('article[data-testid="tweet"]'));
    for (const candidate of standaloneCandidates) {
      const title = findLongformTitle(candidate);
      if (title && (title === element || title.contains(element) || element.contains(title))) {
        return candidate;
      }
    }
    return element.closest?.('article[data-testid="tweet"]') || null;
  }
  function shouldProcessTimelinePage(url) {
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
  function findPrimaryTweetText(tweet) {
    return Array.from(tweet?.querySelectorAll?.(TWEET_TEXT_SELECTOR) || []).find((tweetText) => {
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
  function findLongformTarget(tweet) {
    const selectors = [
      LONGFORM_BODY_SELECTOR,
      LONGFORM_READ_VIEW_SELECTOR,
      LONGFORM_TITLE_SELECTOR
    ];
    if (tweet?.matches?.(LONGFORM_READ_VIEW_SELECTOR) && !isInsideExcludedTweetContent(tweet, tweet)) {
      return tweet;
    }
    for (const selector of selectors) {
      for (const target of tweet?.querySelectorAll?.(selector) || []) {
        if (target.closest?.('article[data-testid="tweet"]') === tweet && !isInsideExcludedTweetContent(target, tweet)) {
          return target;
        }
      }
    }
    return null;
  }
  function isLongformTweet(tweet) {
    return Boolean(findLongformTarget(tweet));
  }
  function findXArticleTargets(root = document) {
    return findTweetArticles(root).filter((target) => isLongformTweet(target));
  }
  function findLongformTitle(readView) {
    const legacyTitle = readView?.querySelector?.(LONGFORM_TITLE_SELECTOR);
    if (legacyTitle) {
      return legacyTitle;
    }
    const scope = readView?.closest?.('article[data-testid="tweet"], main') || readView?.parentElement;
    const followingFlag = readView?.ownerDocument?.defaultView?.Node?.DOCUMENT_POSITION_FOLLOWING || 4;
    const candidates = Array.from(scope?.querySelectorAll?.(LONGFORM_TITLE_FALLBACK_SELECTOR) || []).filter((candidate) => {
      if (!textOf(candidate) || candidate.closest("a[href], button, [role='button'], [role='link']")) {
        return false;
      }
      return Boolean(candidate.compareDocumentPosition(readView) & followingFlag);
    });
    if (candidates.length > 0) {
      return candidates.at(-1);
    }
    const legacyCandidates = Array.from(scope?.querySelectorAll?.(LONGFORM_TITLE_SELECTOR) || []).filter((candidate) => textOf(candidate) && Boolean(candidate.compareDocumentPosition(readView) & followingFlag));
    return legacyCandidates.at(-1) || null;
  }
  function ensureLongformTextLeafWrappers(container) {
    const document2 = container?.ownerDocument;
    const nodeFilter = document2?.defaultView?.NodeFilter;
    if (!document2?.createTreeWalker || !nodeFilter) {
      return;
    }
    const walker = document2.createTreeWalker(container, nodeFilter.SHOW_TEXT);
    const textNodes = [];
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      textNodes.push(current);
    }
    for (const textNode of textNodes) {
      const parent = textNode.parentElement;
      if (!normalizeText(textNode.nodeValue || "") || !parent || parent.children.length === 0 || parent.closest("button, [role='button']") || parent.closest(LONGFORM_CODE_BLOCK_SELECTOR) || parent.closest(`${LONGFORM_TEXT_LEAF_SELECTOR}, [${LONGFORM_GENERATED_LEAF_ATTRIBUTE}]`)) {
        continue;
      }
      const wrapper = document2.createElement("span");
      wrapper.setAttribute(LONGFORM_GENERATED_LEAF_ATTRIBUTE, "1");
      parent.insertBefore(wrapper, textNode);
      wrapper.append(textNode);
    }
  }
  function findLongformTextLeaves(container) {
    if (!container) {
      return [];
    }
    ensureLongformTextLeafWrappers(container);
    const markedSelector = `${LONGFORM_TEXT_LEAF_SELECTOR}, [${LONGFORM_GENERATED_LEAF_ATTRIBUTE}]`;
    const descendants = Array.from(container.querySelectorAll?.("*") || []);
    const candidates = /* @__PURE__ */ new Set([
      ...container.matches?.(markedSelector) ? [container] : [],
      ...Array.from(container.querySelectorAll?.(markedSelector) || []),
      ...[container, ...descendants].filter((element) => element.children.length === 0)
    ]);
    const followingFlag = container.ownerDocument?.defaultView?.Node?.DOCUMENT_POSITION_FOLLOWING || 4;
    return Array.from(candidates).filter((element) => !element.closest("button, [role='button']") && !element.closest(LONGFORM_CODE_BLOCK_SELECTOR) && isVisible(element) && getLongformOriginalText(element)).sort((left, right) => {
      if (left === right) {
        return 0;
      }
      return left.compareDocumentPosition(right) & followingFlag ? -1 : 1;
    });
  }
  function findLongformTextBlocks(tweet) {
    const target = findLongformTarget(tweet);
    const readView = target?.matches?.(LONGFORM_READ_VIEW_SELECTOR) ? target : target?.closest?.(LONGFORM_READ_VIEW_SELECTOR);
    if (!readView || isInsideExcludedTweetContent(readView, tweet)) {
      return [];
    }
    const blocks = [];
    const seenElements = /* @__PURE__ */ new Set();
    const appendElements = (elements, kind) => {
      for (const element of elements) {
        const text = getLongformOriginalText(element);
        if (!text || seenElements.has(element) || element.closest?.(LONGFORM_CODE_BLOCK_SELECTOR)) {
          continue;
        }
        seenElements.add(element);
        blocks.push({ element, kind, text });
      }
    };
    appendElements(findLongformTextLeaves(findLongformTitle(readView)), "title");
    const body = readView.matches?.(LONGFORM_BODY_SELECTOR) ? readView : readView.querySelector?.(LONGFORM_BODY_SELECTOR);
    if (!body) {
      return blocks;
    }
    const contentBlocks = body.children.length > 0 ? Array.from(body.children) : [body];
    for (const contentBlock of contentBlocks) {
      if (contentBlock.matches?.(LONGFORM_CODE_BLOCK_SELECTOR) || contentBlock.closest?.(LONGFORM_CODE_BLOCK_SELECTOR)) {
        continue;
      }
      const textLeaves = findLongformTextLeaves(contentBlock);
      if (textLeaves.length > 0 && !(contentBlock.matches?.("section") && textLeaves[0] === contentBlock)) {
        appendElements(textLeaves, "body");
      }
    }
    return blocks;
  }
  function isLongformTranslationComplete(tweet) {
    const blocks = findLongformTextBlocks(tweet);
    return blocks.length > 0 && blocks.every(({ element }) => element.getAttribute(LONGFORM_BLOCK_TRANSLATION_ATTRIBUTE) === "1");
  }
  function setLongformElementText(element, text) {
    const renderedText = element.textContent || "";
    const leadingWhitespace = renderedText.match(/^\s*/)?.[0] || "";
    const trailingWhitespace = renderedText.match(/\s*$/)?.[0] || "";
    element.textContent = `${leadingWhitespace}${text}${trailingWhitespace}`;
  }
  function syncLongformViewToggle(button, showingOriginal) {
    button.textContent = showingOriginal ? "\u663E\u793A\u8BD1\u6587" : "\u663E\u793A\u539F\u6587";
    button.setAttribute("aria-pressed", showingOriginal ? "true" : "false");
    button.setAttribute("title", showingOriginal ? "\u663E\u793A\u6587\u7AE0\u8BD1\u6587" : "\u663E\u793A\u6587\u7AE0\u539F\u6587");
  }
  function ensureLongformViewToggle(tweet) {
    const existing = tweet?.querySelector?.(LONGFORM_VIEW_TOGGLE_SELECTOR);
    if (existing) {
      syncLongformViewToggle(existing, tweet.dataset.xatLongformView === LONGFORM_ORIGINAL_VIEW);
      return existing;
    }
    const target = findLongformTarget(tweet);
    const readView = target?.matches?.(LONGFORM_READ_VIEW_SELECTOR) ? target : target?.closest?.(LONGFORM_READ_VIEW_SELECTOR);
    const body = readView?.matches?.(LONGFORM_BODY_SELECTOR) ? readView : readView?.querySelector?.(LONGFORM_BODY_SELECTOR);
    if (!body?.parentElement) {
      return null;
    }
    const button = tweet.ownerDocument.createElement("button");
    button.type = "button";
    button.setAttribute("data-xat-longform-toggle", "1");
    button.style.display = "inline-flex";
    button.style.alignItems = "center";
    button.style.margin = "8px 0";
    button.style.padding = "0";
    button.style.border = "0";
    button.style.background = "transparent";
    button.style.color = "rgb(29, 155, 240)";
    button.style.fontSize = "14px";
    button.style.fontWeight = "500";
    button.style.lineHeight = "20px";
    button.style.cursor = "pointer";
    syncLongformViewToggle(button, tweet.dataset.xatLongformView === LONGFORM_ORIGINAL_VIEW);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const showOriginal = tweet.dataset.xatLongformView !== LONGFORM_ORIGINAL_VIEW;
      tweet.dataset.xatLongformView = showOriginal ? LONGFORM_ORIGINAL_VIEW : LONGFORM_TRANSLATION_VIEW;
      for (const { element } of findLongformTextBlocks(tweet)) {
        if (element.getAttribute(LONGFORM_BLOCK_TRANSLATION_ATTRIBUTE) !== "1") {
          continue;
        }
        const visibleText = element.getAttribute(
          showOriginal ? "data-xat-original-text" : LONGFORM_TRANSLATED_TEXT_ATTRIBUTE
        );
        if (visibleText) {
          setLongformElementText(element, visibleText);
        }
      }
      syncLongformViewToggle(button, showOriginal);
    });
    const title = findLongformTitle(readView);
    let titleBlock = title && readView.contains(title) ? title : null;
    while (titleBlock?.parentElement && titleBlock.parentElement !== readView) {
      titleBlock = titleBlock.parentElement;
    }
    readView.insertBefore(button, titleBlock?.nextSibling || readView.firstChild);
    return button;
  }
  function replaceLongformTextBlock(tweet, block, translation) {
    const element = block?.element;
    const normalizedTranslation = normalizeText(translation || "");
    if (!element || !normalizedTranslation) {
      return null;
    }
    if (!element.hasAttribute("data-xat-original-text")) {
      element.setAttribute("data-xat-original-text", block.text);
    }
    element.setAttribute(LONGFORM_BLOCK_TRANSLATION_ATTRIBUTE, "1");
    element.setAttribute("data-xat-translation", "1");
    element.setAttribute(LONGFORM_TRANSLATED_TEXT_ATTRIBUTE, normalizedTranslation);
    const visibleText = tweet.dataset.xatLongformView === LONGFORM_ORIGINAL_VIEW ? block.text : normalizedTranslation;
    setLongformElementText(element, visibleText);
    ensureLongformViewToggle(tweet);
    return element;
  }
  function extractLongformText(tweet) {
    return normalizeText(findLongformTextBlocks(tweet).map(({ text }) => text).join("\n\n"));
  }
  function findShowMoreButton(tweet) {
    return Array.from(tweet?.querySelectorAll?.(SHOW_MORE_SELECTOR) || []).find((button) => {
      if (!isVisible(button) || isDisabled(button)) {
        return false;
      }
      if (button.closest('article[data-testid="tweet"]') !== tweet) {
        return false;
      }
      return !isInsideExcludedTweetContent(button, tweet);
    }) || null;
  }
  function extractTweetText(tweet) {
    const tweetText = findPrimaryTweetText(tweet);
    return textOf(tweetText);
  }
  function createTranslationRequestPayload(tweet, metadata, expandedText) {
    return {
      ...metadata,
      text: expandedText || extractTweetText(tweet)
    };
  }
  function getTweetMetadata(tweet) {
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
      url: new URL(`/${match[1]}/status/${match[2]}`, "https://x.com").toString()
    };
  }
  function replaceTweetTextWithTranslation(tweet, translation) {
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
    return `X \u6682\u65F6\u6CA1\u6709\u8FD4\u56DE\u8BD1\u6587${error ? `\uFF1A${error}` : ""}`;
  }
  function renderTranslationStatus(tweet, message) {
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
  function removeLegacyLongformTranslations(tweet) {
    const candidates = [
      ...Array.from(tweet?.querySelectorAll?.("[data-xat-longform-translation]") || []),
      tweet?.previousElementSibling,
      tweet?.nextElementSibling
    ];
    for (const candidate of new Set(candidates)) {
      if (candidate?.matches?.("[data-xat-longform-translation]")) {
        candidate.remove();
      }
    }
  }
  function formatLongformFailureMessage(tweet, failures) {
    const blocks = findLongformTextBlocks(tweet);
    const translatedCount = blocks.filter(({ element }) => element.getAttribute(LONGFORM_BLOCK_TRANSLATION_ATTRIBUTE) === "1").length;
    const pendingCount = Math.max(0, blocks.length - translatedCount);
    const firstError = failures.find((result) => result?.error)?.error || "";
    if (translatedCount === 0 && firstError === "third-party-provider-unavailable") {
      return "\u914D\u7F6E\u7B2C\u4E09\u65B9\u7FFB\u8BD1\u670D\u52A1\u540E\u53EF\u7FFB\u8BD1\u957F\u6587";
    }
    return `\u957F\u6587\u5DF2\u7FFB\u8BD1 ${translatedCount}/${blocks.length} \u4E2A\u5185\u5BB9\u8282\u70B9\uFF0C${pendingCount} \u4E2A\u6682\u672A\u5B8C\u6210${firstError ? `\uFF1A${firstError}` : ""}`;
  }
  function findTranslateButton(tweet) {
    if (!tweet) {
      return null;
    }
    const textMatches = Array.from(tweet.querySelectorAll("span, div, button, a")).filter((element) => {
      if (!isVisible(element) || element.closest?.(TWEET_TEXT_SELECTOR) || element.querySelector?.(TWEET_TEXT_SELECTOR)) {
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
  function createTweetProcessor(options = {}) {
    const config = { ...DEFAULT_OPTIONS, ...options };
    const wait = config.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const now = config.now || (() => Date.now());
    const onEvent = config.onEvent || (() => {
    });
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
    async function processLongformTweet(tweet, metadata, staleRetries) {
      removeLegacyLongformTranslations(tweet);
      const initialBlocks = findLongformTextBlocks(tweet);
      if (initialBlocks.length === 0) {
        renderTranslationStatus(tweet, "\u6B63\u5728\u7B49\u5F85\u957F\u6587\u6B63\u6587\u52A0\u8F7D...");
        tweet.dataset.xatState = "expanded";
        tweet.dataset.xatLastAttempt = String(now());
        onEvent("translation-waiting-content", metadata);
        return;
      }
      const failedElements = /* @__PURE__ */ new Set();
      const failures = [];
      const maxConcurrency = Math.min(3, Math.max(1, Number(config.longformConcurrency) || 1));
      const requestIntervalMs = Math.max(0, Number(config.longformRequestIntervalMs) || 0);
      const retryAttempts = Math.max(0, Number(config.longformRetries) || 0);
      const retryDelayMs = Math.max(0, Number(config.longformRetryDelayMs) || 0);
      let nextRequestAt = now();
      let stale = false;
      async function waitForLongformRequestSlot() {
        const currentTime = now();
        const scheduledAt = Math.max(currentTime, nextRequestAt);
        nextRequestAt = scheduledAt + requestIntervalMs;
        const delayMs = scheduledAt - currentTime;
        if (delayMs > 0) {
          await wait(delayMs);
        }
      }
      function isCurrentArticle() {
        return Boolean(tweet.isConnected && getTweetMetadata(tweet)?.id === metadata.id);
      }
      function isCurrentLongformBlock(block) {
        if (!block?.element?.isConnected || block.element.closest?.(LONGFORM_CODE_BLOCK_SELECTOR)) {
          return false;
        }
        return findLongformTextBlocks(tweet).some((currentBlock) => currentBlock.element === block.element && currentBlock.text === block.text);
      }
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
              text: block.text
            });
          } catch (error) {
            result = { ok: false, error: error?.message || "translation-failed" };
          }
          if (result?.translation || !result?.retryable || attempt >= retryAttempts) {
            break;
          }
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
          replaceLongformTextBlock(tweet, block, result.translation);
        } else {
          failedElements.add(block.element);
          failures.push(result || { ok: false, error: "empty-result" });
        }
        const currentBlocks = findLongformTextBlocks(tweet);
        const finishedCount = currentBlocks.filter(({ element }) => element.getAttribute(LONGFORM_BLOCK_TRANSLATION_ATTRIBUTE) === "1" || failedElements.has(element)).length;
        renderTranslationStatus(tweet, `\u6B63\u5728\u7FFB\u8BD1\u957F\u6587 ${finishedCount}/${currentBlocks.length}...`);
      }
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
      const initiallyTranslated = initialBlocks.filter(({ element }) => element.getAttribute(LONGFORM_BLOCK_TRANSLATION_ATTRIBUTE) === "1").length;
      renderTranslationStatus(tweet, `\u6B63\u5728\u7FFB\u8BD1\u957F\u6587 ${initiallyTranslated}/${initialBlocks.length}...`);
      onEvent("translation-requested", metadata);
      while (!stale) {
        const pendingBlocks = findLongformTextBlocks(tweet).filter(({ element }) => element.getAttribute(LONGFORM_BLOCK_TRANSLATION_ATTRIBUTE) !== "1" && !failedElements.has(element));
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
        error: failures.find((result) => result?.error)?.error || "partial-longform-translation"
      });
    }
    async function processTweet(tweet, staleRetries = 1) {
      if (!tweet || tweet.dataset.xatState === "translated" || tweet.dataset.xatState === "skipped" || tweet.dataset.xatState === "processing") {
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
        renderTranslationStatus(tweet, "\u6B63\u5728\u83B7\u53D6 X \u81EA\u5E26\u8BD1\u6587...");
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
      processTweet
    };
  }

  // src/runtimeMessaging.js
  function sendRuntimeMessage(message, chromeApi = globalThis.chrome) {
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
          maybePromise.then((response) => settle(response ?? { ok: false, error: "empty-runtime-response" })).catch((error) => settle({ ok: false, error: error?.message || "runtime-message-failed" }));
        }
      } catch (error) {
        settle({ ok: false, error: error?.message || "runtime-message-failed" });
      }
    });
  }

  // src/contentScript.js
  var DEFAULT_SETTINGS = {
    autoExpand: true,
    autoTranslate: true,
    processViewportOnly: true
  };
  var FORCE_TRANSLATE_ARTICLE_MESSAGE = "XAT_FORCE_TRANSLATE_ARTICLE";
  var MANUAL_ARTICLE_LOAD_TIMEOUT_MS = 5e3;
  var MANUAL_ARTICLE_READY_ATTEMPTS = 50;
  var MANUAL_ARTICLE_STABLE_PASSES = 2;
  var MANUAL_ARTICLE_STABLE_INTERVAL_MS = 300;
  function getExtensionVersion() {
    return globalThis.chrome?.runtime?.getManifest?.()?.version || "unknown";
  }
  function getCookieValue(name) {
    const cookies = globalThis.document?.cookie?.split(";") || [];
    for (const cookie of cookies) {
      const [rawKey, ...rawValue] = cookie.split("=");
      if (rawKey?.trim() === name) {
        return decodeURIComponent(rawValue.join("="));
      }
    }
    return "";
  }
  function requestTranslation(metadata) {
    return sendRuntimeMessage({
      type: "XAT_TRANSLATE_TWEET",
      payload: {
        ...metadata,
        csrfToken: getCookieValue("ct0"),
        dstLang: "zh"
      }
    });
  }
  function recordDiagnostic(event, payload = {}) {
    sendRuntimeMessage({
      type: "XAT_DIAGNOSTIC_EVENT",
      payload: { event, extensionVersion: getExtensionVersion(), ...payload }
    }).then(() => {
    });
  }
  function getContentStatus() {
    const tweets = findTweetArticles(document);
    const states = tweets.reduce((acc, tweet) => {
      const state = tweet.dataset.xatState || "unprocessed";
      acc[state] = (acc[state] || 0) + 1;
      return acc;
    }, {});
    return {
      ok: true,
      active: true,
      version: getExtensionVersion(),
      url: globalThis.location?.href || "",
      canProcess: shouldProcessTimelinePage(globalThis.location?.href),
      articleCount: tweets.length,
      observedCount: document.querySelectorAll("[data-xat-observed='1']").length,
      showMoreCount: document.querySelectorAll('button[data-testid="tweet-text-show-more-link"]').length,
      statusCount: document.querySelectorAll("[data-xat-status]").length,
      translationCount: document.querySelectorAll("[data-xat-translation]").length,
      states
    };
  }
  function registerContentStatusListener() {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== "XAT_CONTENT_STATUS") {
        return false;
      }
      globalThis.__xatScan?.();
      sendResponse(getContentStatus());
      return false;
    });
  }
  registerContentStatusListener();
  if (globalThis.__xatContentScriptLoaded) {
    recordDiagnostic("content-script-duplicate", { url: globalThis.location?.href });
  } else {
    let canProcessCurrentPage = function() {
      return shouldProcessTimelinePage(globalThis.location?.href);
    }, scheduleTweet = function(tweet) {
      if (!tweet || queuedTweets.has(tweet) || !canProcessCurrentPage()) {
        return;
      }
      queuedTweets.add(tweet);
      window.setTimeout(async () => {
        queuedTweets.delete(tweet);
        if (!canProcessCurrentPage()) {
          return;
        }
        try {
          await processor.processTweet(tweet);
        } catch (error) {
          tweet.dataset.xatState = "error";
          recordDiagnostic("processing-error", { error: error?.message || "processing-error" });
          console.debug("[X Auto Translate] Failed to process tweet", error);
        }
      }, 150);
    }, observeTweet = function(tweet) {
      if (!tweet || tweet.dataset.xatObserved === "1" || !canProcessCurrentPage()) {
        return;
      }
      tweet.dataset.xatObserved = "1";
      viewportObserver.observe(tweet);
    }, delay = function(ms) {
      return new Promise((resolve) => window.setTimeout(resolve, ms));
    }, isVisibleArticleTarget = function(target) {
      if (!target?.isConnected) {
        return false;
      }
      if (typeof target.checkVisibility === "function") {
        try {
          if (!target.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
            return false;
          }
        } catch {
        }
      }
      for (let current = target; current; current = current.parentElement) {
        if (current.hidden || current.getAttribute?.("aria-hidden") === "true") {
          return false;
        }
        const style = current.ownerDocument?.defaultView?.getComputedStyle?.(current);
        if (style && (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0")) {
          return false;
        }
      }
      return true;
    }, findCurrentArticleTarget = function() {
      return findXArticleTargets(document).find(isVisibleArticleTarget) || null;
    }, waitForDocumentComplete = function(timeoutMs = MANUAL_ARTICLE_LOAD_TIMEOUT_MS) {
      if (document.readyState === "complete") {
        return Promise.resolve(true);
      }
      return new Promise((resolve) => {
        let finished = false;
        function finish(loaded) {
          if (finished) {
            return;
          }
          finished = true;
          window.clearTimeout(timer);
          document.removeEventListener("readystatechange", handleReadyStateChange);
          window.removeEventListener("load", handleLoad);
          resolve(loaded);
        }
        function handleReadyStateChange() {
          if (document.readyState === "complete") {
            finish(true);
          }
        }
        function handleLoad() {
          finish(true);
        }
        const timer = window.setTimeout(() => finish(false), timeoutMs);
        document.addEventListener("readystatechange", handleReadyStateChange);
        window.addEventListener("load", handleLoad, { once: true });
      });
    }, scan = function(root = document) {
      if (!canProcessCurrentPage()) {
        console.debug("[X Auto Translate] skipping unsupported X page");
        return;
      }
      for (const tweet of findTweetArticles(root)) {
        observeTweet(tweet);
      }
    }, isExtensionOwnedMutation = function(mutation) {
      const selector = "[data-xat-status], [data-xat-translation], [data-xat-longform-toggle]";
      const removedExtensionNode = Array.from(mutation.removedNodes).some((node) => node?.nodeType === 1 && (node.matches?.("[data-xat-longform-block-translation='1']") || node.querySelector?.("[data-xat-longform-block-translation='1']") || node.matches?.("[data-xat-longform-toggle='1']") || node.querySelector?.("[data-xat-longform-toggle='1']")));
      if (removedExtensionNode) {
        return false;
      }
      const targetElement = mutation.target?.nodeType === 1 ? mutation.target : mutation.target?.parentElement;
      if (targetElement?.closest?.(selector)) {
        return true;
      }
      return [...mutation.addedNodes, ...mutation.removedNodes].some((node) => node?.nodeType === 1 && (node.matches?.(selector) || node.querySelector?.(selector)));
    }, invalidateHydratedLongformTranslation = function(mutation) {
      const targetElement = mutation.target?.nodeType === 1 ? mutation.target : mutation.target?.parentElement;
      const translatedLeaf = targetElement?.closest?.("[data-xat-longform-block-translation='1']");
      if (!translatedLeaf) {
        return false;
      }
      const processTarget = findProcessTargetFromNode(translatedLeaf);
      const expectedTextAttribute = processTarget?.dataset.xatLongformView === "original" ? "data-xat-original-text" : "data-xat-translated-text";
      const expectedText = translatedLeaf.getAttribute(expectedTextAttribute) || "";
      if (!expectedText || translatedLeaf.textContent.trim() === expectedText) {
        return false;
      }
      translatedLeaf.removeAttribute("data-xat-longform-block-translation");
      translatedLeaf.removeAttribute("data-xat-translation");
      translatedLeaf.removeAttribute("data-xat-original-text");
      translatedLeaf.removeAttribute("data-xat-translated-text");
      return true;
    }, isOnlyLongformToggleRemoval = function(mutation) {
      const removedNodes = Array.from(mutation.removedNodes);
      return mutation.addedNodes.length === 0 && removedNodes.length === 1 && removedNodes[0]?.nodeType === 1 && removedNodes[0].matches?.("[data-xat-longform-toggle='1']");
    };
    globalThis.__xatContentScriptLoaded = true;
    const processor = createTweetProcessor({
      ...DEFAULT_SETTINGS,
      requestTranslation,
      onEvent: recordDiagnostic
    });
    const queuedTweets = /* @__PURE__ */ new WeakSet();
    let lastSeenUrl = globalThis.location?.href || "";
    const viewportObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            scheduleTweet(entry.target);
          }
        }
      },
      {
        root: null,
        rootMargin: "800px 0px",
        threshold: 0.01
      }
    );
    async function waitForStableArticleTarget() {
      let previousTarget = null;
      let previousText = "";
      let stablePasses = 0;
      for (let attempt = 0; attempt < MANUAL_ARTICLE_READY_ATTEMPTS; attempt += 1) {
        scan();
        const target = findCurrentArticleTarget();
        const text = target ? extractLongformText(target) : "";
        if (target && text) {
          if (target === previousTarget && text === previousText) {
            stablePasses += 1;
          } else {
            previousTarget = target;
            previousText = text;
            stablePasses = 1;
          }
          if (stablePasses >= MANUAL_ARTICLE_STABLE_PASSES) {
            return target;
          }
        } else {
          previousTarget = target;
          previousText = text;
          stablePasses = 0;
        }
        await delay(MANUAL_ARTICLE_STABLE_INTERVAL_MS);
      }
      return findCurrentArticleTarget();
    }
    async function translateCurrentArticle() {
      if (!canProcessCurrentPage()) {
        return { ok: false, error: "\u5F53\u524D\u9875\u9762\u4E0D\u652F\u6301\u6587\u7AE0\u7FFB\u8BD1" };
      }
      await waitForDocumentComplete();
      const target = await waitForStableArticleTarget();
      if (!target) {
        return { ok: false, error: "\u5F53\u524D\u9875\u9762\u672A\u627E\u5230 X \u957F\u6587" };
      }
      if (!extractLongformText(target)) {
        return { ok: false, error: "\u6587\u7AE0\u6B63\u6587\u8FD8\u6CA1\u52A0\u8F7D\u5B8C\u6210\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5" };
      }
      if (target.dataset.xatState === "translated" && isLongformTranslationComplete(target)) {
        return { ok: true, message: "\u6587\u7AE0\u7FFB\u8BD1\uFF1A\u5DF2\u5B58\u5728\u8BD1\u6587" };
      }
      if (target.dataset.xatState === "processing") {
        return { ok: true, message: "\u6587\u7AE0\u7FFB\u8BD1\uFF1A\u6B63\u5728\u7FFB\u8BD1\u4E2D" };
      }
      delete target.dataset.xatState;
      delete target.dataset.xatLastAttempt;
      await processor.processTweet(target);
      if (target.dataset.xatState === "translated") {
        return { ok: true, message: "\u6587\u7AE0\u7FFB\u8BD1\uFF1A\u5DF2\u5B8C\u6210" };
      }
      return { ok: false, error: target.querySelector("[data-xat-status]")?.textContent || "\u6587\u7AE0\u7FFB\u8BD1\u672A\u5B8C\u6210" };
    }
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== FORCE_TRANSLATE_ARTICLE_MESSAGE) {
        return false;
      }
      translateCurrentArticle().then(sendResponse).catch((error) => {
        recordDiagnostic("manual-article-translation-error", { error: error?.message || "manual-article-translation-error" });
        sendResponse({ ok: false, error: error?.message || "manual-article-translation-error" });
      });
      return true;
    });
    globalThis.__xatScan = scan;
    const mutationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const onlyLongformToggleRemoval = isOnlyLongformToggleRemoval(mutation);
        const invalidatedLongformTranslation = invalidateHydratedLongformTranslation(mutation);
        if (!invalidatedLongformTranslation && isExtensionOwnedMutation(mutation)) {
          continue;
        }
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) {
            continue;
          }
          if (node.matches?.('article[data-testid="tweet"]')) {
            observeTweet(node);
          } else {
            scan(node);
          }
        }
        const changedTarget = findProcessTargetFromNode(mutation.target);
        const state = changedTarget?.dataset.xatState;
        const hasTranslatedLongformText = changedTarget && findLongformTextBlocks(changedTarget).some(({ element }) => element.getAttribute("data-xat-longform-block-translation") === "1");
        const needsToggleRecovery = hasTranslatedLongformText && !changedTarget.querySelector("[data-xat-longform-toggle='1']");
        if (needsToggleRecovery) {
          ensureLongformViewToggle(changedTarget);
        }
        if (onlyLongformToggleRemoval) {
          continue;
        }
        const needsHydrationRetry = state === "expanded";
        const hasNewLongformText = state === "translated" && !isLongformTranslationComplete(changedTarget);
        if (changedTarget && (needsHydrationRetry || hasNewLongformText)) {
          if (hasNewLongformText) {
            delete changedTarget.dataset.xatState;
          }
          delete changedTarget.dataset.xatLastAttempt;
          scheduleTweet(changedTarget);
        }
      }
    });
    scan();
    mutationObserver.observe(document.documentElement, {
      characterData: true,
      childList: true,
      subtree: true
    });
    window.setInterval(() => {
      const currentUrl = globalThis.location?.href || "";
      if (currentUrl !== lastSeenUrl) {
        lastSeenUrl = currentUrl;
        scan();
      }
    }, 1e3);
    console.debug("[X Auto Translate] content script active");
    recordDiagnostic("content-script-active", { url: globalThis.location?.href });
  }
})();
