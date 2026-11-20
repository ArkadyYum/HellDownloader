(() => {
  // Never run inside Cloudflare Turnstile / CAPTCHA challenge frames;
  // closed Shadow DOMs are inspected safely from the isolated content script via chrome.dom.openOrClosedShadowRoot()
  // without monkey-patching Element.prototype.attachShadow in the MAIN world (which triggers Cloudflare Turnstile bot checks).
  if (
    typeof window !== 'undefined' &&
    (/(^|\.)(challenges\.cloudflare\.com|hcaptcha\.com|recaptcha\.net|google\.com)$/i.test(window.location.hostname) &&
      /\/(cdn-cgi\/challenge-platform|recaptcha)\//i.test(window.location.pathname))
  ) {
    return;
  }

  // On YouTube, bridge available video qualities & metadata from #movie_player (MAIN world) to DOM dataset for instant 0ms detection
  if (typeof window !== 'undefined' && /youtube\.com$/i.test(window.location.hostname)) {
    const LEVEL_TO_HEIGHT = {
      highres: 4320,
      hd2880: 2880,
      hd2160: 2160,
      hd1440: 1440,
      hd1080: 1080,
      hd720: 720,
      large: 480,
      medium: 360,
      small: 240,
      tiny: 144
    };
    const STANDARD_TIERS = [144, 240, 360, 480, 720, 1080, 1440, 2160, 4320];

    const normalizeHeight = (rawH, rawW, qualityLabel) => {
      if (typeof qualityLabel === 'string') {
        const m = qualityLabel.match(/^(\d{3,4})p/i);
        if (m) return Number(m[1]);
      }
      const h = Number(rawH) || 0;
      const w = Number(rawW) || 0;
      // For portrait 9:16 videos (e.g. 1080x1920 Shorts), use the shorter dimension (width = 1080)
      let cand = (w > 0 && h > w) ? w : h;
      if (w > h && w >= 240) {
        const eq = Math.round((w * 9) / 16);
        if (eq > cand) cand = eq;
      }
      for (const t of STANDARD_TIERS) {
        if (Math.abs(cand - t) / t <= 0.08) return t;
      }
      return cand;
    };

    const syncYouTubePlayerMeta = () => {
      try {
        const players = [
          document.getElementById('movie_player'),
          document.getElementById('shorts-player')
        ].filter(Boolean);

        for (const player of players) {
          const resp = typeof player.getPlayerResponse === 'function' ? player.getPlayerResponse() : null;
          const levels = typeof player.getAvailableQualityLevels === 'function' ? player.getAvailableQualityLevels() : [];
          const videoId = resp?.videoDetails?.videoId || '';
          const duration = Number(resp?.videoDetails?.lengthSeconds) || 0;

          const heightsMap = new Map();
          const streamUrls = [];
          const allFormats = [
            ...(resp?.streamingData?.adaptiveFormats || []),
            ...(resp?.streamingData?.formats || [])
          ];

          for (const f of allFormats) {
            if (!f.height && !f.width && !f.qualityLabel) continue;
            if (typeof f.mimeType === 'string' && f.mimeType.startsWith('audio/')) continue;
            const h = normalizeHeight(f.height, f.width, f.qualityLabel);
            if (h < 144) continue;
            const fps = Math.round(Number(f.fps) || 30);
            const prev = heightsMap.get(h);
            if (!prev || fps > prev.fps) {
              heightsMap.set(h, { height: h, fps });
            }
          }

          // Also collect any direct muxed/HLS stream URLs exposed by the active YouTube player
          for (const f of (resp?.streamingData?.formats || [])) {
            if (typeof f?.url === 'string' && /^https?:\/\//i.test(f.url)) {
              streamUrls.push({ height: normalizeHeight(f.height, f.width, f.qualityLabel) || 360, url: f.url });
            }
          }
          if (typeof resp?.streamingData?.hlsManifestUrl === 'string') {
            streamUrls.push({ height: 1080, url: resp.streamingData.hlsManifestUrl });
          }

          if (heightsMap.size === 0 && Array.isArray(levels)) {
            for (const lvl of levels) {
              const h = LEVEL_TO_HEIGHT[lvl];
              if (h && !heightsMap.has(h)) {
                heightsMap.set(h, { height: h, fps: 30 });
              }
            }
          }

          if (heightsMap.size > 0) {
            const qualities = Array.from(heightsMap.values()).sort((a, b) => b.height - a.height);
            player.dataset.vcYtMeta = JSON.stringify({
              videoId,
              duration,
              qualities,
              streamUrls
            });
          }
        }
      } catch (_) {}
    };

    setInterval(syncYouTubePlayerMeta, 600);
    window.addEventListener('yt-navigate-finish', () => setTimeout(syncYouTubePlayerMeta, 150));
    document.addEventListener('loadedmetadata', syncYouTubePlayerMeta, true);
  }

  // On TikTok, Instagram, Threads, and X/Twitter, extract per-video permalink, direct MP4 stream URLs, qualities, and caption from DOM & React Fiber (MAIN world)
  if (
    typeof window !== 'undefined' &&
    /(tiktok\.com|instagram\.com|threads\.net|threads\.com|x\.com|twitter\.com)$/i.test(window.location.hostname)
  ) {
    const isDecoyUrl = (u) => !u || /ttwstatic\.com|tiktok_web_login_static|playback1\.mp4/i.test(u);

    const isDirectVideoStream = (u) => {
      if (typeof u !== 'string' || !/^https?:\/\//i.test(u) || isDecoyUrl(u)) return false;
      if (/\/video\/tos\/|mime_type=video_mp4/i.test(u)) return true;
      if (/\.(mp4|webm)(\?|$)/i.test(u) && !/[?&](bytestart|range)=/i.test(u)) return true;
      return false;
    };

    const TIKTOK_STANDARD_TIERS = [360, 480, 540, 720, 1080, 1440, 2160];
    const snapTikTokTier = (rawDim) => {
      const n = Number(rawDim) || 0;
      if (n <= 0) return 0;
      for (const t of TIKTOK_STANDARD_TIERS) {
        if (Math.abs(n - t) / t <= 0.08) return t;
      }
      return n;
    };

    const parseTikTokBitrateItem = (b) => {
      if (!b || typeof b !== 'object') return null;
      let height = 0;
      const gearStr = String(
        b.GearName || b.gearName || b.definition || b.qualityLabel || b.quality || b.name || b.text || ''
      );
      const gearMatch = gearStr.match(/(2160|1440|1080|720|540|480|360)/);
      if (gearMatch) {
        height = Number(gearMatch[1]);
      } else {
        const qType = Number(b.QualityType ?? b.qualityType ?? -1);
        if (qType === 1 || qType === 2) height = 1080;
        else if (qType === 10 || qType === 14) height = 720;
        else if (qType === 20 || qType === 24 || qType === 25 || qType === 28) height = 540;
      }
      const pa = (b.PlayAddr && typeof b.PlayAddr === 'object' ? b.PlayAddr : null) ||
        (b.playAddr && typeof b.playAddr === 'object' ? b.playAddr : null) || b;
      if (!height) {
        const w = Number(pa.Width || pa.width) || 0;
        const h = Number(pa.Height || pa.height) || 0;
        const shortSide = (w > 0 && h > 0) ? Math.min(w, h) : (w || h);
        height = snapTikTokTier(shortSide);
      }
      if (height < 240) return null;

      let streamUrl = '';
      const urlCandidates = [
        ...(Array.isArray(pa.UrlList) ? pa.UrlList : []),
        ...(Array.isArray(pa.urlList) ? pa.urlList : []),
        ...(Array.isArray(pa.url_list) ? pa.url_list : []),
        ...(Array.isArray(b.UrlList) ? b.UrlList : []),
        ...(Array.isArray(b.urlList) ? b.urlList : []),
        typeof b.playAddr === 'string' ? b.playAddr : '',
        typeof b.url === 'string' ? b.url : '',
        typeof b.src === 'string' ? b.src : ''
      ];
      for (const u of urlCandidates) {
        if (isDirectVideoStream(u)) {
          streamUrl = u;
          break;
        }
      }
      const bitrate = Number(b.Bitrate || b.bitrate) || 0;
      const fps = Math.round(Number(b.FPS || b.fps) || 30);
      return { height, fps, bitrate, streamUrl };
    };

    // Cache of per-item TikTok metadata captured from SSR rehydration state, fetch, or XHR responses
    const tiktokItemsById = new Map();
    let ssrHydrated = false;

    const extractUrlFromAddrObj = (addr) => {
      if (!addr) return '';
      if (typeof addr === 'string') return isDirectVideoStream(addr) ? addr : '';
      if (typeof addr === 'object') {
        const list = addr.UrlList || addr.urlList || addr.url_list || [];
        if (Array.isArray(list)) {
          for (const u of list) {
            if (isDirectVideoStream(u)) return u;
          }
        }
        if (typeof addr.url === 'string' && isDirectVideoStream(addr.url)) return addr.url;
        if (typeof addr.src === 'string' && isDirectVideoStream(addr.src)) return addr.src;
      }
      return '';
    };

    const ingestTikTokDataTree = (rootObj) => {
      if (!rootObj || typeof rootObj !== 'object') return;
      const visited = new WeakSet();
      let count = 0;
      const walk = (obj, depth) => {
        if (!obj || typeof obj !== 'object' || depth > 15 || count > 10000) return;
        if (visited.has(obj)) return;
        visited.add(obj);
        count++;

        if (Array.isArray(obj)) {
          for (let i = 0; i < Math.min(obj.length, 120); i++) {
            walk(obj[i], depth + 1);
          }
          return;
        }

        const itemId = String(obj.id || obj.aweme_id || obj.awemeId || obj.itemId || obj.item_id || '');
        const vidObj = (obj.video && typeof obj.video === 'object') ? obj.video : (Array.isArray(obj.bitrateInfo) ? obj : null);
        if (/^[67]\d{15,21}$/.test(itemId) && vidObj) {
          const existing = tiktokItemsById.get(itemId) || { qualitiesMap: new Map(), streams: [], authorId: '', caption: '' };
          if (obj.author && typeof obj.author === 'object') {
            existing.authorId = obj.author.uniqueId || obj.author.unique_id || existing.authorId;
          } else if (typeof obj.author === 'string' && obj.author) {
            existing.authorId = existing.authorId || obj.author;
          }
          if (typeof obj.desc === 'string' && obj.desc.trim()) {
            existing.caption = obj.desc.trim();
          }
          for (const addrCandidate of [vidObj.playAddr, vidObj.PlayAddr, vidObj.downloadAddr, vidObj.DownloadAddr]) {
            const directU = extractUrlFromAddrObj(addrCandidate);
            if (directU && !existing.streams.includes(directU)) {
              existing.streams.push(directU);
            }
          }
          const bList = vidObj.bitrateInfo || vidObj.bitRateList || vidObj.BitrateInfo || [];
          if (Array.isArray(bList)) {
            for (const b of bList) {
              const parsed = parseTikTokBitrateItem(b);
              if (parsed) {
                const prev = existing.qualitiesMap.get(parsed.height);
                if (!prev || parsed.bitrate > prev.bitrate || (!prev.streamUrl && parsed.streamUrl)) {
                  existing.qualitiesMap.set(parsed.height, parsed);
                }
                if (parsed.streamUrl && !existing.streams.includes(parsed.streamUrl)) {
                  existing.streams.push(parsed.streamUrl);
                }
              }
            }
          }
          const vw = Number(vidObj.width || vidObj.Width) || 0;
          const vh = Number(vidObj.height || vidObj.Height) || 0;
          const vShort = snapTikTokTier((vw > 0 && vh > 0) ? Math.min(vw, vh) : (vw || vh));
          if (vShort >= 240 && !existing.qualitiesMap.has(vShort) && existing.streams.length > 0) {
            existing.qualitiesMap.set(vShort, { height: vShort, fps: 30, bitrate: 1, streamUrl: existing.streams[0] });
          }
          tiktokItemsById.set(itemId, existing);
          return;
        }

        for (const k of Object.keys(obj)) {
          if (k === 'challenges' || k === 'textExtra' || k === 'music' || k === 'stats' || k === 'authorStats' || k === 'stickersOnItem' || k === 'effectStickers') continue;
          const val = obj[k];
          if (val && typeof val === 'object') {
            walk(val, depth + 1);
          }
        }
      };
      try { walk(rootObj, 0); } catch (_) {}
    };

    const hydrateSsrScriptsIfNeeded = () => {
      if (ssrHydrated) return;
      try {
        if (window.__UNIVERSAL_DATA_FOR_REHYDRATION__) {
          ingestTikTokDataTree(window.__UNIVERSAL_DATA_FOR_REHYDRATION__);
          ssrHydrated = true;
        }
        if (window.SIGI_STATE) {
          ingestTikTokDataTree(window.SIGI_STATE);
          ssrHydrated = true;
        }
        const uniScript = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
        if (uniScript?.textContent) {
          ingestTikTokDataTree(JSON.parse(uniScript.textContent));
          ssrHydrated = true;
        }
        const sigiScript = document.getElementById('SIGI_STATE');
        if (sigiScript?.textContent) {
          ingestTikTokDataTree(JSON.parse(sigiScript.textContent));
          ssrHydrated = true;
        }
      } catch (_) {}
    };

    if (/tiktok\.com$/i.test(window.location.hostname)) {
      try {
        if (typeof Response !== 'undefined' && Response.prototype && typeof Response.prototype.json === 'function') {
          const origJson = Response.prototype.json;
          Response.prototype.json = async function (...args) {
            const data = await origJson.apply(this, args);
            try {
              if (data && typeof data === 'object') {
                ingestTikTokDataTree(data);
              }
            } catch (_) {}
            return data;
          };
        }
        const origFetch = window.fetch;
        if (typeof origFetch === 'function') {
          window.fetch = async function (...args) {
            const resp = await origFetch.apply(this, args);
            try {
              const u = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
              if (/\/api\/|item_list|item\/detail|recommend|aweme|post|preload/i.test(u)) {
                resp.clone().json().then((data) => ingestTikTokDataTree(data)).catch(() => {});
              }
            } catch (_) {}
            return resp;
          };
        }
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
          this.__vcUrl = String(url || '');
          return origOpen.call(this, method, url, ...rest);
        };
        XMLHttpRequest.prototype.send = function (...args) {
          this.addEventListener('load', function () {
            try {
              if (/\/api\/|item_list|item\/detail|recommend|aweme|post|preload/i.test(this.__vcUrl || '')) {
                if (this.responseText && this.responseText.startsWith('{')) {
                  ingestTikTokDataTree(JSON.parse(this.responseText));
                }
              }
            } catch (_) {}
          });
          return origSend.apply(this, args);
        };
      } catch (_) {}
    }

    const getReactFiber = (el) => {
      let curr = el;
      for (let d = 0; d < 10 && curr && curr !== document.body; d++) {
        try {
          const keys = Object.keys(curr);
          for (const k of keys) {
            if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) {
              return curr[k];
            }
          }
        } catch (_) {}
        curr = curr.parentElement;
      }
      return null;
    };

    const inspectVideoElement = (v) => {
      try {
        const r = v.getBoundingClientRect();
        if (r.width < 100 || r.height < 65 || r.bottom < -200 || r.top > window.innerHeight + 200) return;

        const host = window.location.hostname.toLowerCase();
        const foundStreams = [];
        const tiktokQualitiesMap = new Map();
        let tiktokId = '';
        let authorId = '';
        let shortcode = '';
        let caption = '';

        const addStream = (url) => {
          if (isDirectVideoStream(url) && !foundStreams.includes(url)) {
            foundStreams.push(url);
          }
        };

        const addTikTokQuality = (parsed) => {
          if (!parsed || !parsed.height) return;
          const prev = tiktokQualitiesMap.get(parsed.height);
          if (!prev || (parsed.bitrate || 0) > (prev.bitrate || 0) || (!prev.streamUrl && parsed.streamUrl)) {
            tiktokQualitiesMap.set(parsed.height, parsed);
          }
          if (parsed.streamUrl) addStream(parsed.streamUrl);
        };

        // 1. Check <video> currentSrc / src / <source> tags (and clear stale dataset if <video> was recycled for a new stream)
        const rawCurrentSrc = v.currentSrc || v.src || '';
        if (v.dataset.vcLastRawSrc && v.dataset.vcLastRawSrc !== rawCurrentSrc) {
          delete v.dataset.vcStreamUrl;
          delete v.dataset.vcExtraStreams;
          delete v.dataset.vcPermalink;
          delete v.dataset.vcTikTokQualities;
          delete v.dataset.vcMetaTitle;
        }
        if (rawCurrentSrc) {
          v.dataset.vcLastRawSrc = rawCurrentSrc;
        }
        if (v.currentSrc) addStream(v.currentSrc);
        if (v.src) addStream(v.src);
        for (const s of v.querySelectorAll('source')) {
          if (s.src) addStream(s.src);
        }

        // 2. Walk up single-video DOM ancestors (check xgwrapper ID, links, and xgplayer instance)
        let anc = v.parentElement;
        let singleVideoRoot = v.parentElement;
        for (let d = 0; d < 15 && anc && anc !== document.body; d++) {
          if (anc.id) {
            const m = anc.id.match(/xgwrapper-\d+-(\d{15,22})/) || anc.id.match(/\b([67]\d{17,19})\b/);
            if (m && m[1]) tiktokId = m[1];
          }
          const playerInst = anc._player || anc.player || v.player || v._player;
          if (playerInst?.config) {
            const cfgUrl = playerInst.config.url;
            if (typeof cfgUrl === 'string') addStream(cfgUrl);
            else if (Array.isArray(cfgUrl)) {
              for (const item of cfgUrl) {
                if (typeof item === 'string') addStream(item);
                else if (item && typeof item === 'object') {
                  if (item.src) addStream(item.src);
                  if (item.url) addStream(item.url);
                  addTikTokQuality(parseTikTokBitrateItem(item));
                }
              }
            }
            const bList = playerInst.config.bitRateList || playerInst.bitRateList || playerInst.config.definition?.list || [];
            if (Array.isArray(bList)) {
              for (const b of bList) addTikTokQuality(parseTikTokBitrateItem(b));
            }
          }
          const vidCount = anc.querySelectorAll?.('video')?.length || 0;
          const articleCount = anc.querySelectorAll?.('article, [data-e2e="recommend-list-item-container"]')?.length || 0;
          if (vidCount <= 1 && articleCount <= 1) {
            singleVideoRoot = anc;
          } else {
            break;
          }
          anc = anc.parentElement;
        }

        // Also check links and author tags inside singleVideoRoot on TikTok
        if (host.includes('tiktok.com') && singleVideoRoot && singleVideoRoot.querySelectorAll) {
          for (const a of singleVideoRoot.querySelectorAll('a[href]')) {
            const href = a.href || '';
            const vm = href.match(/tiktok\.com\/@([^/?#]+)\/(?:video|photo)\/(\d{15,22})/i);
            if (vm) {
              if (!authorId && vm[1]) authorId = vm[1];
              if (!tiktokId && vm[2]) tiktokId = vm[2];
            } else if (!authorId) {
              const um = href.match(/tiktok\.com\/@([A-Za-z0-9_.-]+)(?:[/?#]|$)/i);
              if (um && um[1]) authorId = um[1];
            }
          }
          if (!tiktokId) {
            const urlMatch = window.location.pathname.match(/\/(?:video|photo)\/(\d{15,22})/);
            if (urlMatch && urlMatch[1]) tiktokId = urlMatch[1];
          }
        }

        // 3. Walk up React Fiber props starting from both <video> and singleVideoRoot (e.g. <article>)
        const visited = new WeakSet();
        let nodesChecked = 0;

        const scanObj = (obj, depth) => {
          if (!obj || typeof obj !== 'object' || depth > 7 || nodesChecked > 900) return;
          if (visited.has(obj)) return;
          visited.add(obj);
          nodesChecked++;

          if (Array.isArray(obj)) {
            if (obj.length > 1 && obj[0] && typeof obj[0] === 'object' && (obj[0].aweme_id || obj[0].awemeId || obj[0].video || obj[0].itemStruct || obj[0].id)) {
              if (tiktokId) {
                for (const item of obj) {
                  const id = item?.awemeId || item?.aweme_id || item?.id || item?.itemId;
                  if (id && String(id) === String(tiktokId)) {
                    scanObj(item, depth + 1);
                  }
                }
              }
              return;
            }
            for (let i = 0; i < Math.min(obj.length, 12); i++) {
              const el = obj[i];
              if (typeof el === 'string') addStream(el);
              else if (el && typeof el === 'object') {
                addTikTokQuality(parseTikTokBitrateItem(el));
                scanObj(el, depth + 1);
              }
            }
            return;
          }

          // If this object belongs to a specific TikTok awemeId and we already know our DOM's tiktokId, ignore mismatched items!
          const objAwemeId = obj.awemeId || obj.aweme_id || obj.itemId || obj.item_id || (typeof obj.id === 'string' && /^[67]\d{15,21}$/.test(obj.id) ? obj.id : '');
          if (tiktokId && objAwemeId && String(objAwemeId) !== String(tiktokId)) {
            return;
          }

          // TikTok bitrateInfo / bitRateList multi-quality tiers
          const bInfo = obj.bitrateInfo || obj.bitRateList || obj.BitrateInfo || obj.definitionList || obj.qualityList;
          if (Array.isArray(bInfo)) {
            for (const b of bInfo) {
              addTikTokQuality(parseTikTokBitrateItem(b));
            }
          }

          // Instagram & Threads videoVersions / video_versions
          const vers = obj.videoVersions || obj.video_versions;
          if (Array.isArray(vers)) {
            const sorted = [...vers].sort((a, b) => (Number(b?.height) || 0) - (Number(a?.height) || 0));
            for (const ver of sorted) {
              if (ver?.url) addStream(ver.url);
            }
          }

          // X / Twitter video variants
          if (Array.isArray(obj.variants)) {
            const mp4s = obj.variants
              .filter((x) => x?.url && (!x.content_type || x.content_type.includes('mp4')))
              .sort((a, b) => (Number(b?.bitrate) || 0) - (Number(a?.bitrate) || 0));
            for (const vr of mp4s) {
              addStream(vr.url);
            }
          }

          // TikTok IDs & streams
          if (!tiktokId && objAwemeId && /^[67]\d{15,21}$/.test(String(objAwemeId))) {
            tiktokId = String(objAwemeId);
          }
          if (!authorId && typeof obj.author === 'object' && obj.author) {
            authorId = obj.author.uniqueId || obj.author.unique_id || '';
          }
          if (!caption && typeof obj.desc === 'string' && obj.desc.trim().length > 1) {
            caption = obj.desc.trim();
          }

          // Instagram / Threads shortcode
          const candCode = obj.code || obj.shortcode;
          if (
            !shortcode &&
            typeof candCode === 'string' &&
            /^[A-Za-z0-9_-]{8,15}$/.test(candCode) &&
            (obj.pk || obj.media_type || obj.video_versions || obj.videoVersions || obj.user || obj.owner)
          ) {
            shortcode = candCode;
          }

          for (const key of ['playAddr', 'PlayAddr', 'downloadAddr', 'DownloadAddr', 'bitrateInfo', 'bitRateList', 'BitrateInfo', 'UrlList', 'urlList', 'videoUrl', 'video_url', 'src', 'url', 'video', 'item', 'itemInfo', 'itemStruct', 'media', 'post', 'data']) {
            if (key in obj) {
              const val = obj[key];
              if (typeof val === 'string') addStream(val);
              else if (val && typeof val === 'object') scanObj(val, depth + 1);
            }
          }
        };

        const fiberRoots = [getReactFiber(v), getReactFiber(singleVideoRoot)].filter(Boolean);
        const seenFibers = new WeakSet();
        for (const startFiber of fiberRoots) {
          let fiber = startFiber;
          for (let step = 0; step < 35 && fiber; step++) {
            if (seenFibers.has(fiber)) break;
            seenFibers.add(fiber);
            if (fiber.stateNode && fiber.stateNode instanceof Element) {
              const vLen = fiber.stateNode.querySelectorAll?.('video')?.length || 0;
              if (vLen > 1 && !tiktokId) {
                break;
              }
            }
            if (fiber.memoizedProps) scanObj(fiber.memoizedProps, 0);
            if (foundStreams.length > 0 && tiktokId && authorId && (!host.includes('tiktok.com') || tiktokQualitiesMap.size >= 2)) {
              break;
            }
            fiber = fiber.return;
          }
        }

        // 4. Merge any cached TikTok API / SSR item data for this tiktokId
        if (host.includes('tiktok.com')) {
          hydrateSsrScriptsIfNeeded();
          if (tiktokId && tiktokItemsById.has(tiktokId)) {
            const cachedItem = tiktokItemsById.get(tiktokId);
            if (!authorId && cachedItem.authorId) authorId = cachedItem.authorId;
            if (!caption && cachedItem.caption) caption = cachedItem.caption;
            for (const s of cachedItem.streams) addStream(s);
            for (const q of cachedItem.qualitiesMap.values()) addTikTokQuality(q);
          }

          // Also check DOM quality menu items inside the active player (e.g. 540P, 720P, 1080P)
          if (singleVideoRoot) {
            const nodes = singleVideoRoot.querySelectorAll('div, span, li, p');
            for (const n of nodes) {
              if (n.children.length > 1) continue;
              const txt = (n.textContent || '').trim();
              const m = txt.match(/^(2160|1440|1080|720|540|480|360)\s*p$/i);
              if (m) {
                const h = Number(m[1]);
                if (!tiktokQualitiesMap.has(h)) {
                  tiktokQualitiesMap.set(h, { height: h, fps: 30, bitrate: 0, streamUrl: '' });
                }
              }
            }
          }

          // Ensure the active <video>'s native resolution is included once metadata is loaded
          const vw = Number(v.videoWidth) || 0;
          const vh = Number(v.videoHeight) || 0;
          const nativeShort = snapTikTokTier((vw > 0 && vh > 0) ? Math.min(vw, vh) : (vw || vh));
          if (nativeShort >= 360) {
            if (!tiktokQualitiesMap.has(nativeShort)) {
              tiktokQualitiesMap.set(nativeShort, {
                height: nativeShort,
                fps: 30,
                bitrate: 1,
                streamUrl: foundStreams[0] || ''
              });
            }
            if (nativeShort >= 1080 && tiktokQualitiesMap.size === 1) {
              for (const stdTier of [720, 540]) {
                if (!tiktokQualitiesMap.has(stdTier)) {
                  tiktokQualitiesMap.set(stdTier, { height: stdTier, fps: 30, bitrate: 0, streamUrl: '' });
                }
              }
            } else if (nativeShort >= 720 && tiktokQualitiesMap.size === 1) {
              if (!tiktokQualitiesMap.has(540)) {
                tiktokQualitiesMap.set(540, { height: 540, fps: 30, bitrate: 0, streamUrl: '' });
              }
            }
          }

          if (tiktokQualitiesMap.size > 0) {
            const qList = Array.from(tiktokQualitiesMap.values())
              .sort((a, b) => b.height - a.height)
              .map((q) => ({
                height: q.height,
                fps: q.fps || 30,
                streamUrl: q.streamUrl || foundStreams[0] || '',
                hasExactStream: Boolean(q.streamUrl)
              }));
            v.dataset.vcTikTokQualities = JSON.stringify(qList);
          }
        }

        if (foundStreams.length > 0) {
          v.dataset.vcStreamUrl = foundStreams[0];
          v.dataset.vcExtraStreams = JSON.stringify(foundStreams.slice(0, 6));
        }

        if (host.includes('tiktok.com') && tiktokId) {
          const userPart = authorId ? `@${authorId.replace(/^@/, '')}` : '@_';
          v.dataset.vcPermalink = `https://www.tiktok.com/${userPart}/video/${tiktokId}`;
        } else if (host.includes('instagram.com') && shortcode) {
          v.dataset.vcPermalink = `https://www.instagram.com/reel/${shortcode}/`;
        } else if ((host.includes('threads.net') || host.includes('threads.com')) && shortcode) {
          v.dataset.vcPermalink = `${window.location.origin}/t/${shortcode}`;
        }

        if (caption) {
          v.dataset.vcMetaTitle = caption.slice(0, 140);
        }
      } catch (_) {}
    };

    const syncAllSocialVideos = () => {
      const vids = document.querySelectorAll('video');
      for (const v of vids) {
        inspectVideoElement(v);
      }
    };

    setInterval(syncAllSocialVideos, 250);
    document.addEventListener('loadedmetadata', syncAllSocialVideos, true);
    document.addEventListener('loadeddata', syncAllSocialVideos, true);
    document.addEventListener('play', syncAllSocialVideos, true);
    document.addEventListener('playing', syncAllSocialVideos, true);
  }

  // On Pikabu (pikabu.ru), preserve data-source / data-hls / data-width / data-height on [data-role="player"]
  // both from initial .vue-video-player elements and from mounted Vue 3 __vue_app__._props
  if (typeof window !== 'undefined' && /(^|\.)pikabu\.ru$/i.test(window.location.hostname)) {
    const syncPikabuPlayers = () => {
      try {
        for (const v of document.querySelectorAll('video.vue-video-player[data-source]')) {
          const p = v.parentElement;
          if (p) {
            if (v.dataset.source) p.dataset.vcPkbSource = v.dataset.source;
            if (v.dataset.hls) p.dataset.vcPkbHls = v.dataset.hls;
            if (v.dataset.width) p.dataset.vcPkbWidth = v.dataset.width;
            if (v.dataset.height) p.dataset.vcPkbHeight = v.dataset.height;
          }
        }
        for (const el of document.querySelectorAll('[data-role="player"]')) {
          const props = el.__vue_app__?._props || el.__vue_app__?._container?._vnode?.component?.props;
          if (props && typeof props === 'object') {
            if (props.source && !el.dataset.vcPkbSource) el.dataset.vcPkbSource = String(props.source);
            if (props.hls && !el.dataset.vcPkbHls) el.dataset.vcPkbHls = String(props.hls);
            if (props.width && !el.dataset.vcPkbWidth) el.dataset.vcPkbWidth = String(props.width);
            if (props.height && !el.dataset.vcPkbHeight) el.dataset.vcPkbHeight = String(props.height);
          }
        }
      } catch (_) {}
    };
    setInterval(syncPikabuPlayers, 500);
    document.addEventListener('DOMContentLoaded', syncPikabuPlayers);
    document.addEventListener('play', syncPikabuPlayers, true);
  }
})();
