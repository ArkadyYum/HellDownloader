const HOST_NAME = 'com.vibecoding.videoclipper';

// Active native ports keyed by tabId
const activePorts = new Map();
// Map chrome downloadId -> { tabId, port, fileName }
const pendingChromeDownloads = new Map();
// Captured media stream URLs (.m3u8, .mpd, .mp4, embed players) per tabId from webRequest
const tabStreams = new Map();

function normalizeStreamUrl(urlStr) {
  if (!urlStr || !/^https?:\/\//i.test(urlStr)) return '';
  // Convert Kodik HLS segment URLs (.../720.mp4:hls:seg-1-v1-a1.ts) directly into the master manifest URL!
  if (/\.mp4:hls:seg-/i.test(urlStr)) {
    return urlStr.replace(/:hls:seg-[^?]+/i, ':hls:manifest.m3u8');
  }
  // Convert Instagram / Threads byte-range segment URLs into full progressive MP4 URLs
  if ((urlStr.includes('cdninstagram.com') || urlStr.includes('fbcdn.net')) && /[?&]bytestart=/i.test(urlStr)) {
    return urlStr.replace(/([?&])bytestart=\d+(&byteend=\d+)?/gi, '$1').replace(/[?&]+$/, '');
  }
  return urlStr;
}

function isMediaStreamUrl(rawUrlStr) {
  const urlStr = normalizeStreamUrl(rawUrlStr);
  if (!urlStr || !/^https?:\/\//i.test(urlStr)) return false;
  const lower = urlStr.toLowerCase();

  // Ignore static UI decoy animations and ad-network video servers (e.g. serving-sys, mradx, doubleclick)
  if (lower.includes('ttwstatic.com') || lower.includes('tiktok_web_login_static') || lower.includes('playback1.mp4')) return false;
  if (/(serving-sys\.|eyeblaster\.|flashtalking\.|adriver\.ru|adfox\.ru|betweendigital\.|buzzoola\.|videonow\.ru|pladform\.ru|MoeVideo|imasdk\.googleapis\.com|2mdn\.net)/i.test(lower)) return false;

  // Ignore segments (.ts, .m4s), DASH init segments (init-*.mp4), audio-only HLS sub-playlists (audio-*.m3u8), images, scripts, tracking, and googlevideo ranges
  if (/\.(ts|m4s|aac|vtt|srt|jpg|jpeg|png|gif|webp|svg|js|css|woff2?)(\?|$)/i.test(lower)) return false;
  if (/\/(init|seg|segment|chunk|frag|part)[-_][^/]*\.(mp4|webm|m4s)(\?|$)/i.test(lower)) return false;
  if (/\/(audio[-_][^/]*\.m3u8|playlist_a\.m3u8)(\?|$)/i.test(lower)) return false;
  if (/[?&]st=audio\b/i.test(lower)) return false;
  if (lower.includes('googlevideo.com/videoplayback') && lower.includes('range=')) return false;
  if (lower.includes('json_preview=1') || lower.includes('vh-canvas-converted')) return false;
  if (
    lower.includes('mc.yandex.ru') ||
    lower.includes('an.yandex.ru') ||
    lower.includes('doubleclick.net') ||
    lower.includes('googlesyndication.com') ||
    lower.includes('yandexadexchange') ||
    lower.includes('mradx.net') ||
    lower.includes('target.my.com') ||
    lower.includes('ads.vk.com')
  ) {
    return false;
  }

  // Known embed player iframe URLs that yt-dlp supports directly
  if (/(vk\.com|vkvideo\.ru)\/video_ext\.php/i.test(lower)) return true;
  if (/frontend\.vh\.yandex\.ru\/player\/[a-z0-9_-]+/i.test(lower)) return true;
  if (/rutube\.ru\/play\/embed\//i.test(lower)) return true;
  if (/youtube\.com\/embed\//i.test(lower)) return true;
  if (/ok\.ru\/videoembed\//i.test(lower)) return true;

  // Match TikTok direct CDN video streams (/video/tos/ or mime_type=video_mp4)
  if (lower.includes('/video/tos/') || lower.includes('mime_type=video_mp4')) {
    return true;
  }

  // Match VK / OK / CVH (player.cdnvideohub.com) DASH & HLS manifests on okcdn.ru (ct=6 is DASH mpd, ct=8 is HLS)
  if (lower.includes('okcdn.ru/') && /[?&]ct=(6|8)\b/i.test(lower) && !lower.includes('bytes=')) {
    return true;
  }

  // Match HLS (.m3u8), DASH (.mpd), or direct MP4/WebM streams
  if (/\.m3u8(\?|$|:)/i.test(lower) || lower.includes('manifest.m3u8') || lower.includes('master.m3u8') || lower.includes('index.m3u8')) {
    return true;
  }
  if (/\.mpd(\?|$)/i.test(lower) || lower.includes('manifest.mpd')) {
    return true;
  }
  if (/\.(mp4|webm)(\?|$)/i.test(lower)) {
    return true;
  }
  return false;
}

function scoreStreamUrl(urlStr) {
  const lower = (urlStr || '').toLowerCase();
  if (/(vk\.com|vkvideo\.ru)\/video_ext\.php/i.test(lower) || /(vk\.com|vkvideo\.ru)\/video-?\d+_\d+/i.test(lower)) return 110;
  if (/\.mp4:hls:manifest\.m3u8/i.test(lower)) return 108;
  if (lower.includes('okcdn.ru/') && /[?&]ct=(6|8)\b/i.test(lower)) return 106;
  if (lower.includes('master.m3u8') || lower.includes('manifest.mpd') || /\.mpd(\?|$)/.test(lower)) return 105;
  if (/\/playlists\/media\/video[-_]/i.test(lower)) return 30; // Single-quality HLS sub-playlist (prefer master.m3u8 or page URL)
  if (lower.includes('manifest.m3u8') || /\.m3u8(\?|$)/.test(lower)) return 100;
  if (/rutube\.ru\/play\/embed\//i.test(lower)) return 95;
  if (/\/(1080|720|480|360)\.mp4/.test(lower)) return 80;
  if (/\.(mp4|webm)(\?|$)/.test(lower)) return 65;
  if (/frontend\.vh\.yandex\.ru\/player\//i.test(lower)) return 55;
  return 40;
}

function expandEmbedUrlVariants(urlStr) {
  const results = [];
  if (!urlStr || !/^https?:\/\//i.test(urlStr)) return results;
  const norm = normalizeStreamUrl(urlStr);
  results.push(norm);
  try {
    const u = new URL(norm);
    if (/(vk\.com|vkvideo\.ru)$/i.test(u.hostname) && u.pathname.includes('video_ext.php')) {
      const oid = u.searchParams.get('oid');
      const id = u.searchParams.get('id');
      if (oid && id) {
        results.push(`https://vkvideo.ru/video${oid}_${id}`);
      }
    }
  } catch (_) {}
  return results;
}

function recordStreamForTab(tabId, rawStreamUrl, refererUrl) {
  if (!tabId || tabId < 0) return;
  const variants = expandEmbedUrlVariants(rawStreamUrl);
  for (const streamUrl of variants) {
    if (!isMediaStreamUrl(streamUrl)) continue;
    let list = tabStreams.get(tabId);
    if (!list) {
      list = [];
      tabStreams.set(tabId, list);
    }
    const existingIdx = list.findIndex((item) => item.url === streamUrl);
    if (existingIdx !== -1) list.splice(existingIdx, 1);

    list.unshift({
      url: streamUrl,
      referer: refererUrl || '',
      score: scoreStreamUrl(streamUrl),
      time: Date.now()
    });

    if (list.length > 25) list.length = 25;
  }
}

// Sniff .m3u8 / .mpd / .mp4 / Kodik segments / Embed iframes across all tabs
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const norm = normalizeStreamUrl(details.url);
    if (isMediaStreamUrl(norm)) {
      recordStreamForTab(details.tabId, norm, details.initiator || details.documentUrl || '');
    }
  },
  { urls: ['<all_urls>'] }
);

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStreams.delete(tabId);
});

// Auto-reinject content scripts into open tabs when the extension is installed or updated/reloaded
async function reinjectIntoOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    for (const tab of tabs) {
      if (!tab.id) continue;
      try {
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id, allFrames: true },
          files: ['content.css']
        });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ['content.js']
        });
      } catch (_) {}
    }
  } catch (_) {}
}

chrome.runtime.onInstalled.addListener(() => {
  reinjectIntoOpenTabs();
});

// Toggle UI when clicking extension toolbar icon
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_CLIPPER_UI' }, { frameId: 0 });
  } catch (_) {
    try {
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id, allFrames: true },
        files: ['content.css']
      });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['content.js']
      });
      await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_CLIPPER_UI' }, { frameId: 0 });
    } catch (err) {
      console.warn('Cannot inject on this tab:', err);
    }
  }
});

// Track Chrome's native download completion or cancellation
chrome.downloads.onChanged.addListener(async (delta) => {
  const info = pendingChromeDownloads.get(delta.id);
  if (!info) return;

  if (delta.state?.current === 'complete') {
    pendingChromeDownloads.delete(delta.id);
    const [item] = await chrome.downloads.search({ id: delta.id });
    const savedName = item?.filename ? item.filename.split(/[\\/]/).pop() : info.fileName;

    try {
      await chrome.tabs.sendMessage(
        info.tabId,
        {
          type: 'DOWNLOAD_EVENT',
          event: {
            type: 'complete',
            downloadId: delta.id,
            fileName: savedName
          }
        }
      );
    } catch (_) {}

    try {
      info.port.postMessage({ action: 'cleanup', requestId: String(Date.now()) });
      setTimeout(() => {
        try { info.port.disconnect(); } catch (_) {}
        if (activePorts.get(info.tabId) === info.port) {
          activePorts.delete(info.tabId);
        }
      }, 200);
    } catch (_) {}
  } else if (delta.state?.current === 'interrupted') {
    pendingChromeDownloads.delete(delta.id);
    try {
      await chrome.tabs.sendMessage(
        info.tabId,
        {
          type: 'DOWNLOAD_EVENT',
          event: {
            type: 'cancelled',
            message: 'Save cancelled'
          }
        }
      );
    } catch (_) {}

    try {
      info.port.postMessage({ action: 'cleanup', requestId: String(Date.now()) });
      setTimeout(() => {
        try { info.port.disconnect(); } catch (_) {}
        if (activePorts.get(info.tabId) === info.port) {
          activePorts.delete(info.tabId);
        }
      }, 200);
    } catch (_) {}
  }
});

// Export browser cookies for target URLs in strict Netscape cookies.txt format (compatible with Python MozillaCookieJar)
async function getCookiesTxtForUrls(urls) {
  try {
    const domainsToFetch = new Set();
    for (const uStr of urls) {
      if (!uStr || !/^https?:\/\//i.test(uStr)) continue;
      try {
        const parsed = new URL(uStr);
        const host = parsed.hostname.toLowerCase();
        if (host.includes('youtube.com') || host.includes('youtu.be')) {
          domainsToFetch.add('youtube.com');
        } else if (host.includes('vk.com') || host.includes('vkvideo.ru')) {
          domainsToFetch.add('vk.com');
          domainsToFetch.add('vkvideo.ru');
        } else if (host.includes('yandex.ru') || host.includes('kinopoisk.ru')) {
          domainsToFetch.add('yandex.ru');
          domainsToFetch.add('kinopoisk.ru');
        } else if (host.includes('tiktok.com') || host.includes('tiktokcdn')) {
          domainsToFetch.add('tiktok.com');
        } else if (host.includes('instagram.com') || host.includes('threads.net') || host.includes('threads.com') || host.includes('cdninstagram.com')) {
          domainsToFetch.add('instagram.com');
          domainsToFetch.add('threads.net');
          domainsToFetch.add('threads.com');
        } else if (host.includes('x.com') || host.includes('twitter.com') || host.includes('twimg.com')) {
          domainsToFetch.add('x.com');
          domainsToFetch.add('twitter.com');
        } else {
          domainsToFetch.add(host);
          const parts = host.split('.');
          if (parts.length > 2) {
            domainsToFetch.add(parts.slice(-2).join('.'));
          }
        }
      } catch (_) {}
    }

    const seen = new Set();
    const relevant = [];
    for (const d of domainsToFetch) {
      const list = await chrome.cookies.getAll({ domain: d });
      for (const c of list) {
        if (!c.domain || !c.name) continue;
        const key = `${c.domain}|${c.path}|${c.name}`;
        if (!seen.has(key)) {
          seen.add(key);
          relevant.push(c);
        }
      }
    }

    const lines = ['# Netscape HTTP Cookie File', '# Generated by Video Clipper Extension'];
    for (const c of relevant) {
      const domain = c.domain.trim();
      if (!domain) continue;
      // CRITICAL: Python's http.cookiejar.MozillaCookieJar strictly asserts:
      // domain.startswith('.') == (includeSubdomains == 'TRUE')
      const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
      const pathStr = (c.path || '/').replace(/[\r\n\t]/g, '');
      const secure = c.secure ? 'TRUE' : 'FALSE';
      const expiry = c.expirationDate ? Math.floor(c.expirationDate) : (Math.floor(Date.now() / 1000) + 86400 * 30);
      const name = (c.name || '').replace(/[\r\n\t]/g, '');
      if (!name) continue;
      const value = (c.value || '').replace(/[\r\n\t]/g, '');
      lines.push(`${domain}\t${includeSubdomains}\t${pathStr}\t${secure}\t${expiry}\t${name}\t${value}`);
    }
    return lines.join('\n') + '\n';
  } catch (err) {
    console.warn('Cookie export error:', err);
    return '';
  }
}

function collectTabStreams(tabId, extraStreams = [], pageUrl = '', activeFrameId = 0) {
  const combined = [];
  const seen = new Set();

  const addCandidate = (rawUrl, referer, bonus = 0) => {
    for (const url of expandEmbedUrlVariants(rawUrl)) {
      if (!url || !isMediaStreamUrl(url) || seen.has(url)) continue;
      seen.add(url);
      combined.push({
        url,
        referer: referer || pageUrl || '',
        score: scoreStreamUrl(url) + bonus
      });
    }
  };

  // Streams directly attached to the active <video> element in the DOM get top priority (+35 bonus)
  for (const s of extraStreams || []) {
    if (typeof s === 'string') addCandidate(s, pageUrl, 35);
    else if (s?.url) addCandidate(s.url, s.referer || pageUrl, 35);
  }

  // Only fall back to tab-wide webRequest streams if extraStreams did not provide an explicit direct stream or if on an iframe player site
  const isFeedPage = /(^|\.)(ya\.ru|yandex\.ru|tiktok\.com|instagram\.com|x\.com|twitter\.com)$/i.test(
    (() => { try { return new URL(pageUrl).hostname; } catch (_) { return ''; } })()
  );
  const now = Date.now();
  const fromWebReq = tabStreams.get(tabId) || [];
  for (let idx = 0; idx < fromWebReq.length; idx++) {
    const item = fromWebReq[idx];
    // On multi-video feed pages (like ya.ru Rhythms or TikTok), deprioritize background tab webRequest streams so the active <video>'s stream wins
    const feedPenalty = isFeedPage && extraStreams && extraStreams.length > 0 ? -40 : 0;
    // Give a recency bonus to newly loaded streams so switching players (e.g. CVH <-> Kodik on AnimeGO) prioritizes the active player
    const ageMs = now - (item.timestamp || 0);
    const recencyBonus = (ageMs < 30000 ? 18 : (ageMs < 120000 ? 8 : 0)) + Math.max(0, 6 - idx);
    addCandidate(item.url, item.referer || pageUrl, feedPenalty + recencyBonus);
  }

  combined.sort((a, b) => b.score - a.score);
  return combined.slice(0, 12);
}

// Run a one-shot Native Host request
function runOneShotNative(payload) {
  return new Promise((resolve) => {
    let port;
    let settled = false;
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
    } catch (err) {
      resolve({ ok: false, error: err.message });
      return;
    }

    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { port.disconnect(); } catch (_) {}
      resolve(result);
    };

    port.onMessage.addListener((msg) => {
      finish(msg);
    });

    port.onDisconnect.addListener(() => {
      const lastErr = chrome.runtime.lastError?.message || 'Could not connect to local helper (run install.bat)';
      finish({ ok: false, error: lastErr });
    });

    port.postMessage(payload);
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender?.tab?.id;
  const senderFrameId = sender?.frameId ?? 0;

  (async () => {
    if (message.type === 'GET_MY_FRAME_ID') {
      sendResponse({ frameId: senderFrameId });
      return;
    }

    if (message.type === 'RELAY_TO_TAB') {
      if (tabId && message.payload) {
        try {
          await chrome.tabs.sendMessage(tabId, {
            ...message.payload,
            senderFrameId
          });
        } catch (_) {}
      }
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'REPORT_FRAME_STREAMS') {
      if (tabId && Array.isArray(message.streams)) {
        for (const sUrl of message.streams) {
          recordStreamForTab(tabId, sUrl, message.frameUrl || '');
        }
      }
      if (tabId && message.frameUrl) {
        recordStreamForTab(tabId, message.frameUrl, message.frameUrl);
      }
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'PING_NATIVE') {
      const res = await runOneShotNative({
        action: 'ping',
        requestId: String(Date.now())
      });
      sendResponse(res);
      return;
    }

    if (message.type === 'GET_FORMATS') {
      const streamCandidates = collectTabStreams(tabId, message.extraStreams, message.url);
      const allUrlsForCookies = [message.url, message.videoSrc, ...streamCandidates.map((c) => c.url)];
      const cookiesTxt = await getCookiesTxtForUrls(allUrlsForCookies);

      const res = await runOneShotNative({
        action: 'get_formats',
        requestId: String(Date.now()),
        url: message.url,
        videoSrc: message.videoSrc || '',
        nativeVideoHeight: message.nativeVideoHeight || 0,
        streamCandidates,
        cookiesTxt,
        userAgent: message.userAgent || ''
      });
      sendResponse(res);
      return;
    }

    if (message.type === 'REVEAL_FILE') {
      if (message.downloadId !== undefined && message.downloadId !== null) {
        chrome.downloads.show(Number(message.downloadId));
      }
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'SEND_FEEDBACK') {
      const res = await runOneShotNative({
        action: 'send_feedback',
        requestId: String(Date.now()),
        url: message.url || '',
        pageHref: message.pageHref || '',
        title: message.title || '',
        mode: message.mode || 'full',
        startTime: message.startTime || '',
        endTime: message.endTime || '',
        quality: message.quality || '',
        tags: Array.isArray(message.tags) ? message.tags : [],
        comment: message.comment || '',
        lastError: message.lastError || ''
      });
      sendResponse(res);
      return;
    }

    if (message.type === 'CANCEL_DOWNLOAD') {
      const existingPort = activePorts.get(tabId);
      if (existingPort) {
        try {
          existingPort.postMessage({ action: 'cancel', requestId: String(Date.now()) });
          setTimeout(() => {
            try { existingPort.disconnect(); } catch (_) {}
            activePorts.delete(tabId);
          }, 300);
        } catch (_) {
          activePorts.delete(tabId);
        }
      }
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'START_DOWNLOAD') {
      if (activePorts.has(tabId)) {
        try { activePorts.get(tabId).disconnect(); } catch (_) {}
        activePorts.delete(tabId);
      }

      const streamCandidates = collectTabStreams(tabId, message.extraStreams, message.url);
      const allUrlsForCookies = [message.url, message.videoSrc, ...streamCandidates.map((c) => c.url)];
      const cookiesTxt = await getCookiesTxtForUrls(allUrlsForCookies);

      let port;
      try {
        port = chrome.runtime.connectNative(HOST_NAME);
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
        return;
      }

      activePorts.set(tabId, port);

      port.onMessage.addListener(async (hostMsg) => {
        if (hostMsg.type === 'ready_for_chrome_download') {
          if (tabId) {
            try {
              await chrome.tabs.sendMessage(
                tabId,
                {
                  type: 'DOWNLOAD_EVENT',
                  event: {
                    type: 'progress',
                    percent: 99,
                    stage: 'Select folder in Chrome save dialog...'
                  }
                }
              );
            } catch (_) {}
          }

          try {
            // Omit `filename` when calling chrome.downloads.download with saveAs: true so Chromium opens the Save As dialog
            // in the user's last selected directory (DownloadPrefs::SaveFilePath) instead of resetting to the default Downloads folder.
            // The filename is provided by the local HTTP server's URL path and Content-Disposition header.
            const downloadId = await chrome.downloads.download({
              url: hostMsg.downloadUrl,
              saveAs: true
            });
            pendingChromeDownloads.set(downloadId, {
              tabId,
              port,
              fileName: hostMsg.fileName
            });
          } catch (err) {
            if (tabId) {
              try {
                await chrome.tabs.sendMessage(
                  tabId,
                  {
                    type: 'DOWNLOAD_EVENT',
                    event: {
                      type: 'error',
                      error: `Chrome save error: ${err.message}`
                    }
                  }
                );
              } catch (_) {}
            }
            try { port.disconnect(); } catch (_) {}
            activePorts.delete(tabId);
          }
          return;
        }

        if (tabId) {
          try {
            await chrome.tabs.sendMessage(
              tabId,
              {
                type: 'DOWNLOAD_EVENT',
                event: hostMsg
              }
            );
          } catch (_) {}
        }

        if (hostMsg.type === 'error' || hostMsg.type === 'cancelled') {
          try { port.disconnect(); } catch (_) {}
          activePorts.delete(tabId);
        }
      });

      port.onDisconnect.addListener(async () => {
        const lastErr = chrome.runtime.lastError?.message;
        if (activePorts.get(tabId) === port) {
          activePorts.delete(tabId);
          if (lastErr && tabId) {
            try {
              await chrome.tabs.sendMessage(
                tabId,
                {
                  type: 'DOWNLOAD_EVENT',
                  event: {
                    type: 'error',
                    error: `Connection to local helper lost (${lastErr}).`
                  }
                }
              );
            } catch (_) {}
          }
        }
      });

      port.postMessage({
        action: 'download',
        requestId: String(Date.now()),
        url: message.url,
        videoSrc: message.videoSrc || '',
        streamCandidates,
        title: message.title,
        mode: message.mode,
        startTime: message.startTime,
        endTime: message.endTime,
        height: message.height,
        audioOnly: message.audioOnly,
        isLive: Boolean(message.isLive),
        preciseCut: message.preciseCut,
        cookiesTxt,
        userAgent: message.userAgent || ''
      });

      sendResponse({ ok: true });
    }
  })();

  return true;
});
