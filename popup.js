const STATS_KEY = "xatStats";

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

document.getElementById("probeCurrentPage")?.addEventListener("click", probeCurrentPage);
