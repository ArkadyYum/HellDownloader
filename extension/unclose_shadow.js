(() => {
  try {
    const origAttachShadow = Element.prototype.attachShadow;
    if (origAttachShadow) {
      Element.prototype.attachShadow = function (init) {
        return origAttachShadow.call(this, { ...init, mode: 'open' });
      };
    }
  } catch (_) {}

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
      let cand = Number(rawH) || 0;
      const w = Number(rawW) || 0;
      if (w > cand && w >= 240) {
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

          if (Array.isArray(levels)) {
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

  // On TikTok, Instagram, Threads, and X/Twitter, extract per-video permalink, direct MP4 stream URLs, and caption from DOM & React Fiber (MAIN world)
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

    const getReactFiber = (el) => {
      let curr = el;
      for (let d = 0; d < 6 && curr; d++) {
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
        if (r.width < 120 || r.height < 120 || r.bottom < -200 || r.top > window.innerHeight + 200) return;

        const host = window.location.hostname.toLowerCase();
        const foundStreams = [];
        let tiktokId = '';
        let authorId = '';
        let shortcode = '';
        let caption = '';

        const addStream = (url) => {
          if (isDirectVideoStream(url) && !foundStreams.includes(url)) {
            foundStreams.push(url);
          }
        };

        // 1. Check <video> currentSrc / src / <source> tags
        if (v.currentSrc) addStream(v.currentSrc);
        if (v.src) addStream(v.src);
        for (const s of v.querySelectorAll('source')) {
          if (s.src) addStream(s.src);
        }

        // 2. Walk up single-video DOM ancestors (check xgwrapper ID and xgplayer instance)
        let anc = v.parentElement;
        for (let d = 0; d < 10 && anc && anc !== document.body; d++) {
          if (anc.id) {
            const m = anc.id.match(/xgwrapper-\d+-(\d{15,22})/);
            if (m && m[1]) tiktokId = m[1];
          }
          const playerInst = anc._player || anc.player || v.player;
          if (playerInst?.config?.url) {
            const cfgUrl = playerInst.config.url;
            if (typeof cfgUrl === 'string') addStream(cfgUrl);
            else if (Array.isArray(cfgUrl)) {
              for (const item of cfgUrl) {
                if (typeof item === 'string') addStream(item);
                else if (item?.src) addStream(item.src);
                else if (item?.url) addStream(item.url);
              }
            }
          }
          anc = anc.parentElement;
        }

        // 3. Walk up React Fiber props ONLY while inside a single-video component (never cross into the parent feed list holding the next/previous videos!)
        let fiber = getReactFiber(v);
        const visited = new WeakSet();
        let nodesChecked = 0;

        const scanObj = (obj, depth) => {
          if (!obj || typeof obj !== 'object' || depth > 4 || nodesChecked > 140) return;
          if (visited.has(obj)) return;
          visited.add(obj);
          nodesChecked++;

          if (Array.isArray(obj)) {
            // Never scan arrays of multiple feed posts/items (which would grab the next video in the feed!)
            if (obj.length > 1 && obj[0] && typeof obj[0] === 'object' && (obj[0].aweme_id || obj[0].awemeId || obj[0].video || obj[0].itemStruct)) {
              return;
            }
            for (let i = 0; i < Math.min(obj.length, 10); i++) {
              const el = obj[i];
              if (typeof el === 'string') addStream(el);
              else if (el && typeof el === 'object') scanObj(el, depth + 1);
            }
            return;
          }

          // If this object belongs to a specific TikTok awemeId and we already know our DOM's tiktokId, ignore mismatched items!
          const objAwemeId = obj.awemeId || obj.aweme_id || obj.itemId || obj.item_id || (typeof obj.id === 'string' && /^7\d{17,19}$/.test(obj.id) ? obj.id : '');
          if (tiktokId && objAwemeId && String(objAwemeId) !== String(tiktokId)) {
            return;
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
          if (!tiktokId && objAwemeId && /^7\d{17,19}$/.test(String(objAwemeId))) {
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

          for (const key of ['playAddr', 'downloadAddr', 'UrlList', 'urlList', 'videoUrl', 'video_url', 'src', 'url', 'video', 'item', 'itemInfo', 'itemStruct', 'media', 'post']) {
            if (key in obj) {
              const val = obj[key];
              if (typeof val === 'string') addStream(val);
              else if (val && typeof val === 'object') scanObj(val, depth + 1);
            }
          }
        };

        for (let step = 0; step < 12 && fiber; step++) {
          // Stop climbing Fiber tree if this Fiber's DOM stateNode wraps more than 1 <video> element!
          if (fiber.stateNode && fiber.stateNode instanceof Element) {
            if ((fiber.stateNode.querySelectorAll?.('video')?.length || 0) > 1) {
              break;
            }
          }
          if (fiber.memoizedProps) scanObj(fiber.memoizedProps, 0);
          if (foundStreams.length > 0 && tiktokId) break;
          fiber = fiber.return;
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

    setInterval(syncAllSocialVideos, 550);
    document.addEventListener('loadedmetadata', syncAllSocialVideos, true);
    document.addEventListener('play', syncAllSocialVideos, true);
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
