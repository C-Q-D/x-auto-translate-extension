# X Auto Expand Translate

Chrome extension for X web pages. It expands folded timeline posts, calls X Web's own Grok translation endpoint with the signed-in browser session, and replaces the timeline post body with the returned Chinese translation.

## Install locally

Run:

```powershell
npm install
npm run build
```

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this folder: `E:\workbench\x-auto-translate-extension`.
5. Open or reload `https://x.com`.
6. Open the extension popup on the X tab. It should show version `0.1.1` and a page status.

## Behavior

- Finds tweets with `article[data-testid="tweet"]`.
- Clicks `button[data-testid="tweet-text-show-more-link"]` before translation.
- Waits briefly for the full post text to appear.
- Extracts the tweet status URL from links like `/user/status/123`.
- Sends the tweet id to `https://api.x.com/2/grok/translation.json` with X Web headers, the page `ct0` CSRF token, and `dst_lang: "zh"`.
- Uses `result.text` from the response as the translation.
- Replaces `[data-testid="tweetText"]` with the translated text and keeps the original text only in an internal `data-xat-original-text` attribute.
- Skips posts when X returns an empty translation.
- Persists successful translations and skipped post ids in local extension storage so service worker restarts do not immediately request the same translations. Successful translations expire after 7 days; skipped entries expire after 6 hours so temporary X API misses can be retried.
- Processes only tweets near the viewport and marks each tweet to avoid repeated work.
- The extension popup shows diagnostic counters for expanded, requested, translated, skipped, failed attempts, and the loaded extension version.
- The popup can detect the current X tab. If the content script is missing after an extension reload, it attempts to inject it into the current X page and then shows article, translation, and show-more counts.

The extension does not send post text to any third-party translation API. It relies on the logged-in X Web session and X's own translation API. If X changes required headers, the popup diagnostics should show `translation-http-*` or another short error so the request strategy can be adjusted.
