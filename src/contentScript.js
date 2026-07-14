import {
  createTweetProcessor,
  extractLongformText,
  findProcessTargetFromNode,
  findTweetArticles,
  findXArticleTargets,
  shouldProcessTimelinePage,
} from "./tweetProcessor.js";
import { sendRuntimeMessage } from "./runtimeMessaging.js";

const DEFAULT_SETTINGS = {
  autoExpand: true,
  autoTranslate: true,
  processViewportOnly: true,
};
const FORCE_TRANSLATE_ARTICLE_MESSAGE = "XAT_FORCE_TRANSLATE_ARTICLE";
const MANUAL_ARTICLE_LOAD_TIMEOUT_MS = 5000;
const MANUAL_ARTICLE_READY_ATTEMPTS = 50;
const MANUAL_ARTICLE_STABLE_PASSES = 2;
const MANUAL_ARTICLE_STABLE_INTERVAL_MS = 300;

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
      dstLang: "zh",
    },
  });
}

function recordDiagnostic(event, payload = {}) {
  sendRuntimeMessage({
    type: "XAT_DIAGNOSTIC_EVENT",
    payload: { event, extensionVersion: getExtensionVersion(), ...payload },
  }).then(() => {
    // Ignore diagnostics transport errors; they must never affect tweet processing.
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
    states,
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
  globalThis.__xatContentScriptLoaded = true;

  const processor = createTweetProcessor({
    ...DEFAULT_SETTINGS,
    requestTranslation,
    onEvent: recordDiagnostic,
  });
  const queuedTweets = new WeakSet();
  let lastSeenUrl = globalThis.location?.href || "";

  function canProcessCurrentPage() {
    return shouldProcessTimelinePage(globalThis.location?.href);
  }

  function scheduleTweet(tweet) {
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
  }

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
      threshold: 0.01,
    },
  );

  function observeTweet(tweet) {
    if (!tweet || tweet.dataset.xatObserved === "1" || !canProcessCurrentPage()) {
      return;
    }

    tweet.dataset.xatObserved = "1";
    viewportObserver.observe(tweet);
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  /**
   * 判断长文目标及其祖先容器是否仍参与当前页面展示。
   * X 的单页导航可能暂时保留旧文章 DOM；隐藏节点不能作为手动翻译目标，否则会误报已有译文。
   *
   * @param {Element | null} target 候选长文节点。
   * @returns {boolean} 节点已连接且未被自身或祖先隐藏时返回 true。
   * @sideEffects 本函数只读取 DOM 和计算样式，不修改页面。
   */
  function isVisibleArticleTarget(target) {
    if (!target?.isConnected) {
      return false;
    }

    if (typeof target.checkVisibility === "function") {
      try {
        if (!target.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
          return false;
        }
      } catch {
        // 旧版浏览器可能不接受可见性选项；继续使用下面的祖先样式检查作为兼容回退。
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
  }

  /**
   * 从页面候选节点中选择当前可见的 X Article 长文。
   *
   * @returns {Element | null} 当前可见长文节点；不存在时返回 null。
   * @sideEffects 本函数只扫描 DOM，不修改节点状态。
   */
  function findCurrentArticleTarget() {
    return findXArticleTargets(document).find(isVisibleArticleTarget) || null;
  }

  function waitForDocumentComplete(timeoutMs = MANUAL_ARTICLE_LOAD_TIMEOUT_MS) {
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

      // X 是 SPA，页面 load 不等于文章正文已 hydrate；这里先等外层页面尽量完成，再继续等长文 DOM 稳定。
      const timer = window.setTimeout(() => finish(false), timeoutMs);
      document.addEventListener("readystatechange", handleReadyStateChange);
      window.addEventListener("load", handleLoad, { once: true });
    });
  }

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

      // X Article 正文经常分批 hydrate；两次读取一致后再翻译，避免截取到半篇文章。
      await delay(MANUAL_ARTICLE_STABLE_INTERVAL_MS);
    }

    return findCurrentArticleTarget();
  }

  function hasRenderedArticleTranslation(target) {
    const embeddedTranslation = target?.querySelector?.("[data-xat-longform-translation]");
    const siblingTranslation = target?.nextElementSibling?.matches?.("[data-xat-longform-translation]")
      ? target.nextElementSibling
      : null;
    const translationNode = embeddedTranslation || siblingTranslation;
    return Boolean(translationNode?.textContent?.trim());
  }

  async function translateCurrentArticle() {
    if (!canProcessCurrentPage()) {
      return { ok: false, error: "当前页面不支持文章翻译" };
    }

    await waitForDocumentComplete();
    const target = await waitForStableArticleTarget();
    if (!target) {
      return { ok: false, error: "当前页面未找到 X 长文" };
    }
    if (!extractLongformText(target)) {
      return { ok: false, error: "文章正文还没加载完成，请稍后再试" };
    }

    if (target.dataset.xatState === "translated" && hasRenderedArticleTranslation(target)) {
      return { ok: true, message: "文章翻译：已存在译文" };
    }
    if (target.dataset.xatState === "processing") {
      return { ok: true, message: "文章翻译：正在翻译中" };
    }

    // 手动触发代表用户已经看到文章区域；这里清理自动流程留下的冷却状态，让本次点击立即重读当前 DOM。
    delete target.dataset.xatState;
    delete target.dataset.xatLastAttempt;
    await processor.processTweet(target);

    if (target.dataset.xatState === "translated") {
      return { ok: true, message: "文章翻译：已完成" };
    }
    return { ok: false, error: target.querySelector("[data-xat-status]")?.textContent || "文章翻译未完成" };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== FORCE_TRANSLATE_ARTICLE_MESSAGE) {
      return false;
    }

    translateCurrentArticle()
      .then(sendResponse)
      .catch((error) => {
        recordDiagnostic("manual-article-translation-error", { error: error?.message || "manual-article-translation-error" });
        sendResponse({ ok: false, error: error?.message || "manual-article-translation-error" });
      });
    return true;
  });

  function scan(root = document) {
    if (!canProcessCurrentPage()) {
      console.debug("[X Auto Translate] skipping unsupported X page");
      return;
    }

    for (const tweet of findTweetArticles(root)) {
      observeTweet(tweet);
    }
  }
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
        // 独立 X Article 正文可能在外壳处理失败后才 hydrate；DOM 变化说明内容已有机会变完整，需绕过短冷却。
        delete changedTarget.dataset.xatLastAttempt;
        scheduleTweet(changedTarget);
      }
    }
  });

  scan();
  mutationObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  window.setInterval(() => {
    const currentUrl = globalThis.location?.href || "";
    if (currentUrl !== lastSeenUrl) {
      lastSeenUrl = currentUrl;
      scan();
    }
  }, 1000);

  console.debug("[X Auto Translate] content script active");
  recordDiagnostic("content-script-active", { url: globalThis.location?.href });
}
