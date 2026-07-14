import {
  createTweetProcessor,
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

  async function translateCurrentArticle() {
    if (!canProcessCurrentPage()) {
      return { ok: false, error: "当前页面不支持文章翻译" };
    }

    scan();
    const target = findXArticleTargets(document)[0];
    if (!target) {
      return { ok: false, error: "当前页面未找到 X 长文" };
    }

    if (target.dataset.xatState === "translated") {
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
