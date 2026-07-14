(() => {
  // src/tweetProcessor.js
  var SHOW_MORE_SELECTOR = 'button[data-testid="tweet-text-show-more-link"]';
  var TWEET_TEXT_SELECTOR = '[data-testid="tweetText"]';
  var CARD_WRAPPER_SELECTOR = '[data-testid="card.wrapper"]';
  var LONGFORM_READ_VIEW_SELECTOR = '[data-testid="twitterArticleReadView"], [data-testid="twitterArticleRichTextView"]';
  var LONGFORM_TITLE_SELECTOR = '[data-testid="twitter-article-title"]';
  var LONGFORM_BODY_SELECTOR = '[data-testid="longformRichTextComponent"]';
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
    retryCooldownMs: 7e3
  };
  var STATUS_URL_PATTERN = /\/([^/?#]+)\/status\/(\d+)/;
  function normalizeText(text) {
    return text.replace(/\s+/g, " ").trim().replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, "$1$2").replace(/([，。！？；：、])\s+/g, "$1").replace(/\s+([，。！？；：、,.!?;:%])/g, "$1");
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
  function extractLongformText(tweet) {
    const target = findLongformTarget(tweet);
    const readView = target?.matches?.(LONGFORM_READ_VIEW_SELECTOR) ? target : target?.closest?.(LONGFORM_READ_VIEW_SELECTOR);
    if (!readView || isInsideExcludedTweetContent(readView, tweet)) {
      return "";
    }
    const parts = [
      textOf(readView.querySelector(LONGFORM_TITLE_SELECTOR)),
      textOf(readView.querySelector(LONGFORM_BODY_SELECTOR))
    ].filter(Boolean);
    return normalizeText(parts.join("\n\n"));
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
    if (isLongformTweet(tweet)) {
      const longformText = extractLongformText(tweet);
      if (!longformText) {
        return null;
      }
      return {
        ...metadata,
        contentType: LONGFORM_CONTENT_TYPE,
        text: longformText
      };
    }
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
  function renderLongformTranslation(tweet, translation) {
    const target = findLongformTarget(tweet);
    const readView = target?.matches?.(LONGFORM_READ_VIEW_SELECTOR) ? target : target?.closest?.(LONGFORM_READ_VIEW_SELECTOR);
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
    return isLongformTweet(tweet) ? renderLongformTranslation(tweet, translation) : replaceTweetTextWithTranslation(tweet, translation);
  }
  function formatTranslationFailureMessage(tweet, result) {
    const error = result?.error || "";
    if (isLongformTweet(tweet)) {
      if (error === "third-party-provider-unavailable") {
        return "\u914D\u7F6E\u7B2C\u4E09\u65B9\u7FFB\u8BD1\u670D\u52A1\u540E\u53EF\u7FFB\u8BD1\u957F\u6587";
      }
      return `\u957F\u6587\u6682\u65F6\u6CA1\u6709\u8FD4\u56DE\u8BD1\u6587${error ? `\uFF1A${error}` : ""}`;
    }
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
        renderTranslationStatus(tweet, isLongformTweet(tweet) ? "\u6B63\u5728\u83B7\u53D6\u957F\u6587\u8BD1\u6587..." : "\u6B63\u5728\u83B7\u53D6 X \u81EA\u5E26\u8BD1\u6587...");
        const payload = createTranslationRequestPayload(tweet, metadata, expandedText);
        if (!payload) {
          renderTranslationStatus(tweet, "\u6B63\u5728\u7B49\u5F85\u957F\u6587\u6B63\u6587\u52A0\u8F7D...");
          tweet.dataset.xatState = "expanded";
          tweet.dataset.xatLastAttempt = String(now());
          onEvent("translation-waiting-content", metadata);
          return;
        }
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
    }, scan = function(root = document) {
      if (!canProcessCurrentPage()) {
        console.debug("[X Auto Translate] skipping unsupported X page");
        return;
      }
      for (const tweet of findTweetArticles(root)) {
        observeTweet(tweet);
      }
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
    globalThis.__xatScan = scan;
    const mutationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
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
        if (changedTarget && changedTarget.dataset.xatState === "expanded") {
          delete changedTarget.dataset.xatLastAttempt;
          scheduleTweet(changedTarget);
        }
      }
    });
    scan();
    mutationObserver.observe(document.documentElement, {
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
