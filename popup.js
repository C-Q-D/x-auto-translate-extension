// 本文件负责扩展弹窗中的页面检测、腾讯云配置和手动文章翻译入口。
// 弹窗只负责发送控制消息和渲染状态，不直接读取 X 页面 DOM 或执行翻译。
const STATS_KEY = "xatStats";
const FORCE_TRANSLATE_ARTICLE_MESSAGE = "XAT_FORCE_TRANSLATE_ARTICLE";

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) {
    element.textContent = String(value ?? "-");
  }
}

function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      resolve(tab || null);
    });
  });
}

function isXUrl(url = "") {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "x.com" || parsed.hostname === "twitter.com";
  } catch {
    return false;
  }
}

function sendContentStatus(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "XAT_CONTENT_STATUS" }, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        resolve({ ok: false, error: error.message || "content-script-unavailable" });
        return;
      }
      resolve(response || { ok: false, error: "empty-content-status" });
    });
  });
}

/**
 * 向当前内容脚本发送“仅翻译 X Article 长文”的手动触发消息。
 *
 * @param {number} tabId 当前激活标签页 ID。
 * @returns {Promise<object>} 返回 content script 的处理结果；通信失败时转换为稳定错误对象。
 * @sideEffects 会通过 chrome.tabs.sendMessage 与当前标签页通信，不直接修改页面 DOM。
 */
function sendArticleTranslationRequest(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: FORCE_TRANSLATE_ARTICLE_MESSAGE }, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        resolve({ ok: false, error: error.message || "content-script-unavailable" });
        return;
      }
      resolve(response || { ok: false, error: "empty-article-translation-response" });
    });
  });
}

function sendBackgroundMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        resolve({ ok: false, error: error.message || "background-unavailable" });
        return;
      }
      resolve(response || { ok: false, error: "empty-background-response" });
    });
  });
}

function setTencentButtonsDisabled(disabled) {
  for (const id of ["tencentSave", "tencentTest", "tencentDelete"]) {
    const button = document.getElementById(id);
    if (button) {
      button.disabled = disabled;
    }
  }
}

function renderTencentStatus(result, successText = "") {
  if (!result?.ok) {
    setText("tencentStatus", `配置状态：失败（${result?.providerCode || result?.error || "未知错误"}）`);
    return;
  }

  if (successText) {
    setText("tencentStatus", `配置状态：${successText}`);
    return;
  }

  setText(
    "tencentStatus",
    result.configured ? `配置状态：已配置（${result.region}）` : "配置状态：未配置",
  );
}

async function refreshTencentStatus() {
  const result = await sendBackgroundMessage({ type: "XAT_TENCENT_CONFIG_STATUS" });
  if (result?.ok && result.region) {
    const regionInput = document.getElementById("tencentRegion");
    if (regionInput) {
      regionInput.value = result.region;
    }
  }
  renderTencentStatus(result);
}

async function saveTencentConfig() {
  const secretId = document.getElementById("tencentSecretId")?.value || "";
  const secretKey = document.getElementById("tencentSecretKey")?.value || "";
  const region = document.getElementById("tencentRegion")?.value || "";
  if (!secretId.trim() || !secretKey.trim()) {
    renderTencentStatus({ ok: false, error: "请填写 SecretId 和 SecretKey" });
    return;
  }

  setTencentButtonsDisabled(true);
  try {
    const result = await sendBackgroundMessage({
      type: "XAT_TENCENT_CONFIG_SAVE",
      payload: { secretId, secretKey, region },
    });
    renderTencentStatus(result, result?.ok ? `已保存（${result.region}）` : "");
    if (result?.ok) {
      const secretKeyInput = document.getElementById("tencentSecretKey");
      if (secretKeyInput) {
        secretKeyInput.value = "";
      }
    }
  } finally {
    setTencentButtonsDisabled(false);
  }
}

async function testTencentConfig() {
  setTencentButtonsDisabled(true);
  try {
    const result = await sendBackgroundMessage({ type: "XAT_TENCENT_CONFIG_TEST" });
    renderTencentStatus(result, result?.ok ? `测试成功：${result.translation}` : "");
  } finally {
    setTencentButtonsDisabled(false);
  }
}

async function deleteTencentConfig() {
  setTencentButtonsDisabled(true);
  try {
    const result = await sendBackgroundMessage({ type: "XAT_TENCENT_CONFIG_DELETE" });
    if (result?.ok) {
      for (const id of ["tencentSecretId", "tencentSecretKey"]) {
        const input = document.getElementById(id);
        if (input) {
          input.value = "";
        }
      }
    }
    renderTencentStatus(result);
  } finally {
    setTencentButtonsDisabled(false);
  }
}

function injectContentScript(tabId) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        files: ["dist/contentScript.js"],
      },
      () => {
        const error = chrome.runtime.lastError;
        resolve({ ok: !error, error: error?.message || "" });
      },
    );
  });
}

function formatStates(states = {}) {
  const parts = Object.entries(states)
    .filter(([, count]) => count)
    .map(([state, count]) => `${state}:${count}`);
  return parts.length ? parts.join(" ") : "-";
}

function renderPageStatus(status) {
  if (!status?.ok) {
    setText("pageStatus", status?.error || "未连接");
    setText("pageCounts", "-");
    return;
  }

  setText("pageStatus", status.canProcess ? "已注入" : "详情页跳过");
  setText("pageCounts", `${status.articleCount}帖 / ${status.translationCount}译文 / ${status.showMoreCount}展开按钮`);
  setText("lastEvent", formatStates(status.states));
  setText("version", status.version || chrome.runtime.getManifest().version);
}

function renderArticleTranslationStatus(result) {
  if (!result?.ok) {
    setText("articleTranslationStatus", `文章翻译：失败（${result?.error || "未知错误"}）`);
    return;
  }

  setText("articleTranslationStatus", result.message || "文章翻译：已发送请求");
}

async function probeCurrentPage() {
  const button = document.getElementById("probeCurrentPage");
  if (button) {
    button.disabled = true;
  }

  try {
    const tab = await getActiveTab();
    if (!tab?.id || !isXUrl(tab.url)) {
      setText("currentPage", "当前页：不是 X 页面");
      renderPageStatus({ ok: false, error: "请切到 x.com 页面后再检测" });
      return;
    }

    setText("currentPage", `当前页：${new URL(tab.url).hostname}`);
    let status = await sendContentStatus(tab.id);
    if (!status.ok) {
      setText("pageStatus", "未注入，正在尝试恢复...");
      const injected = await injectContentScript(tab.id);
      if (!injected.ok) {
        renderPageStatus({ ok: false, error: `注入失败：${injected.error}` });
        return;
      }
      status = await sendContentStatus(tab.id);
    }

    renderPageStatus(status);
  } finally {
    if (button) {
      button.disabled = false;
    }
  }
}

async function translateCurrentArticle() {
  const button = document.getElementById("translateCurrentArticle");
  if (button) {
    button.disabled = true;
  }

  try {
    const tab = await getActiveTab();
    if (!tab?.id || !isXUrl(tab.url)) {
      renderArticleTranslationStatus({ ok: false, error: "请切到 X 文章页面后再翻译" });
      return;
    }

    setText("articleTranslationStatus", "文章翻译：正在发送请求...");
    const result = await sendArticleTranslationRequest(tab.id);
    renderArticleTranslationStatus(result);
  } finally {
    if (button) {
      button.disabled = false;
    }
  }
}

async function renderStats() {
  const result = await chrome.storage.local.get(STATS_KEY);
  const stats = result?.[STATS_KEY] || {};

  setText("expanded", stats.expanded || 0);
  setText("requested", stats.requested || 0);
  setText("translated", stats.translated || 0);
  setText("skipped", stats.skipped || 0);
  setText("failed", stats.failed || 0);
  setText("lastEvent", stats.lastError || stats.lastEvent || "-");
  setText("version", stats.extensionVersion || chrome.runtime.getManifest().version);
}

renderStats();
probeCurrentPage();
refreshTencentStatus();

document.getElementById("probeCurrentPage")?.addEventListener("click", probeCurrentPage);
document.getElementById("translateCurrentArticle")?.addEventListener("click", translateCurrentArticle);
document.getElementById("tencentSave")?.addEventListener("click", saveTencentConfig);
document.getElementById("tencentTest")?.addEventListener("click", testTencentConfig);
document.getElementById("tencentDelete")?.addEventListener("click", deleteTencentConfig);
