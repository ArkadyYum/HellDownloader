(() => {
  function isContextValid() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  if (!isContextValid()) return;

  if (window.__vcClipperActiveCheck && window.__vcClipperActiveCheck()) {
    return;
  }
  window.__vcClipperActiveCheck = isContextValid;

  const IS_TOP_WINDOW = (window === window.top);

  // Clean up any leftover DOM nodes from an earlier extension reload
  try {
    document.querySelectorAll('#vc-clipper-panel, #vc-native-markers, #vc-drag-shield').forEach((el) => el.remove());
  } catch (_) {}

  try {
    if (performance && typeof performance.setResourceTimingBufferSize === 'function') {
      performance.setResourceTimingBufferSize(1000);
    }
  } catch (_) {}

  let myFrameId = IS_TOP_WINDOW ? 0 : -1;
  chrome.runtime.sendMessage({ type: 'GET_MY_FRAME_ID' })
    .then((res) => {
      if (typeof res?.frameId === 'number') myFrameId = res.frameId;
    })
    .catch(() => {});

  // Default hotkey: Shift + F8
  let currentHotkey = {
    code: 'F8',
    key: 'F8',
    shiftKey: true,
    ctrlKey: false,
    altKey: false,
    label: 'Shift+F8'
  };

  let isRecordingHotkey = false;
  let suppressContextMenuUntil = 0;
  let hotkeyActiveDown = false;

  (async () => {
    if (!isContextValid()) return;
    try {
      const data = await chrome.storage.local.get('vcHotkeyV2');
      if (data?.vcHotkeyV2?.code) {
        currentHotkey = data.vcHotkeyV2;
        updateHotkeyButtonText();
      }
    } catch (_) {}
  })();

  try {
    chrome.storage.onChanged.addListener((changes) => {
      if (!isContextValid()) return;
      if (changes.vcHotkeyV2?.newValue) {
        currentHotkey = changes.vcHotkeyV2.newValue;
        updateHotkeyButtonText();
      }
    });
  } catch (_) {}

  function relayToTab(payload) {
    if (!isContextValid()) return;
    chrome.runtime.sendMessage({
      type: 'RELAY_TO_TAB',
      payload
    }).catch(() => {});
  }

  let activeVideoFps = 30;

  function formatTime(sec, includeFrames = true) {
    const fps = Math.max(1, Math.round(activeVideoFps || 30));
    const totalFrames = Math.max(0, Math.round((Number(sec) || 0) * fps));
    const frames = totalFrames % fps;
    const totalSecs = Math.floor(totalFrames / fps);
    const hrs = Math.floor(totalSecs / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    const secs = totalSecs % 60;
    const base = hrs > 0
      ? `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
      : `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    return includeFrames ? `${base}:${String(frames).padStart(2, '0')}` : base;
  }

  function parseTimeInput(str) {
    const clean = (str || '').trim().replace(',', '.');
    if (!clean) return null;
    const parts = clean.split(':').map(Number);
    if (parts.some(isNaN)) return null;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 1) return parts[0];
    return null;
  }

  // Parse time edited in the DevilDownload panel inputs (supports MM:SS:FF and HH:MM:SS:FF frame notation)
  function parsePanelTimeInput(str) {
    const clean = (str || '').trim().replace(',', '.');
    if (!clean) return null;
    const fps = Math.max(1, Math.round(activeVideoFps || 30));
    const parts = clean.split(':').map(Number);
    if (parts.some(isNaN)) return null;
    if (parts.length === 4) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2] + (parts[3] / fps);
    }
    if (parts.length === 3) {
      return parts[0] * 60 + parts[1] + (parts[2] / fps);
    }
    if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }
    if (parts.length === 1) {
      return parts[0];
    }
    return null;
  }

  // Deep querySelectorAll that traverses into Shadow DOMs inside a specific root
  function queryAllDeep(selector, root = document) {
    const results = [];
    if (!root) return results;
    try {
      results.push(...root.querySelectorAll(selector));
    } catch (_) {}
    const allEls = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const el of allEls) {
      if (el.shadowRoot) {
        results.push(...queryAllDeep(selector, el.shadowRoot));
      }
    }
    return results;
  }

  function isLikelyAdOrPreviewVideo(v) {
    if (!v) return false;
    if (v.closest?.('a[href]')) return true;
    if (v.closest?.('.ad-showing, .ad-interrupting')) return true;
    if (v.closest?.('#inline-preview-player, ytd-video-preview, ytd-thumbnail-overlay-loading-preview-renderer, ytd-moving-thumbnail-renderer')) return true;
    const src = v.currentSrc || v.src || '';
    if (src && isAdStreamUrl(src)) return true;
    const ident = `${v.className || ''} ${v.id || ''} ${v.parentElement?.className || ''}`.toLowerCase();
    return /\b(ad-|ads-|preroll|midroll|ima-ad|vast|ya-video-ad|preview|thumb)\b/.test(ident);
  }

  // Climb up to the outer player container wrapping <video> and its control bar (supports Shadow DOM & display:contents)
  function getPlayerContainer(videoEl) {
    if (!videoEl) return null;
    const ytHost = videoEl.closest?.('.html5-video-player, #movie_player');
    if (ytHost) return ytHost;

    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl && fsEl !== document.body && fsEl !== document.documentElement) {
      if (fsEl.contains?.(videoEl) || isNodeRelatedToPlayer(videoEl, fsEl, fsEl)) {
        return fsEl;
      }
    }

    const vRect = videoEl.getBoundingClientRect();
    let curr = videoEl;
    let bestPlayerRoot = videoEl;

    for (let depth = 0; depth < 16; depth++) {
      const rootNode = curr.getRootNode ? curr.getRootNode() : null;
      const parent = curr.parentElement || (rootNode && rootNode.host ? rootNode.host : null);
      if (!parent || parent === document.body || parent === document.documentElement) break;

      const pRect = parent.getBoundingClientRect();
      // Skip display:contents or 0-height/0-width layout wrappers without breaking the climb
      if (pRect.width === 0 || pRect.height === 0) {
        curr = parent;
        continue;
      }

      // Never climb into a container that extends more than 52px below the video (post footers/titles/comments below video, e.g. Coub)
      const extendsTooFarBelow = pRect.bottom > vRect.bottom + 52;
      const sameHeightAsVideo =
        !extendsTooFarBelow &&
        pRect.height <= vRect.height * 1.2 + 56 &&
        pRect.height >= vRect.height * 0.75;
      const singleVideoInside = (parent.querySelectorAll?.('video')?.length || 1) <= 1;
      // Never climb into a page layout wrapper that includes the site's navigation sidebar, top header, or chat/aside panel (e.g. TikTok left nav, Twitch right chat)
      const hasSiteNav = hasPageLevelNav(parent, vRect);
      // Only allow climbing into a much wider pillarbox container (e.g. TikTok / OK.ru theater box) if an explicit player control/progress bar inside it actually spans wider than the video!
      let hasWiderControls = false;
      if (pRect.width > vRect.width + 40 && singleVideoInside && !hasSiteNav) {
        const wideCandidates = parent.querySelectorAll?.(
          '[class*="progress" i], [class*="seek" i], [class*="timeline" i], [class*="time_bar" i], [class*="control" i], [data-e2e*="progress" i], [data-e2e*="control" i], [role="slider"]'
        ) || [];
        for (const wc of wideCandidates) {
          const wr = wc.getBoundingClientRect();
          if (wr.width > vRect.width + 30 && wr.width <= pRect.width + 12 && wr.top >= vRect.top) {
            hasWiderControls = true;
            break;
          }
        }
      }
      const isCenteredPillarbox =
        singleVideoInside &&
        !hasSiteNav &&
        hasWiderControls &&
        Math.abs((pRect.left + pRect.right) / 2 - (vRect.left + vRect.right) / 2) <= 35 &&
        pRect.height <= vRect.height + 56;

      if (
        hasSiteNav ||
        !sameHeightAsVideo ||
        pRect.width < vRect.width * 0.75 ||
        (pRect.width > vRect.width + 24 && !isCenteredPillarbox)
      ) {
        break;
      }
      curr = parent;
      bestPlayerRoot = parent;
    }
    return bestPlayerRoot;
  }

  function hasPageLevelNav(container, vRect) {
    if (!container || !container.querySelectorAll) return false;
    const navs = container.querySelectorAll(
      'nav, header, aside, [role="navigation"], [role="complementary"], [data-e2e*="nav-"], [data-a-target*="right-column"], [class*="chat-shell" i]'
    );
    for (const nav of navs) {
      const nr = nav.getBoundingClientRect();
      if (nr.width === 0 || nr.height === 0) continue;
      // An in-player header/sidedock stays inside the video's bounding box; a site header/sidebar/chat extends outside it
      const isInsideVideoBounds =
        nr.top >= vRect.top - 16 &&
        nr.bottom <= vRect.bottom + 52 &&
        nr.left >= vRect.left - 32 &&
        nr.right <= vRect.right + 32;
      if (!isInsideVideoBounds) {
        return true;
      }
    }
    return false;
  }

  // Check if an element belongs to the video player or its ancestor/descendant tree
  function isNodeRelatedToPlayer(node, videoEl, playerRoot) {
    if (!node || !videoEl) return false;
    if (node === videoEl || node === playerRoot) return true;
    if (node.id === 'vc-clipper-panel' || node.id === 'vc-native-markers' || node.id === 'vc-drag-shield') return true;
    if (node.closest?.('#vc-clipper-panel, #vc-native-markers, #vc-drag-shield')) return true;
    if (playerRoot && playerRoot.contains?.(node)) return true;
    if (node.contains?.(videoEl)) return true;
    // Also check across Shadow DOM boundaries
    let curr = node;
    for (let i = 0; i < 10 && curr; i++) {
      if (curr === playerRoot || curr === videoEl) return true;
      const rn = curr.getRootNode ? curr.getRootNode() : null;
      curr = curr.parentElement || (rn && rn.host ? rn.host : null);
    }
    return false;
  }

  // Intersect video bounding rect with overflow-clipping ancestors AND detect opaque page sections covering the bottom of background videos (e.g. ivi.tv)
  function getVisibleVideoRect(videoEl, playerRoot) {
    const raw = videoEl.getBoundingClientRect();
    let left = raw.left;
    let top = raw.top;
    let right = raw.right;
    let bottom = raw.bottom;

    let curr = videoEl.parentElement;
    for (let i = 0; i < 12 && curr && curr !== document.body && curr !== document.documentElement; i++) {
      try {
        const st = window.getComputedStyle(curr);
        if (/(hidden|clip)/.test(`${st.overflow} ${st.overflowX} ${st.overflowY}`)) {
          const cr = curr.getBoundingClientRect();
          if (cr.width > 0 && cr.height > 0) {
            // Only clip horizontally if this ancestor does NOT contain a player timeline bar extending outside `cr` (e.g. Vimeo sets overflow:hidden on .css-mbocqp while .vp-progress spans the full theater bar!)
            let containsWiderTimeline = false;
            if (cr.width < (right - left) - 20) {
              const barEl = curr.querySelector?.('.vp-progress, [class*="progressBar" i], [class*="seekBar" i], [class*="timeline" i], [role="slider"]');
              if (barEl) {
                const br = barEl.getBoundingClientRect();
                if (br.width > cr.width + 20 || br.left < cr.left - 12 || br.right > cr.right + 12) {
                  containsWiderTimeline = true;
                }
              }
            }
            if (!containsWiderTimeline) {
              left = Math.max(left, cr.left);
              right = Math.min(right, cr.right);
            }
            top = Math.max(top, cr.top);
            bottom = Math.min(bottom, cr.bottom);
          }
        }
      } catch (_) {}
      const rootNode = curr.getRootNode ? curr.getRootNode() : null;
      curr = curr.parentElement || (rootNode && rootNode.host ? rootNode.host : null);
    }

    // Visual occlusion check: if a page block (like "Сезоны" on ivi.tv) overlaps the bottom portion of a hero <video>
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (!fsEl && bottom - top > 180 && right - left > 200) {
      const testX = Math.max(10, Math.min(window.innerWidth - 10, Math.round(left + (right - left) * 0.35)));
      let occludedBottom = bottom;

      for (let testY = Math.min(window.innerHeight - 5, Math.round(bottom - 10)); testY > top + 120; testY -= 20) {
        let hitList = [];
        try {
          hitList = document.elementsFromPoint(testX, testY) || [];
        } catch (_) {
          break;
        }
        let blockedByPageSection = false;
        for (const hitEl of hitList) {
          if (isNodeRelatedToPlayer(hitEl, videoEl, playerRoot)) {
            // Reached the video or player control layer first -> not occluded at this Y!
            break;
          }
          const st = window.getComputedStyle(hitEl);
          if (st.pointerEvents === 'none' || st.visibility === 'hidden' || Number(st.opacity) < 0.15) continue;
          const bg = st.backgroundColor || '';
          let hasOpaqueBg = false;
          if (bg && bg !== 'transparent') {
            const rgbaMatch = bg.match(/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([0-9.]+)\s*\)/i);
            if (rgbaMatch) {
              hasOpaqueBg = parseFloat(rgbaMatch[1]) >= 0.85;
            } else if (/^rgb\(/i.test(bg)) {
              hasOpaqueBg = true;
            }
          }
          const hr = hitEl.getBoundingClientRect();
          // If an unrelated wide page container with background or content sits in front of the video's bottom
          if (hasOpaqueBg && hr.width > (right - left) * 0.6 && hr.top > top + 80) {
            blockedByPageSection = true;
            occludedBottom = Math.min(occludedBottom, hr.top);
            break;
          }
        }
        if (!blockedByPageSection) {
          break;
        }
        occludedBottom = Math.min(occludedBottom, testY);
      }

      if (occludedBottom < bottom && occludedBottom > top + 120) {
        bottom = occludedBottom;
      }
    }

    return {
      left,
      top,
      right,
      bottom,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top)
    };
  }

  let cachedLocalVideo = null;
  let cachedLocalVideoAt = 0;

  function findLocalVideo() {
    const now = Date.now();
    if (cachedLocalVideo && cachedLocalVideo.isConnected && now - cachedLocalVideoAt < 650) {
      const r = cachedLocalVideo.getBoundingClientRect();
      if (r.width >= 200 && r.height >= 120 && r.bottom >= 40 && r.top <= window.innerHeight - 40) {
        return cachedLocalVideo;
      }
    }

    const videos = queryAllDeep('video');
    let best = null;
    let bestScore = 0;
    const vpCenterX = window.innerWidth / 2;
    const vpCenterY = window.innerHeight / 2;

    for (const v of videos) {
      if (v.closest?.('a[href]')) continue;
      // Never skip a <video> just because a parent has aria-hidden="true" if the video itself is visible in the viewport (e.g. Vimeo sets aria-hidden="true" on .vp-video-wrapper)
      const ariaHiddenAnc = v.closest?.('[aria-hidden="true"]');
      if (ariaHiddenAnc && (ariaHiddenAnc.getBoundingClientRect().width < 200 || ariaHiddenAnc.getBoundingClientRect().height < 120)) continue;

      const style = window.getComputedStyle(v);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;

      const pRoot = getPlayerContainer(v);
      const rect = getVisibleVideoRect(v, pRoot);
      if (rect.bottom < 40 || rect.top > window.innerHeight - 40 || rect.right < 40 || rect.left > window.innerWidth - 40) continue;
      if (rect.width < 200 || rect.height < 120) continue;

      let score = rect.width * rect.height;
      const isAd = isLikelyAdOrPreviewVideo(v);
      if (isAd) {
        score *= 0.05;
      } else {
        score *= 2.5;
      }
      if (Number.isFinite(v.duration) && v.duration > 120) score *= 1.5;

      // Strongly prefer the <video> that is currently playing or unmuted (essential on multi-video feeds like TikTok & Yandex Rhythms)
      if (!v.paused && !v.ended) score *= 3.0;
      if (!v.muted && v.volume > 0) score *= 1.8;

      // Check if this video (or its modal dialog) is visually on top at its center point (not behind a modal backdrop!)
      const cx = Math.max(10, Math.min(window.innerWidth - 10, Math.round(rect.left + rect.width / 2)));
      const cy = Math.max(10, Math.min(window.innerHeight - 10, Math.round(rect.top + rect.height / 2)));
      try {
        const hitList = document.elementsFromPoint(cx, cy) || [];
        let isTopVisible = false;
        for (const hitEl of hitList) {
          if (hitEl.id === 'vc-clipper-panel' || hitEl.id === 'vc-native-markers' || hitEl.id === 'vc-drag-shield') continue;
          if (hitEl.closest?.('#vc-clipper-panel, #vc-native-markers, #vc-drag-shield')) continue;
          if (isNodeRelatedToPlayer(hitEl, v, pRoot)) {
            isTopVisible = true;
            break;
          }
          const st = window.getComputedStyle(hitEl);
          if (st.pointerEvents === 'none' || st.visibility === 'hidden' || Number(st.opacity) < 0.2) continue;
          const bg = st.backgroundColor || '';
          const rgbaMatch = bg.match(/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([0-9.]+)\s*\)/i);
          if ((rgbaMatch && parseFloat(rgbaMatch[1]) >= 0.5) || /^rgb\(/i.test(bg)) {
            // Covered by an opaque modal / overlay backdrop!
            break;
          }
        }
        if (isTopVisible) {
          score *= 4.0;
        } else {
          score *= 0.15;
        }
      } catch (_) {}

      // Slight bonus for videos closer to the center of the viewport
      const distFromCenter = Math.hypot(cx - vpCenterX, cy - vpCenterY);
      score *= Math.max(0.6, 1.3 - distFromCenter / Math.max(800, window.innerWidth));

      if (score > bestScore) {
        best = v;
        bestScore = score;
      }
    }
    cachedLocalVideo = best;
    cachedLocalVideoAt = now;
    return best;
  }

  function isAdStreamUrl(urlStr) {
    if (!urlStr) return true;
    return /(ttwstatic\.com|tiktok_web_login_static|playback1\.mp4|mradx\.net|target\.my\.com|ads\.vk\.com|googlesyndication\.com|doubleclick\.net|an\.yandex\.ru|yandexadexchange|serving-sys\.|eyeblaster\.|flashtalking\.|adriver\.ru|adfox\.ru|betweendigital\.|buzzoola\.|videonow\.ru|pladform\.ru|2mdn\.net)/i.test(urlStr);
  }

  function getDirectVideoSrc(videoEl) {
    const v = videoEl || findLocalVideo();
    if (!v) return '';
    if (v.dataset?.vcStreamUrl && /^https?:\/\//i.test(v.dataset.vcStreamUrl) && !isAdStreamUrl(v.dataset.vcStreamUrl)) {
      return v.dataset.vcStreamUrl;
    }
    const src = v.currentSrc || v.src || '';
    if (/^https?:\/\//i.test(src) && !isAdStreamUrl(src)) return src;
    const sourceEl = v.querySelector('source[src^="http"]');
    if (sourceEl?.src && !isAdStreamUrl(sourceEl.src)) return sourceEl.src;
    return '';
  }

  function isDirectSingleFileVideoUrl(urlStr) {
    if (!urlStr || !/^https?:\/\//i.test(urlStr)) return false;
    const lower = urlStr.toLowerCase();
    if (isAdStreamUrl(lower)) return false;
    // Archive.org /details/ pages have multiple derivatives (.mp4 480p and .mkv 1080p), so always let yt-dlp list all formats
    if (lower.includes('archive.org/')) return false;
    if (lower.includes(':hls:') || lower.includes('.m3u8') || lower.includes('.mpd')) return false;
    if (lower.includes('googlevideo.com/videoplayback')) return false;
    if (/[?&](bytestart|range)=/i.test(lower)) return false;
    if (lower.includes('/video/tos/') || lower.includes('mime_type=video_mp4')) return true;
    return /\.(mp4|webm|mov|mkv)(\?|$)/i.test(lower);
  }

  function normalizePerfStreamUrl(u) {
    if (!u || !/^https?:\/\//i.test(u)) return '';
    if (/\.mp4:hls:seg-/i.test(u)) {
      return u.replace(/:hls:seg-[^?]+/i, ':hls:manifest.m3u8');
    }
    if ((u.includes('cdninstagram.com') || u.includes('fbcdn.net')) && /[?&]bytestart=/i.test(u)) {
      return u.replace(/([?&])bytestart=\d+(&byteend=\d+)?/gi, '$1').replace(/[?&]+$/, '');
    }
    return u;
  }

  function getPerformanceStreams() {
    const scored = [];
    const seen = new Set();
    try {
      const entries = performance.getEntriesByType('resource') || [];
      for (let i = entries.length - 1; i >= 0; i--) {
        const rawUrl = entries[i].name || '';
        const u = normalizePerfStreamUrl(rawUrl);
        if (!u || seen.has(u)) continue;
        const lower = u.toLowerCase();
        if (isAdStreamUrl(lower)) continue;
        if (/\.(ts|m4s|aac|vtt|srt|jpg|jpeg|png|gif|webp|svg|js|css|woff2?)(\?|$)/i.test(lower)) continue;
        if (/\/(init|seg|segment|chunk|frag|part)[-_][^/]*\.(mp4|webm|m4s)(\?|$)/i.test(lower)) continue;
        if (lower.includes('googlevideo.com/videoplayback') && lower.includes('range=')) continue;
        if (lower.includes('json_preview=1') || lower.includes('vh-canvas-converted')) continue;

        if (
          /(\.m3u8|\.mpd|\.mp4|\.webm)(\?|$|:)/i.test(lower) ||
          lower.includes('manifest.m3u8') ||
          lower.includes('master.m3u8') ||
          lower.includes('manifest.mpd') ||
          (lower.includes('okcdn.ru/') && /[?&]ct=(6|8)\b/i.test(lower) && !lower.includes('bytes=')) ||
          lower.includes('/video/tos/') ||
          lower.includes('mime_type=video_mp4')
        ) {
          if (/\/(audio[-_][^/]*\.m3u8|playlist_a\.m3u8)(\?|$)/i.test(lower)) continue;
          if (/[?&]st=audio\b/i.test(lower)) continue;
          seen.add(u);
          let priority = 50;
          if (lower.includes(':hls:manifest.m3u8') || lower.includes('master.m3u8') || lower.includes('.mpd') || (lower.includes('okcdn.ru/') && /[?&]ct=(6|8)\b/i.test(lower))) priority = 100;
          else if (/\/playlists\/media\/video[-_]/i.test(lower)) priority = 30;
          else if (lower.includes('.m3u8')) priority = 90;
          else if (lower.includes('/video/tos/') || lower.includes('mime_type=video_mp4')) priority = 85;
          scored.push({ u, priority });
        }
      }
    } catch (_) {}
    scored.sort((a, b) => b.priority - a.priority);
    return scored.slice(0, 10).map((item) => item.u);
  }

  function detectFallbackDurationFromDOM(videoEl) {
    if (videoEl && Number.isFinite(videoEl.duration) && videoEl.duration > 0) {
      return videoEl.duration;
    }
    const pRoot = videoEl ? getPlayerContainer(videoEl) : document;
    const slashPattern = /\b(\d{1,2}:\d{2}(?::\d{2})?)\s*\/\s*(\d{1,2}:\d{2}(?::\d{2})?)\b/;
    const candidates = queryAllDeep('span, div, time', pRoot || document);
    let maxFoundTime = 0;

    for (const el of candidates) {
      if (el.children && el.children.length > 3) continue;
      const txt = (el.textContent || '').trim();
      if (!txt || txt.length > 40) continue;

      const m = txt.match(slashPattern);
      if (m && m[2]) {
        const parsed = parseTimeInput(m[2]);
        if (parsed && parsed > maxFoundTime) maxFoundTime = parsed;
      }

      if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(txt)) {
        const r = el.getBoundingClientRect();
        if (r.width > 10 && r.top > window.innerHeight * 0.3) {
          const val = parseTimeInput(txt);
          if (val && val > maxFoundTime) maxFoundTime = val;
        }
      }
    }

    if (maxFoundTime > 0) return maxFoundTime;

    const bodyTxt = document.body?.innerText || '';
    const durMatch = bodyTxt.match(/Длит(?:ельность)?:\s*(\d{1,2}:\d{2}(?::\d{2})?)/i);
    if (durMatch && durMatch[1]) {
      const parsed = parseTimeInput(durMatch[1]);
      if (parsed && parsed > 1) return parsed;
    }
    return 0;
  }

  // Compute the outer player bounding box (combines visible vertical bounds from vRect with full horizontal width of playerRoot for Theater Mode / pillarboxed videos)
  function getOuterPlayerRect(videoEl, playerRoot, vRect) {
    if (!playerRoot || playerRoot === videoEl) return vRect;
    const pr = playerRoot.getBoundingClientRect();
    if (pr.width < vRect.width * 0.9 || pr.height < vRect.height * 0.75) return vRect;
    const left = Math.max(0, Math.min(vRect.left, pr.left));
    const right = Math.min(window.innerWidth, Math.max(vRect.right, pr.right));
    const top = Math.max(0, Math.min(vRect.top, pr.top));
      // Preserve vRect.bottom if getVisibleVideoRect clipped an occluded background video (like ivi.tv), otherwise allow at most 48px for player controls directly below video
    const wasOccluded = vRect.bottom < videoEl.getBoundingClientRect().bottom - 15;
    const bottom = wasOccluded ? vRect.bottom : Math.min(window.innerHeight, Math.max(vRect.bottom, Math.min(pr.bottom, vRect.bottom + 48)));
    return {
      left,
      top,
      right,
      bottom,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top)
    };
  }

  // Climb from an inner buffered/played fill bar or chapter segment up to the full-width static timeline track container inside playerRoot
  function climbToOuterTimelineTrack(el, pRect, playerRoot) {
    let curr = el;
    for (let depth = 0; depth < 5; depth++) {
      if (curr === playerRoot) break;
      const parent = curr.parentElement;
      if (!parent || parent === document.body || parent === playerRoot) break;
      const pr = parent.getBoundingClientRect();
      const cr = curr.getBoundingClientRect();

      if (parent.querySelector?.('video')) break;
      // Stop before climbing into the main bottom button bar row (which contains multiple buttons/SVGs, Flowplayer/Kodik controls, or timers)
      if ((parent.querySelectorAll?.('button')?.length || 0) >= 2) break;
      if ((parent.querySelectorAll?.('svg')?.length || 0) >= 3) break;
      if (parent.querySelector?.('.fp-play, .fp-volume, .fp-volumebtn, .fp-fullscreen, .fp-elapsed, .fp-duration')) break;

      const currIdent = `${curr.className || ''} ${curr.id || ''} ${curr.getAttribute?.('data-testid') || ''}`.toLowerCase();
      const parentIdent = `${parent.className || ''} ${parent.id || ''} ${parent.getAttribute?.('data-testid') || ''}`.toLowerCase();

      // Never climb out of an explicit timeline track into a generic controls bar (e.g. .fp-timeline -> .fp-controls on Kodik)
      if (
        cr.width >= 80 &&
        /(timeline|progress.?bar|seek.?bar|time.?bar|vjs-progress|plyr__progress)/.test(currIdent) &&
        !/(timeline|progress|seek|time.?bar)/.test(parentIdent)
      ) {
        break;
      }
      if (
        /\b(fp-controls|fp-ui|controls|control-bar|control_bar|toolbar|bottom-bar|panel|header)\b/.test(parentIdent) &&
        !/(timeline|progress|seek|time.?bar)/.test(parentIdent)
      ) {
        break;
      }

      const pText = (parent.textContent || '').trim();
      if (/\d{1,2}:\d{2}(?::\d{2})?\s*\/\s*\d{1,2}:\d{2}/.test(pText)) break;
      if ((pText.match(/\b\d{1,2}:\d{2}\b/g) || []).length >= 2) break;

      // Only climb if parent is actually wider than curr (e.g. climbing from partial progress fill or chapter segment to full track)
      // Do NOT climb if width is identical and parent only adds vertical padding
      if (
        pr.height >= 1 &&
        pr.height <= 36 &&
        Math.abs((pr.top + pr.height / 2) - (cr.top + cr.height / 2)) <= 14 &&
        pr.width > cr.width + 4 &&
        pr.left >= pRect.left - 12 &&
        pr.right <= pRect.right + 12 &&
        pr.bottom <= pRect.bottom + 12
      ) {
        curr = parent;
      } else {
        break;
      }
    }
    return curr;
  }

  function isValidFullTimelineRect(r, pRect) {
    // Allow timeline bars down to 25% of player width (e.g. Alloha & Kodik where right-side controls take up to 58% of the bar)
    if (!r || r.width < Math.max(120, pRect.width * 0.25) || r.width > pRect.width + 12) return false;
    if (r.height < 1 || r.height > 36) return false;
    // Timeline must start on the left side of the player (after at most Play button + timer), which also excludes right-side volume bars and middle chapter-title spacers
    const maxLeftOffset = Math.min(165, pRect.width * 0.28);
    if (r.left < pRect.left - 12 || r.left > pRect.left + maxLeftOffset) return false;
    const maxRightOffset = pRect.width * 0.68;
    if (r.right > pRect.right + 12 || r.right < pRect.right - maxRightOffset) return false;
    // Allow up to 155px (or 24% of player height) from bottom of player (e.g. Rutube embed on Yandex Video has timeline at 106px above bottom)
    const maxBottomDist = Math.max(155, pRect.height * 0.24);
    if (r.top < pRect.bottom - maxBottomDist || r.bottom > pRect.bottom + 8) return false;
    return true;
  }

  let cachedTimelineEl = null;
  let cachedTimelineVideo = null;
  let cachedTimelineAt = 0;

  function findLocalTimelineRect(videoEl) {
    if (!videoEl) return null;
    const playerRoot = getPlayerContainer(videoEl);
    const vRect = getVisibleVideoRect(videoEl, playerRoot);
    if (vRect.width < 200 || vRect.height < 120) return null;
    const pRect = getOuterPlayerRect(videoEl, playerRoot, vRect);

    const now = Date.now();
    if (
      cachedTimelineEl &&
      cachedTimelineVideo === videoEl &&
      cachedTimelineEl.isConnected &&
      now - cachedTimelineAt < 850
    ) {
      const cr = cachedTimelineEl.getBoundingClientRect();
      if (isValidFullTimelineRect(cr, pRect)) {
        return { rect: cr, vRect, pRect, isExact: true, isExplicit: Boolean(cachedTimelineEl.dataset?.vcExplicit) };
      }
    }

    // 1. YouTube Watch player progress bar
    const ytPlayer = videoEl.closest('.html5-video-player, #movie_player');
    if (ytPlayer) {
      const ytBar = ytPlayer.querySelector('.ytp-progress-bar');
      if (ytBar) {
        const r = ytBar.getBoundingClientRect();
        const st = window.getComputedStyle(ytBar);
        if (r.width > 80 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0) {
          ytBar.dataset.vcExplicit = '1';
          cachedTimelineEl = ytBar;
          cachedTimelineVideo = videoEl;
          cachedTimelineAt = now;
          return { rect: r, vRect, pRect, isExact: true, isExplicit: true };
        }
      }
    }

    // 2. YouTube Shorts progress bar
    const shortsHost = videoEl.closest('ytd-reel-video-renderer, #shorts-player');
    if (shortsHost) {
      return {
        rect: {
          left: vRect.left + 8,
          width: Math.max(80, vRect.width - 16),
          top: vRect.bottom - 12,
          height: 8
        },
        vRect,
        pRect,
        isExact: true,
        isExplicit: true
      };
    }

    // 3. Search inside playerRoot (or its nearest single-video wrapper up to 4 levels if controls are sibling to playerRoot, e.g. Vimeo) for explicit & geometric timeline tracks
    if (playerRoot) {
      let searchRoot = playerRoot;
      let cand = playerRoot.parentElement;
      for (let step = 0; step < 4 && cand && cand !== document.body && cand !== document.documentElement; step++) {
        const cr = cand.getBoundingClientRect();
        if (
          (cand.querySelectorAll?.('video')?.length || 0) <= 1 &&
          !hasPageLevelNav(cand, vRect) &&
          cr.height <= vRect.height + 64
        ) {
          searchRoot = cand;
          cand = cand.parentElement;
        } else {
          break;
        }
      }

      const explicitSelectors = [
        '.qsv-seekbar__qsv-progressBar',
        '.fp-timeline',
        '.xgplayer-progress',
        '.vp-progress',
        '[class*="ProgressBar_module_progressBar"]',
        '[class*="DivSeekBarContainer"]',
        '[class*="SeekBar"]',
        '[class*="ProgressBar"]',
        '[data-e2e*="video-progress"]',
        '[data-e2e*="progress"]',
        '.vkvp_time_bar',
        '.videoplayer_timeline',
        '.videoplayer_timeline_wrap',
        '[data-testid="video_player_timeline"]',
        '.vjs-progress-control',
        '.plyr__progress',
        '.jw-slider-time .jw-rail',
        '.rmp-time-total',
        '[role="slider"]',
        'input[type="range"]'
      ];
      let bestExplicitRect = null;
      let bestExplicitEl = null;
      let bestExplicitPenalty = 999;
      for (const sel of explicitSelectors) {
        const list = queryAllDeep(sel, searchRoot);
        for (const rawEl of list) {
          const rawRect = rawEl.getBoundingClientRect();
          // Only climb if rawEl is a narrow thumb knob (< 40px); otherwise rawEl is already the explicit timeline track
          const outerEl = rawRect.width < 40 ? climbToOuterTimelineTrack(rawEl, pRect, searchRoot) : rawEl;
          if ((outerEl.querySelectorAll?.('button')?.length || 0) >= 2) continue;
          if ((outerEl.querySelectorAll?.('svg')?.length || 0) >= 3) continue;
          if (outerEl.querySelector?.('.fp-play, .fp-volume, .fp-elapsed, .fp-duration')) continue;
          const r = outerEl.getBoundingClientRect();
          // Allow explicit timeline bars whose center Y is within [pRect.bottom - 155 .. pRect.bottom + 8] and starting within 260px of pRect.left
          const isValidExplicit =
            r &&
            r.width >= Math.max(120, pRect.width * 0.25) &&
            r.width <= Math.max(pRect.width, vRect.width) + 24 &&
            r.height >= 1 &&
            r.height <= 36 &&
            r.left >= Math.min(pRect.left, vRect.left) - 12 &&
            r.left <= Math.max(pRect.left, vRect.left) + Math.min(260, Math.max(pRect.width, vRect.width) * 0.28) &&
            r.top >= pRect.bottom - Math.max(155, pRect.height * 0.24) &&
            r.bottom <= pRect.bottom + 12;

          if (isValidExplicit) {
            // Prefer the tighter inner track (height <= 14px) over padded outer hit-containers (height > 20px) when widths are within 30px
            const heightPenalty = r.height > 16 ? 1 : 0;
            if (
              !bestExplicitRect ||
              r.width > bestExplicitRect.width + 30 ||
              (Math.abs(r.width - bestExplicitRect.width) <= 30 && heightPenalty < bestExplicitPenalty)
            ) {
              bestExplicitRect = r;
              bestExplicitEl = outerEl;
              bestExplicitPenalty = heightPenalty;
            }
          }
        }
      }
      if (bestExplicitRect && bestExplicitEl) {
        bestExplicitEl.dataset.vcExplicit = '1';
        cachedTimelineEl = bestExplicitEl;
        cachedTimelineVideo = videoEl;
        cachedTimelineAt = now;
        return { rect: bestExplicitRect, vRect, pRect, isExact: true, isExplicit: true };
      }

      // 4. Universal Geometric Detector scoped inside searchRoot
      const allElements = queryAllDeep('div, span, progress, input[type="range"]', searchRoot);
      let bestRect = null;
      let bestEl = null;
      let bestScore = -1;

      for (const rawEl of allElements) {
        if (rawEl.id === 'vc-native-markers' || rawEl.closest?.('#vc-clipper-panel')) continue;
        const el = climbToOuterTimelineTrack(rawEl, pRect, searchRoot);
        const r = el.getBoundingClientRect();

        if (!isValidFullTimelineRect(r, pRect)) continue;
        if (el.querySelector?.('video')) continue;
        if ((el.querySelectorAll?.('button')?.length || 0) >= 2) continue;
        if ((el.querySelectorAll?.('svg')?.length || 0) >= 3) continue;
        const rawText = (el.textContent || '').trim();
        // Exclude bottom control row containing "00:00 / 10:00" slash timer
        if (/\d{1,2}:\d{2}(?::\d{2})?\s*\/\s*\d{1,2}:\d{2}/.test(rawText)) continue;
        // Exclude middle chapter-title buttons/spacers in the bottom control bar (narrower than 85% of player width with text words)
        if (r.width < pRect.width * 0.85 && /[а-яёa-z]{4,}/i.test(rawText)) continue;

        let score = 0;
        const ident = `${el.className || ''} ${el.id || ''} ${el.getAttribute?.('aria-label') || ''} ${el.getAttribute?.('role') || ''}`.toLowerCase();
        const parentIdent = `${el.parentElement?.className || ''} ${el.parentElement?.id || ''}`.toLowerCase();
        if (/progress|timeline|time.?bar|seek|scrub|slider|rail|track|line|range/.test(ident)) {
          score += 65;
        } else if (/progress|timeline|time.?bar|seek|scrub|slider|rail|track/.test(parentIdent)) {
          score += 35;
        }

        // Universal structural check: a track element that contains inner horizontal fill/buffer/thumb or chapter segment children
        if (el.children && el.children.length >= 1 && el.children.length <= 120) {
          let hasInnerBarChild = false;
          for (const ch of el.children) {
            const cr = ch.getBoundingClientRect();
            if (
              cr.height >= 1 &&
              cr.height <= r.height + 8 &&
              cr.top >= r.top - 6 &&
              cr.bottom <= r.bottom + 6 &&
              cr.left >= r.left - 4 &&
              cr.width <= r.width + 4 &&
              cr.width >= 4
            ) {
              hasInnerBarChild = true;
              break;
            }
          }
          if (hasInnerBarChild) score += 30;
        }

        // Strongly prefer full-width timeline bars starting near the left edge of the player
        if (r.left - pRect.left <= 48 && r.width >= pRect.width * 0.85) {
          score += 45;
        }

        const style = window.getComputedStyle(el);
        if (style.cursor === 'pointer') score += 20;
        if (r.height >= 3 && r.height <= 16) score += 20;
        score += (r.width / pRect.width) * 40;

        if (score > bestScore) {
          bestScore = score;
          bestRect = r;
          bestEl = el;
        }
      }

      if (bestRect && bestScore >= 40) {
        cachedTimelineEl = bestEl;
        cachedTimelineVideo = videoEl;
        cachedTimelineAt = now;
        return { rect: bestRect, vRect, pRect, isExact: true };
      }
    }

    // 5. Static fallback right along the visible bottom edge of the video player
    return {
      rect: {
        left: pRect.left + 14,
        width: Math.max(80, pRect.width - 28),
        top: pRect.bottom - 18,
        height: 8
      },
      vRect,
      pRect,
      isExact: false
    };
  }

  function getActiveOverlayRoot() {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl && fsEl.tagName !== 'IFRAME' && fsEl.tagName !== 'VIDEO') {
      return fsEl;
    }
    return document.body;
  }

  // Stop clicks/mousedowns and input keystrokes on our UI from bubbling to the webpage
  // Never block mouseup/pointerup on markersEl so the video player never gets stuck in timeline-scrubbing mode!
  function shieldElementEventsFromPage(el) {
    if (!el || el.dataset.vcShielded) return;
    el.dataset.vcShielded = '1';
    const isMarkers = el.id === 'vc-native-markers';
    const evList = isMarkers
      ? ['mousedown', 'pointerdown', 'click', 'dblclick', 'contextmenu']
      : ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'click', 'dblclick', 'contextmenu'];
    for (const evType of evList) {
      el.addEventListener(evType, (e) => {
        e.stopPropagation();
      }, false);
    }
    for (const keyEv of ['keydown', 'keyup', 'keypress']) {
      el.addEventListener(keyEv, (e) => {
        const tag = e.target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') {
          e.stopPropagation();
        }
      }, false);
    }
  }

  // ==========================================================================
  // UI & CONTROLLER STATE
  // ==========================================================================
  let panelEl = null;
  let markersEl = null;
  let dragShieldEl = null;
  let isOpen = false;
  let remoteOpen = false;
  let activeIframeId = null;
  let activeVideo = null;
  const remoteFramesMap = new Map();
  let remoteIframeState = null;
  let lastVideoKey = '';
  let lastAutoFormatsKey = '';
  let isFetchingFormats = false;
  const formatsCache = new Map();
  const chaptersCache = new Map();
  let userManuallyAdjustedSliders = false;
  let draggingSlider = null;
  let lastInternalSeekAt = 0;

  let mode = 'full'; // 'full' | 'fragment'
  let startTime = 0;
  let endTime = 30;
  let videoDuration = 100;
  let isDurationLocked = false;
  let lockedDuration = 30;
  let selectedQuality = { height: 1080, audioOnly: false, container: 'mp4', label: '1080p (Full HD)' };
  let preciseCut = true;
  let isDownloading = false;
  let isPreviewingLoop = false;
  let lastDownloadId = null;
  let lastDownloadError = '';
  const DONATE_URL = 'https://www.donationalerts.com/r/yumarkady';

  function setStartAndEndFromStart(targetStart, minGap = 0.3) {
    if (isDurationLocked) {
      const dur = Math.max(0.1, Math.min(videoDuration, lockedDuration || (endTime - startTime) || 1));
      lockedDuration = dur;
      startTime = Math.max(0, Math.min(Math.max(0, videoDuration - dur), targetStart));
      endTime = Math.min(videoDuration, startTime + dur);
    } else {
      startTime = Math.max(0, Math.min(videoDuration - minGap, targetStart));
      if (startTime >= endTime - minGap * 0.5) {
        endTime = Math.min(videoDuration, startTime + Math.max(minGap, Math.min(5, videoDuration - startTime)));
      }
      lockedDuration = Math.max(0.1, endTime - startTime);
    }
  }

  function setStartAndEndFromEnd(targetEnd, minGap = 0.3) {
    if (isDurationLocked) {
      const dur = Math.max(0.1, Math.min(videoDuration, lockedDuration || (endTime - startTime) || 1));
      lockedDuration = dur;
      endTime = Math.min(videoDuration, Math.max(dur, targetEnd));
      startTime = Math.max(0, endTime - dur);
    } else {
      endTime = Math.min(videoDuration, Math.max(minGap, targetEnd));
      if (endTime <= startTime + minGap * 0.5) {
        startTime = Math.max(0, endTime - Math.max(minGap, Math.min(5, endTime)));
      }
      lockedDuration = Math.max(0.1, endTime - startTime);
    }
  }

  function byId(id) {
    if (panelEl) {
      const inPanel = panelEl.querySelector(`#${id}`);
      if (inPanel) return inPanel;
    }
    if (markersEl) {
      const inMarkers = markersEl.querySelector(`#${id}`);
      if (inMarkers) return inMarkers;
    }
    return document.getElementById(id);
  }

  function pickBestRemoteIframeState() {
    const now = Date.now();
    let best = null;
    let bestScore = -1;
    for (const [fId, st] of remoteFramesMap.entries()) {
      if (now - st.updatedAt > 2800) {
        remoteFramesMap.delete(fId);
        continue;
      }
      const area = Number(st.videoArea) || 0;
      const adMult = st.isAd || (st.videoSrc && isAdStreamUrl(st.videoSrc)) ? 0.01 : 1.0;
      const score = area * adMult;
      if (score > bestScore) {
        best = st;
        bestScore = score;
      }
    }
    remoteIframeState = best;
    return best;
  }

  function shouldUseRemoteIframe(localVideoEl) {
    if (!IS_TOP_WINDOW) return false;
    const rem = pickBestRemoteIframeState();
    if (!rem) return false;
    if (!localVideoEl) return true;
    const pRoot = getPlayerContainer(localVideoEl);
    const lRect = getVisibleVideoRect(localVideoEl, pRoot);
    const localArea = lRect.width * lRect.height;
    return (rem.videoArea || 0) >= localArea * 0.75;
  }

  // Safely seek <video> without ever hitting the very end (prevents triggering 'ended' event which closes video or autoplays next video!)
  function applySafeSeekToVideoElement(v, targetSec) {
    if (!v) return;
    lastInternalSeekAt = Date.now();
    const rawDur = (Number.isFinite(v.duration) && v.duration > 0) ? v.duration : videoDuration;
    const endMargin = rawDur <= 60 ? 0.35 : 1.5;
    const maxSafeSeek = Math.max(0, rawDur - endMargin);
    const safeSec = Math.max(0, Math.min(targetSec, maxSafeSeek));
    if (targetSec >= maxSafeSeek && !v.paused) {
      try { v.pause(); } catch (_) {}
    }
    try { v.currentTime = safeSec; } catch (_) {}
  }

  let lastSeekSentAt = 0;
  let pendingSeekTimer = null;

  function seekActivePlayer(targetSec, immediate = false) {
    const doSeek = () => {
      lastSeekSentAt = Date.now();
      const v = findLocalVideo();
      if (IS_TOP_WINDOW && shouldUseRemoteIframe(v)) {
        relayToTab({ type: 'VC_IFRAME_CMD', cmd: 'seek', time: targetSec });
      } else if (v) {
        applySafeSeekToVideoElement(v, targetSec);
      } else if (IS_TOP_WINDOW) {
        relayToTab({ type: 'VC_IFRAME_CMD', cmd: 'seek', time: targetSec });
      }
    };

    if (pendingSeekTimer) {
      clearTimeout(pendingSeekTimer);
      pendingSeekTimer = null;
    }

    const elapsed = Date.now() - lastSeekSentAt;
    if (immediate || elapsed >= 160) {
      doSeek();
    } else {
      pendingSeekTimer = setTimeout(doSeek, 160 - elapsed);
    }
  }

  const DEFAULT_QUALITIES = [
    { height: 1080, audioOnly: false, container: 'mp4', label: '1080p (Full HD)' },
    { height: 720,  audioOnly: false, container: 'mp4', label: '720p (HD)' },
    { height: 480,  audioOnly: false, container: 'mp4', label: '480p' },
    { height: 360,  audioOnly: false, container: 'mp4', label: '360p' },
    { height: 240,  audioOnly: false, container: 'mp4', label: '240p' },
    { height: 144,  audioOnly: false, container: 'mp4', label: '144p' },
    { height: 0,    audioOnly: true,  container: 'mp3', label: '🎵 Audio Only' }
  ];
  let availableQualities = [...DEFAULT_QUALITIES];

  document.addEventListener('fullscreenchange', () => {
    if (!isContextValid()) return;
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (!IS_TOP_WINDOW && !fsEl && isOpen) {
      isOpen = false;
      if (panelEl) panelEl.classList.add('vc-hidden');
    }
    lastExactBarRatio = null;
    ensureMountedInOverlayRoot();
    mountMarkersOnProgressBar();
  });

  function promotePanelToTopLayer(el) {
    if (!el || !el.isConnected) return;
    try {
      if (el.getAttribute('popover') !== 'manual') {
        el.setAttribute('popover', 'manual');
      }
      if (typeof el.showPopover === 'function' && !el.matches(':popover-open')) {
        el.showPopover();
      }
    } catch (_) {}
  }

  function ensureMountedInOverlayRoot() {
    const root = getActiveOverlayRoot();
    if (!root) return;
    if (panelEl && panelEl.parentElement !== root) {
      root.appendChild(panelEl);
    }
    if (markersEl && markersEl.parentElement !== root) {
      root.appendChild(markersEl);
    }
    if (dragShieldEl && dragShieldEl.parentElement !== root) {
      root.appendChild(dragShieldEl);
    }

    // Keep #vc-clipper-panel in Chrome's #top-layer and above any newly opened modal/dialog (e.g. ya.ru Rhythms modal)
    if (panelEl && isOpen && !panelEl.classList.contains('vc-hidden')) {
      promotePanelToTopLayer(panelEl);
      const r = panelEl.getBoundingClientRect();
      if (r.width > 40 && r.height > 40) {
        const checkX = Math.min(window.innerWidth - 10, Math.max(10, Math.round(r.left + r.width / 2)));
        const checkY = Math.min(window.innerHeight - 10, Math.max(10, Math.round(r.top + 22)));
        const topEl = document.elementFromPoint(checkX, checkY);
        if (topEl && topEl !== panelEl && !panelEl.contains(topEl) && topEl !== dragShieldEl) {
          if (root.lastElementChild !== panelEl) {
            root.appendChild(panelEl);
          }
          try {
            if (typeof panelEl.hidePopover === 'function') panelEl.hidePopover();
            if (typeof panelEl.showPopover === 'function') panelEl.showPopover();
          } catch (_) {}
        }
      }
    }
  }

  function ensureMarkersOnly() {
    if (markersEl && dragShieldEl) {
      ensureMountedInOverlayRoot();
      return;
    }
    const root = getActiveOverlayRoot();
    if (!root) return;

    root.querySelectorAll('#vc-native-markers, #vc-drag-shield').forEach((el) => el.remove());

    dragShieldEl = document.createElement('div');
    dragShieldEl.id = 'vc-drag-shield';
    dragShieldEl.className = 'vc-hidden';
    root.appendChild(dragShieldEl);
    shieldElementEventsFromPage(dragShieldEl);

    markersEl = document.createElement('div');
    markersEl.id = 'vc-native-markers';
    markersEl.className = 'vc-hidden vc-fallback-fixed';
    markersEl.innerHTML = `
      <div class="vc-track-selection" id="vc-track-selection"></div>
      <div class="vc-slider-handle vc-handle-start" id="vc-handle-start" title="Start of fragment (drag along timeline)">
        <span>S</span>
        <div class="vc-handle-tooltip" id="vc-tooltip-start">00:00:00</div>
      </div>
      <div class="vc-slider-handle vc-handle-end" id="vc-handle-end" title="End of fragment (drag along timeline)">
        <span>E</span>
        <div class="vc-handle-tooltip" id="vc-tooltip-end">00:30:00</div>
      </div>
    `;
    root.appendChild(markersEl);
    shieldElementEventsFromPage(markersEl);

    bindSliderDragEvents();
  }

  function bindSliderDragEvents() {
    const handleStart = byId('vc-handle-start');
    const handleEnd = byId('vc-handle-end');
    if (!handleStart || !handleEnd || handleStart.dataset.vcBound) return;
    handleStart.dataset.vcBound = '1';

    let activePointerId = null;

    const updateSliderFromClientX = (clientX, which, isFinal = false) => {
      if (!markersEl) return;
      const rect = markersEl.getBoundingClientRect();
      if (rect.width <= 0) return;
      const targetSec = clientXToTimelineTime(clientX, rect);

      if (which === 'start') {
        setStartAndEndFromStart(targetSec, 0.5);
        seekActivePlayer(startTime, isFinal);
      } else if (which === 'end') {
        setStartAndEndFromEnd(targetSec, 0.5);
        seekActivePlayer(endTime, isFinal);
      }
      syncSlidersUI();

      if (!IS_TOP_WINDOW) {
        relayToTab({
          type: 'VC_SLIDER_MOVED_FROM_IFRAME',
          startTime,
          endTime,
          videoDuration
        });
      } else {
        broadcastStateToFrames();
      }
    };

    const stopDragging = (e) => {
      if (!draggingSlider) return;
      if (e) {
        updateSliderFromClientX(e.clientX, draggingSlider, true);
      }
      if (activePointerId !== null) {
        try { handleStart.releasePointerCapture(activePointerId); } catch (_) {}
        try { handleEnd.releasePointerCapture(activePointerId); } catch (_) {}
        activePointerId = null;
      }
      draggingSlider = null;
      handleStart.classList.remove('vc-dragging');
      handleEnd.classList.remove('vc-dragging');
      if (dragShieldEl) dragShieldEl.classList.add('vc-hidden');
    };

    const startDragHandle = (which, handleEl) => (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.stopPropagation();
      e.stopImmediatePropagation();
      e.preventDefault();
      userManuallyAdjustedSliders = true;
      draggingSlider = which;
      handleEl.classList.add('vc-dragging');
      if (dragShieldEl) dragShieldEl.classList.remove('vc-hidden');
      if (e.pointerId !== undefined) {
        activePointerId = e.pointerId;
        try { handleEl.setPointerCapture(e.pointerId); } catch (_) {}
      }
    };

    const swallowClick = (e) => {
      e.stopPropagation();
      e.stopImmediatePropagation();
      e.preventDefault();
    };

    handleStart.addEventListener('pointerdown', startDragHandle('start', handleStart), true);
    handleStart.addEventListener('click', swallowClick, true);

    handleEnd.addEventListener('pointerdown', startDragHandle('end', handleEnd), true);
    handleEnd.addEventListener('click', swallowClick, true);

    window.addEventListener('pointermove', (e) => {
      if (!draggingSlider) return;
      if (typeof e.buttons === 'number' && (e.buttons & 1) === 0) {
        stopDragging(e);
        return;
      }
      e.stopPropagation();
      e.preventDefault();
      updateSliderFromClientX(e.clientX, draggingSlider, false);
    }, true);

    window.addEventListener('pointerup', stopDragging, true);
    window.addEventListener('pointercancel', stopDragging, true);
    window.addEventListener('blur', () => stopDragging(null));
  }

  // ==========================================================================
  // IFRAME REPORTER (runs in child iframes to sync with Top Window)
  // ==========================================================================
  if (!IS_TOP_WINDOW) {
    let lastIdleTickAt = 0;
    const iframeTimer = setInterval(() => {
      if (!isContextValid()) {
        clearInterval(iframeTimer);
        return;
      }
      const now = Date.now();
      // Throttle background polling when panel is closed to save CPU
      if (!remoteOpen && !isOpen && now - lastIdleTickAt < 1200) {
        return;
      }
      lastIdleTickAt = now;

      const v = findLocalVideo();
      const perfStreams = getPerformanceStreams();
      const vSrc = getDirectVideoSrc(v);
      if (vSrc) perfStreams.unshift(vSrc);

      if (perfStreams.length > 0 || v) {
        chrome.runtime.sendMessage({
          type: 'REPORT_FRAME_STREAMS',
          streams: perfStreams,
          frameUrl: window.location.href
        }).catch(() => {});
      }

      if (v) {
        const pRoot = getPlayerContainer(v);
        const vRect = getVisibleVideoRect(v, pRoot);
        const dur = detectFallbackDurationFromDOM(v);
        if (dur > 0 && !isLikelyAdOrPreviewVideo(v)) {
          if (Math.abs(dur - videoDuration) > 1) {
            videoDuration = dur;
            if (endTime > videoDuration || endTime === 30) {
              endTime = Math.min(videoDuration, startTime + Math.min(60, videoDuration - startTime));
            }
          }
        }

        if (isPreviewingLoop && v.currentTime >= endTime) {
          v.pause();
          isPreviewingLoop = false;
          relayToTab({ type: 'VC_PREVIEW_ENDED_FROM_IFRAME' });
        }

        relayToTab({
          type: 'VC_IFRAME_VIDEO_STATE',
          frameUrl: window.location.href,
          videoSrc: vSrc,
          videoHeight: v.videoHeight || 0,
          videoWidth: v.videoWidth || 0,
          streams: perfStreams,
          duration: dur || 0,
          currentTime: Number.isFinite(v.currentTime) ? v.currentTime : 0,
          videoArea: Math.round(vRect.width * vRect.height),
          isAd: isLikelyAdOrPreviewVideo(v)
        });

        const isAllowedFrame = (activeIframeId === null || myFrameId === -1 || activeIframeId === myFrameId);
        if ((remoteOpen || isOpen) && mode === 'fragment' && isAllowedFrame) {
          ensureMarkersOnly();
          mountMarkersOnProgressBar();
          syncSlidersUI();
        } else if (markersEl) {
          markersEl.classList.add('vc-hidden');
        }
      } else if (markersEl) {
        markersEl.classList.add('vc-hidden');
      }
    }, 220);
  }

  function getCleanVideoUrl() {
    const href = IS_TOP_WINDOW ? window.location.href : (document.referrer || window.location.href);
    const v = activeVideo || findLocalVideo();

    // 1. Check if unclose_shadow.js (MAIN world) resolved a per-video permalink from React Fiber / xgplayer
    if (v?.dataset?.vcPermalink && /^https?:\/\//i.test(v.dataset.vcPermalink)) {
      return v.dataset.vcPermalink;
    }

    // 2. Climb single-video DOM ancestors around active <video> to find post/reel/video permalink on feed sites
    if (v) {
      let anc = v.parentElement;
      for (let d = 0; d < 10 && anc && anc !== document.body; d++) {
        if ((anc.querySelectorAll?.('video')?.length || 0) > 1) break;
        if (anc.id) {
          const m = anc.id.match(/xgwrapper-\d+-(\d{15,22})/);
          if (m && m[1]) {
            return `https://www.tiktok.com/@_/video/${m[1]}`;
          }
        }
        const links = anc.querySelectorAll ? anc.querySelectorAll('a[href]') : [];
        for (const a of links) {
          const rawHref = a.href || '';
          if (!/^https?:\/\//i.test(rawHref)) continue;
          if (
            /tiktok\.com\/@[^/]+\/(?:video|photo)\/\d+/i.test(rawHref) ||
            /instagram\.com\/(?:[^/]+\/)?(?:reel|reels|p)\/[A-Za-z0-9_-]+/i.test(rawHref) ||
            /threads\.(?:net|com)\/(?:@[^/]+\/post|t)\/[A-Za-z0-9_-]+/i.test(rawHref) ||
            /(?:x|twitter)\.com\/[^/]+\/status\/\d+/i.test(rawHref) ||
            /(?:vk\.com|vkvideo\.ru)\/(?:video|clip)-?\d+_\d+/i.test(rawHref)
          ) {
            return rawHref.split('?')[0];
          }
        }
        anc = anc.parentElement;
      }
    }

    try {
      const u = new URL(href);
      const zParam = u.searchParams.get('z');
      if (zParam && /^(video|clip)-?\d+_\d+/.test(zParam)) {
        const match = zParam.match(/^((?:video|clip)-?\d+_\d+)/);
        if (match) {
          return `${u.origin}/${match[1]}`;
        }
      }
      if (u.hostname.includes('youtube.com') && u.pathname === '/watch' && u.searchParams.get('v')) {
        return `https://www.youtube.com/watch?v=${u.searchParams.get('v')}`;
      }
    } catch (_) {}
    return href;
  }

  function getBaseVideoTitle() {
    const v = activeVideo || findLocalVideo();
    if (v?.dataset?.vcMetaTitle && v.dataset.vcMetaTitle.trim()) {
      return v.dataset.vcMetaTitle.trim();
    }

    if (window.location.pathname.startsWith('/shorts/')) {
      const shortsTitle = document.querySelector('ytd-reel-video-renderer[is-active] h2, .ytShortsVideoTitleViewModelShortsVideoTitle');
      if (shortsTitle?.textContent?.trim()) return shortsTitle.textContent.trim();
    }

    // Check inside the single-video feed card for TikTok / Instagram / Threads / X captions
    if (v && /(tiktok\.com|instagram\.com|threads\.net|threads\.com|x\.com|twitter\.com)$/i.test(window.location.hostname)) {
      let anc = v.parentElement;
      for (let d = 0; d < 10 && anc && anc !== document.body; d++) {
        if ((anc.querySelectorAll?.('video')?.length || 0) > 1) break;
        const descEl = anc.querySelector?.('[data-e2e="video-desc"], [data-e2e="browse-video-desc"], [data-testid="tweetText"], [data-e2e="video-author-uniqueid"]');
        if (descEl?.textContent?.trim()) {
          return descEl.textContent.trim().slice(0, 120);
        }
        anc = anc.parentElement;
      }
    }

    const ytTitle = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, #title h1 yt-formatted-string');
    if (ytTitle?.textContent?.trim()) return ytTitle.textContent.trim();

    const vkTitle = document.querySelector('[data-testid="video_modal_title"], .mv_title, .VideoPageInfoRow__title');
    if (vkTitle?.textContent?.trim()) return vkTitle.textContent.trim();

    // Universal heading check: only use an <h1> if it is visually visible and NOT covered behind a modal/overlay backdrop
    const h1s = document.querySelectorAll('h1');
    for (const h1 of h1s) {
      const h1Txt = h1.textContent?.trim() || '';
      if (h1Txt.length <= 2) continue;
      const r = h1.getBoundingClientRect();
      if (r.width < 20 || r.height < 10 || r.bottom <= 0 || r.top >= window.innerHeight) continue;
      const cx = Math.min(window.innerWidth - 5, Math.max(5, Math.round(r.left + r.width / 2)));
      const cy = Math.min(window.innerHeight - 5, Math.max(5, Math.round(r.top + r.height / 2)));
      const topHit = document.elementFromPoint(cx, cy);
      if (topHit && (h1 === topHit || h1.contains(topHit) || topHit.contains(h1))) {
        return h1Txt;
      }
    }

    // If a video is inside a modal/dialog (like Yandex Rhythms on ya.ru), look for a title or author inside the modal
    if (v) {
      const modalAnc = v.closest?.('[role="dialog"], [aria-modal="true"], [class*="Modal" i], [class*="Popup" i]');
      if (modalAnc) {
        const modalTitleEl = modalAnc.querySelector?.('h2, h3, [class*="title" i], [class*="author" i], a[href]');
        if (modalTitleEl?.textContent?.trim() && modalTitleEl.textContent.trim().length > 2) {
          return modalTitleEl.textContent.trim().slice(0, 100);
        }
      }
    }

    return document.title.replace(/\s*[-|—•·]\s*[^-|—•·]{2,35}$/, '').trim() || document.title.trim() || 'Video';
  }

  function getActiveYouTubeChapterTitle() {
    if (!window.location.hostname.includes('youtube.com')) return '';
    if (mode !== 'fragment') return '';
    const chapters = getYouTubeChapters();
    if (!chapters || chapters.length < 2) return '';

    let matched = null;
    // 1. Check if startTime & endTime match a chapter's boundaries
    for (const c of chapters) {
      if (Math.abs(startTime - c.startTime) <= 2.5 && Math.abs(endTime - c.endTime) <= 2.5) {
        matched = c;
        break;
      }
    }
    // 2. Check if the selected fragment lies entirely inside a single chapter (e.g. user nudged start/end within an episode)
    if (!matched && (endTime - startTime) < videoDuration * 0.9) {
      for (const c of chapters) {
        if (startTime >= c.startTime - 1.5 && endTime <= c.endTime + 1.5) {
          matched = c;
          break;
        }
      }
    }
    if (!matched) return '';
    if (matched.title && matched.title.trim()) {
      return matched.title.trim();
    }
    // Fallback: if player is currently inside this chapter, read the live chapter title on the YouTube player bar
    const curT = getCurrentPlayerTime();
    if (curT >= matched.startTime - 1 && curT <= matched.endTime + 1) {
      const liveTitleEl = document.querySelector('#movie_player .ytp-chapter-title-content, .html5-video-player .ytp-chapter-title-content');
      const liveTxt = (liveTitleEl?.textContent || '').trim();
      if (liveTxt) return liveTxt;
    }
    return '';
  }

  function getVideoTitle() {
    const chapTitle = getActiveYouTubeChapterTitle();
    if (chapTitle) return chapTitle;
    return getBaseVideoTitle();
  }

  function getCurrentPlayerTime() {
    const v = findLocalVideo();
    if (IS_TOP_WINDOW && shouldUseRemoteIframe(v)) {
      return remoteIframeState?.currentTime || 0;
    }
    if (v && Number.isFinite(v.currentTime)) {
      return v.currentTime;
    }
    if (remoteIframeState && Date.now() - remoteIframeState.updatedAt < 3000) {
      return remoteIframeState.currentTime || 0;
    }
    return 0;
  }

  function getActiveNativeVideoHeight() {
    const normalizeDim = (w, h) => {
      const nw = Number(w) || 0;
      const nh = Number(h) || 0;
      if (nw > 0 && nh > 0) return Math.min(nw, nh);
      return nh || nw || 0;
    };
    const v = findLocalVideo();
    if (IS_TOP_WINDOW && shouldUseRemoteIframe(v)) {
      return normalizeDim(remoteIframeState?.videoWidth, remoteIframeState?.videoHeight);
    }
    if (v && (v.videoHeight > 0 || v.videoWidth > 0)) {
      return normalizeDim(v.videoWidth, v.videoHeight);
    }
    return normalizeDim(remoteIframeState?.videoWidth, remoteIframeState?.videoHeight);
  }

  function collectAllKnownStreams() {
    const list = [];
    const rem = pickBestRemoteIframeState();
    if (rem) {
      if (rem.frameUrl && /^https?:\/\//i.test(rem.frameUrl)) {
        list.push({ url: rem.frameUrl, referer: window.location.href });
      }
      if (rem.videoSrc) {
        list.push({ url: rem.videoSrc, referer: rem.frameUrl || window.location.href });
      }
      for (const s of rem.streams || []) {
        list.push({ url: s, referer: rem.frameUrl || window.location.href });
      }
    }

    if (IS_TOP_WINDOW) {
      for (const ifr of queryAllDeep('iframe')) {
        const r = ifr.getBoundingClientRect();
        if (r.width >= 220 && r.height >= 130 && ifr.src && /^https?:\/\//i.test(ifr.src)) {
          list.push({ url: ifr.src, referer: window.location.href });
        }
      }
    }

    const v = activeVideo || findLocalVideo();
    if (v?.dataset?.vcExtraStreams) {
      try {
        const extraArr = JSON.parse(v.dataset.vcExtraStreams);
        if (Array.isArray(extraArr)) {
          for (const u of extraArr) {
            if (u && /^https?:\/\//i.test(u)) {
              list.push({ url: u, referer: window.location.href });
            }
          }
        }
      } catch (_) {}
    }

    const vSrc = getDirectVideoSrc(v);
    if (vSrc) list.push({ url: vSrc, referer: window.location.href });

    if (window.location.hostname.includes('youtube.com')) {
      try {
        const player = document.getElementById('movie_player') || document.getElementById('shorts-player');
        const raw = player?.dataset?.vcYtMeta;
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed.streamUrls)) {
            for (const item of parsed.streamUrls) {
              if (item?.url && /^https?:\/\//i.test(item.url)) {
                list.push({ url: item.url, referer: window.location.href });
              }
            }
          }
        }
      } catch (_) {}
    }

    for (const s of getPerformanceStreams()) {
      list.push({ url: s, referer: window.location.href });
    }
    return list;
  }

  // Locate the VISIBLE active YouTube progress bar (never a hidden <ytd-shorts> or #inline-preview-player bar!)
  function getActiveYouTubeProgressBar() {
    if (!window.location.hostname.includes('youtube.com')) return null;
    const v = activeVideo || findLocalVideo();
    if (v) {
      const player = v.closest('#movie_player, .html5-video-player');
      if (player) {
        const bar = player.querySelector('.ytp-progress-bar');
        if (bar && bar.getBoundingClientRect().width > 50) return bar;
      }
    }
    const bars = document.querySelectorAll('ytd-watch-flexy #movie_player .ytp-progress-bar, #movie_player .ytp-progress-bar, .html5-video-player .ytp-progress-bar');
    for (const bar of bars) {
      const r = bar.getBoundingClientRect();
      if (r.width > 50 && r.height > 0) return bar;
    }
    return null;
  }

  function getYouTubeChapterContainers(ytBar) {
    const bar = ytBar || getActiveYouTubeProgressBar();
    if (!bar) return [];
    const list = Array.from(bar.querySelectorAll('.ytp-chapter-hover-container'))
      .filter((c) => c.getBoundingClientRect().width > 0);
    if (list.length >= 2) {
      list.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    }
    return list;
  }

  // Extract chapters (episodes) on YouTube from yt-dlp cache, DOM macro-markers, description links, or .ytp-chapter-hover-container segments
  function getYouTubeChapters() {
    if (!window.location.hostname.includes('youtube.com')) return [];
    const pageUrl = getCleanVideoUrl();
    const dur = Math.max(1, videoDuration);

    const ytBar = getActiveYouTubeProgressBar();
    const containers = getYouTubeChapterContainers(ytBar);
    const rects = containers.map((c) => c.getBoundingClientRect());
    const totalContentWidth = rects.reduce((acc, r) => acc + r.width, 0);

    // Precompute visual start ratios (0..1) from the actual chapter containers on the progress bar
    const visualStartRatios = [];
    if (containers.length >= 2 && totalContentWidth > 80) {
      let accumW = 0;
      for (let i = 0; i < rects.length; i++) {
        visualStartRatios.push(i === 0 ? 0 : accumW / totalContentWidth);
        accumW += rects[i].width;
      }
    }

    // Validate that a candidate chapter list matches the currently visible progress bar containers (rejects stale SPA chapters)
    const isChapterListAlignedWithBar = (chaps) => {
      if (!Array.isArray(chaps) || chaps.length < 2) return false;
      if (visualStartRatios.length < 2) return true;
      if (chaps.length !== visualStartRatios.length) return false;
      let totalDiff = 0;
      for (let i = 0; i < chaps.length; i++) {
        const diff = Math.abs((chaps[i].startTime / dur) - visualStartRatios[i]);
        if (diff > 0.08) return false;
        totalDiff += diff;
      }
      return (totalDiff / chaps.length) < 0.04;
    };

    // 1. Exact chapters from yt-dlp (if already fetched)
    const cached = chaptersCache.get(pageUrl);
    if (Array.isArray(cached) && cached.length >= 2 && isChapterListAlignedWithBar(cached)) {
      return cached;
    }

    // Helper: clean a description line into a chapter title after removing the timestamp
    const cleanDescriptionChapterTitle = (rawLine, timeToken) => {
      if (!rawLine) return '';
      let s = rawLine.replace(timeToken, ' ');
      s = s.replace(/\[\s*\]|\(\s*\)/g, ' ');
      // Strip a second end-timestamp if the line had a range like "00:00 - 02:30 Title"
      s = s.replace(/^\s*[-–—~to]+\s*\d{1,2}:\d{2}(?::\d{2})?\b/i, ' ');
      // Strip leading track number like "01." or "1)"
      s = s.replace(/^\s*\d{1,3}\s*[.)]\s*/, '');
      // Strip leading/trailing separators
      s = s.replace(/^[\s\-–—:|•·[\]()]+|[\s\-–—:|•·[\]()]+$/g, '').trim();
      return s;
    };

    // Extract [{ time, title }] from a macro-markers list renderer
    const extractFromMacroList = (listEl) => {
      if (!listEl) return [];
      const items = listEl.querySelectorAll('ytd-macro-markers-list-item-renderer');
      const entries = [];
      for (const item of items) {
        const timeEl = item.querySelector('#time');
        const txt = (timeEl?.textContent || '').trim();
        if (!/^\d{1,2}:\d{2}(?::\d{2})?$/.test(txt)) continue;
        const t = parseTimeInput(txt);
        if (t === null || t < 0 || t >= dur) continue;
        const titleEl = item.querySelector('h4.macro-markers, #details h4, h4, #title');
        const title = (titleEl?.textContent || titleEl?.getAttribute?.('title') || '').trim();
        if (entries.length === 0) {
          if (t <= 15) entries.push({ time: t, title });
        } else if (t > entries[entries.length - 1].time) {
          entries.push({ time: t, title });
        } else if (t === 0 && entries.length >= 2) {
          break;
        }
      }
      return entries;
    };

    // Extract [{ time, title }] from video description text lines / timestamp links
    const extractFromDescription = () => {
      const descEl = document.querySelector('ytd-watch-metadata #description-inline-expander, ytd-watch-metadata #description, #description-inline-expander');
      if (!descEl) return [];
      const lines = (descEl.innerText || descEl.textContent || '').split(/\r?\n/);
      const entries = [];
      for (const line of lines) {
        const m = line.match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/);
        if (!m) continue;
        const t = parseTimeInput(m[1]);
        if (t === null || t < 0 || t >= dur) continue;
        const title = cleanDescriptionChapterTitle(line, m[1]);
        if (entries.length === 0) {
          if (t <= 15) entries.push({ time: t, title });
        } else if (t > entries[entries.length - 1].time) {
          entries.push({ time: t, title });
        }
      }
      return entries;
    };

    const entriesToChapters = (entries) => entries.map((item, idx) => ({
      startTime: item.time,
      endTime: idx + 1 < entries.length ? entries[idx + 1].time : dur,
      title: item.title || ''
    }));

    // 2. Collect candidate chapter lists (with titles!) from active watch metadata & macro-marker lists
    const candidateEntriesLists = [
      ...Array.from(document.querySelectorAll('ytd-watch-flexy ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-macro-markers-description-chapters"] ytd-macro-markers-list-renderer, ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-macro-markers-description-chapters"] ytd-macro-markers-list-renderer'))
        .map(extractFromMacroList),
      extractFromDescription(),
      ...Array.from(document.querySelectorAll('ytd-macro-markers-list-renderer'))
        .map(extractFromMacroList)
    ];

    let fallbackDomChapters = null;
    for (let entries of candidateEntriesLists) {
      if (!entries || entries.length < 2) continue;
      if (containers.length >= 2 && entries.length > containers.length) {
        entries = entries.slice(0, containers.length);
      }
      if (entries.length >= 2) {
        const chaps = entriesToChapters(entries);
        if (isChapterListAlignedWithBar(chaps)) {
          // Fill in any missing titles from description or cached yt-dlp chapters if available
          const descEntries = candidateEntriesLists[1] || [];
          for (let i = 0; i < chaps.length; i++) {
            if (!chaps[i].title && descEntries[i]?.title) {
              chaps[i].title = descEntries[i].title;
            }
            if (!chaps[i].title && Array.isArray(cached) && cached[i]?.title) {
              chaps[i].title = cached[i].title;
            }
          }
          return chaps;
        }
        if (!fallbackDomChapters) fallbackDomChapters = chaps;
      }
    }

    // 3. Visual chapter segments directly on .ytp-progress-bar (.ytp-chapter-hover-container)
    // Compensate for the 2px gap between containers by summing only actual container widths!
    if (ytBar && containers.length >= 2 && totalContentWidth > 80) {
      const chapters = [];
      let accumWidth = 0;
      for (let i = 0; i < rects.length; i++) {
        const stRatio = i === 0 ? 0 : accumWidth / totalContentWidth;
        accumWidth += rects[i].width;
        const endRatio = i === rects.length - 1 ? 1 : accumWidth / totalContentWidth;
        const st = Math.round(stRatio * dur);
        const et = i === rects.length - 1 ? dur : Math.round(endRatio * dur);
        if (et > st) {
          const domTitle = (fallbackDomChapters && fallbackDomChapters[i]?.title) ||
            (Array.isArray(cached) && cached[i]?.title) || '';
          chapters.push({ startTime: st, endTime: et, title: domTitle });
        }
      }
      if (chapters.length >= 2) return chapters;
    }

    return fallbackDomChapters || [];
  }

  function findChapterAtTime(sec, chaptersList) {
    const chapters = chaptersList || getYouTubeChapters();
    if (!chapters || chapters.length < 2) return null;
    const t = Math.max(0, sec);
    for (let i = 0; i < chapters.length; i++) {
      const c = chapters[i];
      const isLast = i === chapters.length - 1;
      // Use -0.6s tolerance at end of chapter so seeks landing 0.1s..0.5s before next chapter's startTime snap to the next chapter
      if (t >= c.startTime - 0.6 && (t < c.endTime - 0.6 || isLast)) {
        return {
          index: i,
          startTime: Math.max(0, c.startTime),
          endTime: Math.min(videoDuration, c.endTime),
          title: c.title || ''
        };
      }
    }
    return null;
  }

  // Convert video time (seconds) -> visual percentage (0..100%) on the timeline bar
  // On YouTube videos with chapters, each .ytp-chapter-hover-container has a 2px margin gap, so we map chapter times directly to the visual container rects!
  function timeToTimelinePercent(sec, isEnd = false) {
    const dur = Math.max(1, videoDuration);
    if (window.location.hostname.includes('youtube.com')) {
      const ytBar = getActiveYouTubeProgressBar();
      if (ytBar) {
        const barRect = ytBar.getBoundingClientRect();
        const containers = getYouTubeChapterContainers(ytBar);
        if (barRect.width > 80 && containers.length >= 2) {
          const chapters = getYouTubeChapters();
          const t = Math.max(0, Math.min(dur, sec));
          if (containers.length === chapters.length) {
            for (let i = 0; i < chapters.length; i++) {
              const c = chapters[i];
              const isLast = i === chapters.length - 1;
              // For start handle (isEnd=false), if t sits on the boundary between chapter i and i+1, snap to the start of chapter i+1
              if (!isEnd && !isLast && Math.abs(t - c.endTime) < 0.15) {
                continue;
              }
              if (t >= c.startTime - 0.15 && (t <= c.endTime + 0.15 || isLast)) {
                const cRect = containers[i].getBoundingClientRect();
                const span = Math.max(0.01, c.endTime - c.startTime);
                const localFrac = Math.max(0, Math.min(1, (t - c.startTime) / span));
                const visualX = cRect.left + localFrac * cRect.width;
                return Math.min(100, Math.max(0, ((visualX - barRect.left) / barRect.width) * 100));
              }
            }
          }
          // Fallback when containers are present: map time across cumulative container widths so 2px gaps are always included
          const rects = containers.map((c) => c.getBoundingClientRect());
          const totalContentW = rects.reduce((acc, r) => acc + r.width, 0);
          if (totalContentW > 80) {
            const targetContentX = (t / dur) * totalContentW;
            let accumW = 0;
            for (let i = 0; i < rects.length; i++) {
              const r = rects[i];
              const nextAccum = accumW + r.width;
              const isLast = i === rects.length - 1;
              if (!isEnd && !isLast && Math.abs(targetContentX - nextAccum) < 1.2) {
                accumW = nextAccum;
                continue;
              }
              if (targetContentX <= nextAccum + 1.2 || isLast) {
                const localOffset = Math.max(0, Math.min(r.width, targetContentX - accumW));
                const visualX = r.left + localOffset;
                return Math.min(100, Math.max(0, ((visualX - barRect.left) / barRect.width) * 100));
              }
              accumW = nextAccum;
            }
          }
        }
      }
    }
    return Math.min(100, Math.max(0, (sec / dur) * 100));
  }

  // Convert mouse clientX -> video time (seconds), inverse of timeToTimelinePercent
  function clientXToTimelineTime(clientX, barRect) {
    const dur = Math.max(1, videoDuration);
    if (window.location.hostname.includes('youtube.com')) {
      const ytBar = getActiveYouTubeProgressBar();
      if (ytBar) {
        const containers = getYouTubeChapterContainers(ytBar);
        const chapters = getYouTubeChapters();
        if (containers.length >= 2 && containers.length === chapters.length) {
          for (let i = 0; i < containers.length; i++) {
            const cRect = containers[i].getBoundingClientRect();
            const isLast = i === containers.length - 1;
            if ((clientX >= cRect.left - 2 && clientX <= cRect.right + 2) || (isLast && clientX > cRect.right)) {
              const localFrac = Math.max(0, Math.min(1, (clientX - cRect.left) / Math.max(1, cRect.width)));
              const c = chapters[i];
              return c.startTime + localFrac * (c.endTime - c.startTime);
            }
          }
        }
      }
    }
    const ratio = Math.max(0, Math.min(1, (clientX - barRect.left) / Math.max(1, barRect.width)));
    return ratio * dur;
  }

  // Read available YouTube video qualities directly from #movie_player dataset (bridged from MAIN world in unclose_shadow.js)
  function getYouTubePlayerDomQualities() {
    if (!window.location.hostname.includes('youtube.com')) return null;
    try {
      const u = new URL(window.location.href);
      let expectedVideoId = u.searchParams.get('v') || '';
      if (!expectedVideoId && u.pathname.startsWith('/shorts/')) {
        expectedVideoId = u.pathname.split('/shorts/')[1]?.split('/')[0] || '';
      }
      const player = document.getElementById('movie_player') || document.getElementById('shorts-player');
      const raw = player?.dataset?.vcYtMeta;
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (expectedVideoId && parsed.videoId && parsed.videoId !== expectedVideoId) {
        return null;
      }
      if (Array.isArray(parsed.qualities) && parsed.qualities.length > 0) {
        return parsed.qualities;
      }
    } catch (_) {}
    return null;
  }

  function applyQualityObjectsList(rawQualities, cacheKey) {
    if (!Array.isArray(rawQualities) || rawQualities.length === 0) return;
    const onlyOne = rawQualities.length === 1;
    const maxDetectedFps = rawQualities.reduce((acc, q) => Math.max(acc, Number(q.fps) || 0), 0);
    if (maxDetectedFps >= 20 && maxDetectedFps <= 120) {
      activeVideoFps = Math.round(maxDetectedFps);
    }
    availableQualities = rawQualities.map((q) => ({
      height: q.height,
      fps: Number(q.fps) || 30,
      audioOnly: false,
      container: q.height <= 1080 ? 'mp4' : 'mkv',
      label: `${q.height}p${onlyOne ? ' (Original)' : (q.fps > 30 ? ` ${q.fps}fps` : '')}`
    }));
    availableQualities.push({
      height: 0,
      audioOnly: true,
      container: 'mp3',
      label: '🎵 Audio Only'
    });
    if (cacheKey) {
      formatsCache.set(cacheKey, availableQualities);
    }
    selectedQuality = availableQualities.find((q) => !q.audioOnly && q.height === 1080) || availableQualities[0];
    if (selectedQuality?.fps >= 20) {
      activeVideoFps = Math.round(selectedQuality.fps);
    }
    renderQualities();
    syncSlidersUI();
    updateDownloadButtonLabel();
  }

  const liveStatusCache = new Map();

  function hasActiveVideoOnPage() {
    const v = findLocalVideo();
    if (v) return true;
    const rem = pickBestRemoteIframeState();
    if (rem && (rem.videoArea > 0 || rem.duration > 0 || rem.videoSrc || (rem.streams && rem.streams.length > 0))) {
      return true;
    }
    return false;
  }

  function isCurrentVideoLive() {
    const pageUrl = getCleanVideoUrl();
    if (liveStatusCache.get(pageUrl) === true) return true;
    const ytLive = document.querySelector('#movie_player.ytp-live, .html5-video-player.ytp-live, .ytp-live-badge:not([disabled])');
    if (ytLive && ytLive.getBoundingClientRect().width > 0) return true;
    const genericLive = document.querySelector('[data-a-target="player-overlay-live-indicator"], [class*="live-badge" i], [class*="liveIndicator" i]');
    if (genericLive && genericLive.getBoundingClientRect().width > 0) return true;
    const v = activeVideo || findLocalVideo();
    if (v && v.readyState >= 1 && !Number.isFinite(v.duration)) return true;
    return false;
  }

  // Automatically check available qualities on the site (with instant fast-path for direct .mp4/.webm files like on 2ch.su!)
  async function fetchFormatsForCurrentVideo(forceRefresh = false) {
    if (!isContextValid()) return;
    if (!forceRefresh && !hasActiveVideoOnPage()) return;
    const fetchBtn = byId('vc-fetch-formats-btn');
    const v = findLocalVideo();
    const useRemote = shouldUseRemoteIframe(v);
    const directSrc = (!useRemote && v) ? getDirectVideoSrc(v) : (remoteIframeState?.videoSrc || '');
    const pageUrl = getCleanVideoUrl();
    const cacheKey = `${pageUrl}|${directSrc}`;

    // Instant 0ms path: if playing a direct single-file .mp4 / .webm (e.g. 2ch.su, imageboards, direct video links)
    if (!forceRefresh && directSrc && isDirectSingleFileVideoUrl(directSrc)) {
      const nativeH = getActiveNativeVideoHeight() || 720;
      const container = nativeH <= 1080 ? 'mp4' : 'mkv';
      availableQualities = [
        { height: nativeH, audioOnly: false, container, label: `${nativeH}p (Original)` },
        { height: 0, audioOnly: true, container: 'mp3', label: '🎵 Audio Only' }
      ];
      selectedQuality = availableQualities[0];
      renderQualities();
      updateDownloadButtonLabel();
      if (fetchBtn) fetchBtn.textContent = '✅ Quality detected';
      lastAutoFormatsKey = cacheKey;
      return;
    }

    if (!forceRefresh && formatsCache.has(cacheKey)) {
      const cached = formatsCache.get(cacheKey);
      availableQualities = cached;
      selectedQuality = availableQualities.find((q) => !q.audioOnly && q.height === 1080) || availableQualities[0];
      renderQualities();
      updateDownloadButtonLabel();
      lastAutoFormatsKey = cacheKey;
      return;
    }

    if (!forceRefresh && window.location.hostname.includes('youtube.com') && (window.location.pathname === '/' || window.location.pathname === '/results')) {
      return;
    }

    // Instant 0ms YouTube player quality extraction (works even under zapret / DPI bypass before yt-dlp finishes)
    const ytDomQuals = getYouTubePlayerDomQualities();
    if (ytDomQuals && ytDomQuals.length > 0) {
      applyQualityObjectsList(ytDomQuals, null);
    }

    if (isFetchingFormats && lastAutoFormatsKey === cacheKey && !forceRefresh) return;
    isFetchingFormats = true;
    lastAutoFormatsKey = cacheKey;

    if (fetchBtn) {
      fetchBtn.textContent = ytDomQuals ? '✅ Qualities detected' : '⏳ Detecting qualities...';
      fetchBtn.disabled = true;
    }

    try {
      const res = await chrome.runtime.sendMessage({
        type: 'GET_FORMATS',
        url: pageUrl,
        videoSrc: directSrc,
        nativeVideoHeight: getActiveNativeVideoHeight(),
        extraStreams: collectAllKnownStreams(),
        userAgent: navigator.userAgent
      });
      // Ignore stale response if the user navigated to a different video while yt-dlp was running
      if (getCleanVideoUrl() !== pageUrl) return;
      if (res?.ok && Array.isArray(res.qualities) && res.qualities.length > 0) {
        if (typeof res.isLive === 'boolean') {
          liveStatusCache.set(pageUrl, res.isLive);
        }
        if (res.duration && res.duration > 0 && Math.abs(res.duration - videoDuration) > 2) {
          videoDuration = res.duration;
          if (endTime > videoDuration) endTime = videoDuration;
          syncSlidersUI();
          broadcastStateToFrames();
        }
        if (Array.isArray(res.chapters) && res.chapters.length >= 2) {
          chaptersCache.set(pageUrl, res.chapters);
          if (!userManuallyAdjustedSliders) {
            const chap = findChapterAtTime(getCurrentPlayerTime(), res.chapters);
            if (chap && chap.endTime > chap.startTime) {
              startTime = chap.startTime;
              endTime = chap.endTime;
              syncSlidersUI();
              broadcastStateToFrames();
            }
          }
        }
        // Merge yt-dlp qualities with YouTube DOM qualities so no tier (<480p or >1080p) is ever missing under zapret
        const mergedMap = new Map();
        for (const q of res.qualities) {
          if (q.height >= 144) mergedMap.set(q.height, { height: q.height, fps: Number(q.fps) || 30 });
        }
        const latestYtDom = getYouTubePlayerDomQualities();
        if (latestYtDom) {
          for (const q of latestYtDom) {
            const prev = mergedMap.get(q.height);
            if (!prev || (Number(q.fps) || 30) > prev.fps) {
              mergedMap.set(q.height, { height: q.height, fps: Number(q.fps) || 30 });
            }
          }
        }
        const mergedList = Array.from(mergedMap.values()).sort((a, b) => b.height - a.height);
        applyQualityObjectsList(mergedList, cacheKey);
        if (fetchBtn) fetchBtn.textContent = '✅ Qualities detected';
      } else {
        const fallbackYtDom = getYouTubePlayerDomQualities();
        if (fallbackYtDom && fallbackYtDom.length > 0) {
          applyQualityObjectsList(fallbackYtDom, cacheKey);
          if (fetchBtn) fetchBtn.textContent = '✅ Qualities detected';
        } else if (fetchBtn) {
          fetchBtn.textContent = '🔄 Refresh Qualities';
        }
      }
    } catch (_) {
      if (fetchBtn) fetchBtn.textContent = '🔄 Refresh Qualities';
    } finally {
      isFetchingFormats = false;
      if (fetchBtn) {
        fetchBtn.disabled = false;
        setTimeout(() => {
          if (fetchBtn && !isFetchingFormats) {
            fetchBtn.textContent = '🔄 Refresh Qualities';
          }
        }, 2500);
      }
    }
  }

  function ensureUI() {
    ensureMarkersOnly();
    if (panelEl) {
      ensureMountedInOverlayRoot();
      return;
    }

    const root = getActiveOverlayRoot();
    if (!root) return;

    root.querySelectorAll('#vc-clipper-panel').forEach((el) => el.remove());

    panelEl = document.createElement('div');
    panelEl.id = 'vc-clipper-panel';
    panelEl.className = 'vc-hidden';
    panelEl.innerHTML = `
      <div class="vc-header" id="vc-drag-handle">
        <div class="vc-brand">
          <span class="vc-devil-logo" aria-hidden="true">😈</span>
          <span>HellDownloader</span>
        </div>
        <div class="vc-header-actions">
          <button type="button" class="vc-hotkey-btn" id="vc-hotkey-btn" title="Click to assign a custom shortcut key"></button>
          <button type="button" class="vc-close-btn" id="vc-close-btn" title="Close">×</button>
        </div>
      </div>
      <div class="vc-body">
        <div class="vc-video-title vc-no-video" id="vc-video-title">Видео не найдено</div>

        <div class="vc-mode-tabs">
          <button type="button" class="vc-mode-tab ${mode === 'full' ? 'vc-active' : ''}" data-mode="full">🎬 Full Video</button>
          <button type="button" class="vc-mode-tab ${mode === 'fragment' ? 'vc-active' : ''}" data-mode="fragment">✂️ Cut Fragment</button>
        </div>

        <div class="vc-fragment-box" id="vc-fragment-box">
          <div class="vc-frag-summary ${mode === 'full' ? 'vc-full-mode' : ''}" id="vc-frag-summary">
            <span class="vc-duration-text ${mode === 'fragment' ? 'vc-hidden' : ''}" id="vc-frag-duration">Duration: 00:30:00</span>
            <div class="vc-duration-edit-wrap ${mode !== 'fragment' ? 'vc-hidden' : ''}" id="vc-duration-edit-wrap">
              <span class="vc-duration-label">Duration:</span>
              <input type="text" class="vc-time-input vc-duration-input" id="vc-input-duration" value="00:30:00" title="Enter fragment duration" />
              <button type="button" class="vc-mini-btn vc-lock-btn ${isDurationLocked ? 'vc-locked' : ''}" id="vc-lock-duration-btn" title="Lock fragment duration (moving one slider moves both)">${isDurationLocked ? '🔒' : '🔓'}</button>
            </div>
            <button type="button" class="vc-preview-btn ${mode !== 'fragment' ? 'vc-hidden' : ''}" id="vc-preview-btn">▶ Preview Clip</button>
          </div>

          <div class="vc-time-rows-wrap ${mode !== 'fragment' ? 'vc-hidden' : ''}" id="vc-time-rows-wrap">
            <div class="vc-time-row">
              <span class="vc-time-label"><span class="vc-dot-green"></span>Start</span>
              <input type="text" class="vc-time-input" id="vc-input-start" value="00:00:00" />
              <div class="vc-step-group">
                <button type="button" class="vc-mini-btn" data-step="start:-1s" title="Step back 1 second">◀ 1s</button>
                <button type="button" class="vc-mini-btn" data-step="start:-1f" title="Step back 1 frame">◀ 1f</button>
                <button type="button" class="vc-mini-btn" data-step="start:+1f" title="Step forward 1 frame">1f ▶</button>
                <button type="button" class="vc-mini-btn" data-step="start:+1s" title="Step forward 1 second">1s ▶</button>
                <button type="button" class="vc-mini-btn vc-pin-btn" id="vc-set-start-now" title="Set Start to current player frame">📍</button>
              </div>
            </div>

            <div class="vc-time-row">
              <span class="vc-time-label"><span class="vc-dot-red"></span>End</span>
              <input type="text" class="vc-time-input" id="vc-input-end" value="00:30:00" />
              <div class="vc-step-group">
                <button type="button" class="vc-mini-btn" data-step="end:-1s" title="Step back 1 second">◀ 1s</button>
                <button type="button" class="vc-mini-btn" data-step="end:-1f" title="Step back 1 frame">◀ 1f</button>
                <button type="button" class="vc-mini-btn" data-step="end:+1f" title="Step forward 1 frame">1f ▶</button>
                <button type="button" class="vc-mini-btn" data-step="end:+1s" title="Step forward 1 second">1s ▶</button>
                <button type="button" class="vc-mini-btn vc-pin-btn" id="vc-set-end-now" title="Set End to current player frame">📍</button>
              </div>
            </div>
          </div>
        </div>

        <div class="vc-section-header">
          <span>Available Qualities</span>
          <button type="button" class="vc-refresh-formats-btn" id="vc-fetch-formats-btn">🔄 Refresh Qualities</button>
        </div>

        <div class="vc-quality-grid" id="vc-quality-grid"></div>

        <button type="button" class="vc-download-btn" id="vc-download-btn">Download</button>

        <div class="vc-progress-box vc-hidden" id="vc-progress-box">
          <div class="vc-progress-bar-bg">
            <div class="vc-progress-bar-fill" id="vc-progress-fill"></div>
          </div>
          <div class="vc-progress-status" id="vc-progress-status">Preparing...</div>
          <div class="vc-progress-actions">
            <button type="button" class="vc-action-secondary vc-hidden" id="vc-reveal-btn">📂 Show in Folder</button>
            <button type="button" class="vc-action-secondary vc-hidden" id="vc-cancel-btn">✖ Cancel</button>
          </div>
        </div>

        <div class="vc-post-download-wrap vc-hidden" id="vc-post-download-wrap">
          <div class="vc-post-download-bar">
            <button type="button" class="vc-post-btn vc-report-btn" id="vc-report-bug-btn" title="Report a bug or issue with this video">
              <span class="vc-post-emoji" aria-hidden="true">😡</span>
              <span>Report Bug</span>
            </button>
            <button type="button" class="vc-post-btn vc-donate-btn" id="vc-donate-btn" title="Support the developer">
              <span class="vc-post-emoji" aria-hidden="true">🔥</span>
              <span>Donate</span>
            </button>
          </div>
          <div class="vc-bug-drawer vc-hidden" id="vc-bug-drawer">
            <textarea class="vc-bug-input" id="vc-bug-input" rows="2" placeholder="Describe the issue (logs & URL will be attached)..."></textarea>
            <div class="vc-bug-actions">
              <button type="button" class="vc-bug-send-btn" id="vc-bug-send-btn">📨 Send Report</button>
              <button type="button" class="vc-bug-cancel-btn" id="vc-bug-close-btn">Cancel</button>
            </div>
            <div class="vc-bug-status vc-hidden" id="vc-bug-status"></div>
          </div>
        </div>
      </div>
    `;
    root.appendChild(panelEl);
    shieldElementEventsFromPage(panelEl);

    bindPanelEvents();
    updateHotkeyButtonText();
    renderQualities();
  }

  function getHotkeyLabel(hk) {
    if (!hk) return 'Shift+F8';
    if (hk.label && typeof hk.label === 'string' && hk.label !== 'undefined') return hk.label;
    const parts = [];
    if (hk.ctrlKey || hk.ctrl) parts.push('Ctrl');
    if (hk.altKey || hk.alt) parts.push('Alt');
    if (hk.shiftKey || hk.shift) parts.push('Shift');
    const rawKey = hk.code && hk.code.startsWith('Key') ? hk.code.slice(3) : (hk.key || hk.code || 'F8');
    parts.push(String(rawKey).toUpperCase());
    return parts.join('+');
  }

  function updateHotkeyButtonText() {
    const btn = byId('vc-hotkey-btn');
    if (!btn) return;
    btn.textContent = isRecordingHotkey ? 'Press a key...' : `⌨️ ${getHotkeyLabel(currentHotkey)}`;
    btn.classList.toggle('vc-recording', isRecordingHotkey);
  }

  function renderQualities() {
    const grid = byId('vc-quality-grid');
    if (!grid) return;
    grid.innerHTML = '';

    for (const q of availableQualities) {
      const item = document.createElement('div');
      const isSelected = (q.audioOnly && selectedQuality.audioOnly) ||
        (!q.audioOnly && !selectedQuality.audioOnly && q.height === selectedQuality.height);
      item.className = `vc-quality-item${isSelected ? ' vc-selected' : ''}`;

      const badgeClass = q.container === 'mp4'
        ? 'vc-badge-mp4'
        : (q.container === 'mkv' ? 'vc-badge-mkv' : 'vc-badge-mp3');

      item.innerHTML = `
        <span class="vc-q-name">${q.label}</span>
        <span class="vc-q-badge ${badgeClass}">${q.container}</span>
      `;

      item.addEventListener('click', () => {
        selectedQuality = q;
        if (q.fps >= 20) {
          activeVideoFps = Math.round(q.fps);
        }
        renderQualities();
        syncSlidersUI();
        updateDownloadButtonLabel();
      });

      grid.appendChild(item);
    }
  }

  function updateDownloadButtonLabel() {
    const btn = byId('vc-download-btn');
    if (!btn) return;
    btn.textContent = 'Download';
  }

  function syncSlidersUI() {
    const startPct = timeToTimelinePercent(startTime, false);
    const endPct = timeToTimelinePercent(endTime, true);

    const handleStart = byId('vc-handle-start');
    const handleEnd = byId('vc-handle-end');
    const selection = byId('vc-track-selection');
    const tipStart = byId('vc-tooltip-start');
    const tipEnd = byId('vc-tooltip-end');
    const inputStart = byId('vc-input-start');
    const inputEnd = byId('vc-input-end');
    const inputDur = byId('vc-input-duration');
    const lockBtn = byId('vc-lock-duration-btn');
    const fragDur = byId('vc-frag-duration');
    const durEditWrap = byId('vc-duration-edit-wrap');

    if (handleStart) handleStart.style.left = `${startPct}%`;
    if (handleEnd) handleEnd.style.left = `${endPct}%`;
    if (selection) {
      selection.style.left = `${startPct}%`;
      selection.style.width = `${Math.max(0, endPct - startPct)}%`;
    }
    if (tipStart) tipStart.textContent = formatTime(startTime);
    if (tipEnd) tipEnd.textContent = formatTime(endTime);
    if (inputStart && document.activeElement !== inputStart) {
      inputStart.value = formatTime(startTime);
    }
    if (inputEnd && document.activeElement !== inputEnd) {
      inputEnd.value = formatTime(endTime);
    }
    const fragLen = Math.max(0, endTime - startTime);
    if (inputDur && document.activeElement !== inputDur) {
      inputDur.value = formatTime(fragLen);
    }
    if (lockBtn) {
      lockBtn.textContent = isDurationLocked ? '🔒' : '🔓';
      lockBtn.classList.toggle('vc-locked', isDurationLocked);
    }
    if (fragDur) {
      const displayDur = mode === 'full' ? videoDuration : fragLen;
      fragDur.textContent = `Duration: ${formatTime(displayDur)}`;
      fragDur.classList.toggle('vc-hidden', mode === 'fragment');
    }
    if (durEditWrap) {
      durEditWrap.classList.toggle('vc-hidden', mode !== 'fragment');
    }
    const titleEl = byId('vc-video-title');
    if (titleEl) {
      if (hasActiveVideoOnPage()) {
        const t = getVideoTitle();
        titleEl.textContent = t;
        titleEl.title = t;
        titleEl.classList.remove('vc-no-video');
      } else {
        titleEl.textContent = 'Видео не найдено';
        titleEl.title = 'Видео не найдено';
        titleEl.classList.add('vc-no-video');
      }
    }
  }

  let lastExactBarRatio = null;
  let lastExactVideoSize = '';

  function mountMarkersOnProgressBar() {
    const shouldShow = (isOpen || remoteOpen) && mode === 'fragment';
    if (!shouldShow || !markersEl) {
      if (markersEl) markersEl.classList.add('vc-hidden');
      return;
    }

    ensureMountedInOverlayRoot();
    markersEl.classList.add('vc-fallback-fixed');

    const ytSettingsPopup = document.querySelector('.ytp-settings-menu');
    if (ytSettingsPopup && window.getComputedStyle(ytSettingsPopup).display !== 'none') {
      markersEl.classList.add('vc-hidden');
      return;
    }

    const v = findLocalVideo();

    if (IS_TOP_WINDOW && shouldUseRemoteIframe(v)) {
      activeVideo = null;
      markersEl.classList.add('vc-hidden');
      return;
    }

    activeVideo = v;

    if (v) {
      const found = findLocalTimelineRect(v);
      if (!found || found.vRect.bottom < 45 || found.vRect.top > window.innerHeight - 45 || found.vRect.width < 200) {
        markersEl.classList.add('vc-hidden');
        return;
      }

      const { rect: r, vRect, pRect: rawPRect, isExact } = found;
      const pRect = rawPRect || vRect;
      const sizeKey = `${Math.round(pRect.width)}x${Math.round(pRect.height)}`;

      let barMetrics;
      if (isExact && r && r.width > 60) {
        const maxBottomDist = Math.max(155, pRect.height * 0.25);
        barMetrics = {
          leftOffset: Math.max(0, r.left - pRect.left),
          width: r.width,
          bottomOffset: Math.max(6, Math.min(maxBottomDist, pRect.bottom - (r.top + r.height / 2))),
          height: Math.max(6, Math.min(12, r.height))
        };
        // Remember exact timeline position so if player controls auto-hide on mouse idle, sliders stay at the exact same spot!
        if (!lastExactBarRatio || lastExactVideoSize !== sizeKey || found.isExplicit || barMetrics.width >= lastExactBarRatio.width - 4) {
          lastExactBarRatio = barMetrics;
          lastExactVideoSize = sizeKey;
        } else {
          barMetrics = lastExactBarRatio;
        }
      } else if (lastExactBarRatio && lastExactVideoSize === sizeKey) {
        barMetrics = lastExactBarRatio;
      } else {
        barMetrics = {
          leftOffset: 14,
          width: Math.max(80, pRect.width - 28),
          bottomOffset: 18,
          height: 8
        };
      }

      const centerY = pRect.bottom - barMetrics.bottomOffset;
      const targetLeft = pRect.left + barMetrics.leftOffset;
      const targetWidth = Math.max(80, barMetrics.width);
      const targetTop = centerY - barMetrics.height / 2;
      const targetHeight = barMetrics.height;

      markersEl.classList.remove('vc-hidden');
      markersEl.style.left = `${targetLeft}px`;
      markersEl.style.width = `${targetWidth}px`;
      markersEl.style.top = `${targetTop}px`;
      markersEl.style.height = `${targetHeight}px`;

      // Universal compensation for pages that apply CSS zoom on <html> or <body> (e.g. ivi.tv sets html { zoom: 1.25 } on 2K/4K screens)
      const actualRect = markersEl.getBoundingClientRect();
      if (actualRect.width > 0 && Math.abs(actualRect.width - targetWidth) > 1.5) {
        const zoomScale = actualRect.width / targetWidth;
        if (zoomScale > 0.25 && zoomScale < 4 && Math.abs(zoomScale - 1) > 0.01) {
          markersEl.style.left = `${targetLeft / zoomScale}px`;
          markersEl.style.width = `${targetWidth / zoomScale}px`;
          markersEl.style.top = `${targetTop / zoomScale}px`;
          markersEl.style.height = `${targetHeight / zoomScale}px`;
        }
      }

      if (isPreviewingLoop && v.currentTime >= endTime) {
        v.pause();
        isPreviewingLoop = false;
        const prevBtn = byId('vc-preview-btn');
        if (prevBtn) prevBtn.textContent = '▶ Preview Clip';
      }
      return;
    }

    markersEl.classList.add('vc-hidden');
  }

  function broadcastStateToFrames() {
    if (!IS_TOP_WINDOW) return;
    const v = findLocalVideo();
    const usingRemote = shouldUseRemoteIframe(v);
    activeIframeId = usingRemote && remoteIframeState ? remoteIframeState.senderFrameId : 0;

    relayToTab({
      type: 'VC_SYNC_STATE',
      remoteOpen: isOpen,
      activeIframeId,
      mode,
      startTime,
      endTime,
      videoDuration,
      isDurationLocked,
      lockedDuration
    });
  }

  function refreshVideoState() {
    const v = findLocalVideo();
    const useRemote = shouldUseRemoteIframe(v);
    activeVideo = useRemote ? null : v;

    const titleEl = byId('vc-video-title');
    if (titleEl) {
      if (hasActiveVideoOnPage()) {
        const t = getVideoTitle();
        titleEl.textContent = t;
        titleEl.title = t;
        titleEl.classList.remove('vc-no-video');
      } else {
        titleEl.textContent = 'Видео не найдено';
        titleEl.title = 'Видео не найдено';
        titleEl.classList.add('vc-no-video');
      }
    }

    let detectedDur = 0;
    let isAdNow = false;

    if (useRemote && remoteIframeState && remoteIframeState.duration > 0) {
      isAdNow = Boolean(remoteIframeState.isAd);
      detectedDur = remoteIframeState.duration;
    } else if (v) {
      isAdNow = isLikelyAdOrPreviewVideo(v);
      detectedDur = detectFallbackDurationFromDOM(v);
    } else if (remoteIframeState && remoteIframeState.duration > 0) {
      isAdNow = Boolean(remoteIframeState.isAd);
      detectedDur = remoteIframeState.duration;
    } else {
      detectedDur = detectFallbackDurationFromDOM(null);
    }

    const currentPageUrl = getCleanVideoUrl();
    const directSrc = (!useRemote && v) ? getDirectVideoSrc(v) : (remoteIframeState?.videoSrc || '');
    const currentVideoIdentity = `${currentPageUrl}|${directSrc}`;
    const isNewVideo = (currentVideoIdentity !== lastVideoKey);

    if (detectedDur > 0 && !isAdNow) {
      if (isNewVideo || videoDuration === 100) {
        lastVideoKey = currentVideoIdentity;
        userManuallyAdjustedSliders = false;
        videoDuration = detectedDur;
        const curTime = getCurrentPlayerTime();
        const activeChap = findChapterAtTime(curTime);
        if (activeChap && activeChap.endTime > activeChap.startTime) {
          startTime = activeChap.startTime;
          endTime = activeChap.endTime;
        } else if (videoDuration <= 90) {
          // For short-form videos (TikTok, Reels, Shorts, Threads <= 90s), default fragment range to the entire clip [0 .. duration]
          startTime = 0;
          endTime = videoDuration;
        } else {
          startTime = Math.max(0, Math.min(curTime, videoDuration - 1));
          endTime = Math.min(videoDuration, startTime + Math.min(60, videoDuration - startTime));
          if (endTime <= startTime) {
            startTime = 0;
            endTime = videoDuration;
          }
        }
        broadcastStateToFrames();
      } else if (Math.abs(detectedDur - videoDuration) > 1) {
        // Always keep videoDuration accurately synced to the real <video>.duration (fixes YouTube slider offset!)
        videoDuration = detectedDur;
        if (endTime > videoDuration) endTime = videoDuration;
        if (startTime >= endTime) startTime = Math.max(0, endTime - 5);
        broadcastStateToFrames();
      }
    }

    // Automatically check available qualities whenever a new video is opened while the panel is visible
    if (isOpen && currentVideoIdentity !== lastAutoFormatsKey) {
      fetchFormatsForCurrentVideo(false);
    }

    ensureMountedInOverlayRoot();
    mountMarkersOnProgressBar();
    syncSlidersUI();
  }

  function bindPanelEvents() {
    byId('vc-close-btn')?.addEventListener('click', () => {
      toggleUI(false);
    });

    byId('vc-hotkey-btn')?.addEventListener('click', () => {
      isRecordingHotkey = !isRecordingHotkey;
      updateHotkeyButtonText();
    });

    const header = byId('vc-drag-handle');
    let isDraggingPanel = false;
    let panelPointerId = null;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    const stopPanelDrag = () => {
      if (!isDraggingPanel) return;
      isDraggingPanel = false;
      if (panelPointerId !== null && header) {
        try { header.releasePointerCapture(panelPointerId); } catch (_) {}
        panelPointerId = null;
      }
      if (dragShieldEl) dragShieldEl.classList.add('vc-hidden');
    };

    header?.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      if (e.target.closest('button')) return;
      e.preventDefault();
      isDraggingPanel = true;
      const rect = panelEl.getBoundingClientRect();
      dragOffsetX = e.clientX - rect.left;
      dragOffsetY = e.clientY - rect.top;
      let initLeft = rect.left;
      let initTop = rect.top;
      if (panelEl.offsetWidth > 0 && Math.abs(rect.width - panelEl.offsetWidth) > 2) {
        const zoomScale = rect.width / panelEl.offsetWidth;
        if (zoomScale > 0.25 && zoomScale < 4 && Math.abs(zoomScale - 1) > 0.01) {
          initLeft = rect.left / zoomScale;
          initTop = rect.top / zoomScale;
        }
      }
      panelEl.style.left = `${initLeft}px`;
      panelEl.style.top = `${initTop}px`;
      panelEl.style.right = 'auto';
      if (dragShieldEl) dragShieldEl.classList.remove('vc-hidden');
      if (e.pointerId !== undefined) {
        panelPointerId = e.pointerId;
        try { header.setPointerCapture(e.pointerId); } catch (_) {}
      }
    });

    window.addEventListener('pointermove', (e) => {
      if (!isDraggingPanel || !panelEl) return;
      // Immediately release if left mouse button is no longer held down
      if (typeof e.buttons === 'number' && (e.buttons & 1) === 0) {
        stopPanelDrag();
        return;
      }
      const rect = panelEl.getBoundingClientRect();
      const targetLeft = Math.max(8, Math.min(window.innerWidth - rect.width - 8, e.clientX - dragOffsetX));
      const targetTop = Math.max(8, Math.min(window.innerHeight - rect.height - 8, e.clientY - dragOffsetY));
      panelEl.style.left = `${targetLeft}px`;
      panelEl.style.top = `${targetTop}px`;

      // Compensate if page has CSS zoom on <html> or <body> (e.g. ivi.tv)
      const actual = panelEl.getBoundingClientRect();
      if (panelEl.offsetWidth > 0 && Math.abs(actual.width - panelEl.offsetWidth) > 2) {
        const zoomScale = actual.width / panelEl.offsetWidth;
        if (zoomScale > 0.25 && zoomScale < 4 && Math.abs(zoomScale - 1) > 0.01) {
          panelEl.style.left = `${targetLeft / zoomScale}px`;
          panelEl.style.top = `${targetTop / zoomScale}px`;
        }
      }
    }, true);

    window.addEventListener('pointerup', stopPanelDrag, true);
    window.addEventListener('pointercancel', stopPanelDrag, true);
    window.addEventListener('mouseup', stopPanelDrag, true);
    window.addEventListener('blur', stopPanelDrag);

    panelEl.querySelectorAll('.vc-mode-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        mode = tab.dataset.mode;
        panelEl.querySelectorAll('.vc-mode-tab').forEach((t) => t.classList.toggle('vc-active', t === tab));
        byId('vc-time-rows-wrap')?.classList.toggle('vc-hidden', mode !== 'fragment');
        byId('vc-preview-btn')?.classList.toggle('vc-hidden', mode !== 'fragment');
        byId('vc-frag-summary')?.classList.toggle('vc-full-mode', mode === 'full');
        syncSlidersUI();
        updateDownloadButtonLabel();
        mountMarkersOnProgressBar();
        broadcastStateToFrames();
      });
    });

    panelEl.querySelectorAll('[data-step]').forEach((btn) => {
      btn.addEventListener('click', () => {
        userManuallyAdjustedSliders = true;
        const [which, stepSpec] = (btn.dataset.step || '').split(':');
        const fps = Math.max(1, Math.round(activeVideoFps || 30));
        const isFrameStep = (stepSpec || '').endsWith('f');
        const stepCount = parseFloat(stepSpec) || 0;
        const frameSec = 1 / fps;

        const applyStep = (curVal) => {
          if (isFrameStep) {
            const curFrames = Math.round(curVal * fps);
            return Math.max(0, (curFrames + stepCount) / fps);
          }
          return Math.max(0, curVal + stepCount);
        };

        if (which === 'start') {
          setStartAndEndFromStart(applyStep(startTime), frameSec);
          seekActivePlayer(startTime, true);
        } else {
          setStartAndEndFromEnd(applyStep(endTime), frameSec);
          seekActivePlayer(endTime, true);
        }
        syncSlidersUI();
        broadcastStateToFrames();
      });
    });

    byId('vc-set-start-now')?.addEventListener('click', () => {
      userManuallyAdjustedSliders = true;
      const cur = getCurrentPlayerTime();
      setStartAndEndFromStart(cur, 0.5);
      syncSlidersUI();
      broadcastStateToFrames();
    });
    byId('vc-set-end-now')?.addEventListener('click', () => {
      userManuallyAdjustedSliders = true;
      const cur = getCurrentPlayerTime();
      setStartAndEndFromEnd(cur, 0.5);
      syncSlidersUI();
      broadcastStateToFrames();
    });

    const inStart = byId('vc-input-start');
    const inEnd = byId('vc-input-end');
    const inDur = byId('vc-input-duration');
    const lockDurBtn = byId('vc-lock-duration-btn');

    inStart?.addEventListener('change', () => {
      userManuallyAdjustedSliders = true;
      const val = parsePanelTimeInput(inStart.value);
      if (val !== null) {
        setStartAndEndFromStart(val, 0.1);
        seekActivePlayer(startTime, true);
      }
      syncSlidersUI();
      broadcastStateToFrames();
    });
    inEnd?.addEventListener('change', () => {
      userManuallyAdjustedSliders = true;
      const val = parsePanelTimeInput(inEnd.value);
      if (val !== null) {
        setStartAndEndFromEnd(val, 0.1);
        seekActivePlayer(endTime, true);
      }
      syncSlidersUI();
      broadcastStateToFrames();
    });
    inDur?.addEventListener('change', () => {
      userManuallyAdjustedSliders = true;
      const val = parsePanelTimeInput(inDur.value);
      if (val !== null) {
        const fps = Math.max(1, Math.round(activeVideoFps || 30));
        const dur = Math.max(1 / fps, Math.min(videoDuration, val));
        lockedDuration = dur;
        endTime = Math.min(videoDuration, startTime + dur);
        if (endTime - startTime < dur - 0.01) {
          startTime = Math.max(0, endTime - dur);
        }
      }
      syncSlidersUI();
      broadcastStateToFrames();
    });
    lockDurBtn?.addEventListener('click', () => {
      isDurationLocked = !isDurationLocked;
      if (isDurationLocked) {
        lockedDuration = Math.max(0.1, endTime - startTime);
      }
      syncSlidersUI();
      broadcastStateToFrames();
    });

    byId('vc-preview-btn')?.addEventListener('click', () => {
      const previewBtn = byId('vc-preview-btn');
      const v = findLocalVideo();
      const useRemote = shouldUseRemoteIframe(v);

      if (!useRemote && v) {
        if (isPreviewingLoop) {
          v.pause();
          isPreviewingLoop = false;
          if (previewBtn) previewBtn.textContent = '▶ Preview Clip';
        } else {
          lastInternalSeekAt = Date.now();
          v.currentTime = startTime;
          v.play().catch(() => {});
          isPreviewingLoop = true;
          if (previewBtn) previewBtn.textContent = '⏸ Stop';
        }
      } else {
        if (isPreviewingLoop) {
          relayToTab({ type: 'VC_IFRAME_CMD', cmd: 'pause' });
          isPreviewingLoop = false;
          if (previewBtn) previewBtn.textContent = '▶ Preview Clip';
        } else {
          relayToTab({ type: 'VC_IFRAME_CMD', cmd: 'preview', startTime, endTime });
          isPreviewingLoop = true;
          if (previewBtn) previewBtn.textContent = '⏸ Stop';
        }
      }
    });

    const fetchBtn = byId('vc-fetch-formats-btn');
    fetchBtn?.addEventListener('click', () => {
      fetchFormatsForCurrentVideo(true);
    });

    // Download Button
    byId('vc-download-btn')?.addEventListener('click', async () => {
      if (isDownloading) return;
      isDownloading = true;
      lastDownloadId = null;

      const dlBtn = byId('vc-download-btn');
      const progBox = byId('vc-progress-box');
      const progFill = byId('vc-progress-fill');
      const progStatus = byId('vc-progress-status');
      const revealBtn = byId('vc-reveal-btn');
      const cancelBtn = byId('vc-cancel-btn');

      if (dlBtn) dlBtn.disabled = true;
      lastDownloadError = '';
      progBox?.classList.remove('vc-hidden');
      revealBtn?.classList.add('vc-hidden');
      cancelBtn?.classList.remove('vc-hidden');
      byId('vc-post-download-wrap')?.classList.add('vc-hidden');
      byId('vc-bug-drawer')?.classList.add('vc-hidden');
      byId('vc-report-bug-btn')?.classList.remove('vc-active');
      if (progFill) progFill.style.width = '3%';
      if (progStatus) progStatus.textContent = 'Preparing and downloading video...';

      try {
        const res = await chrome.runtime.sendMessage({
          type: 'START_DOWNLOAD',
          url: getCleanVideoUrl(),
          videoSrc: getDirectVideoSrc(activeVideo) || remoteIframeState?.videoSrc || '',
          extraStreams: collectAllKnownStreams(),
          title: getVideoTitle(),
          mode,
          startTime,
          endTime,
          height: selectedQuality.height,
          audioOnly: selectedQuality.audioOnly,
          isLive: isCurrentVideoLive(),
          preciseCut,
          userAgent: navigator.userAgent
        });

        if (!res?.ok) {
          throw new Error(res?.error || 'Failed to start download');
        }
      } catch (err) {
        isDownloading = false;
        lastDownloadError = err.message || 'Failed to start download';
        if (dlBtn) dlBtn.disabled = false;
        cancelBtn?.classList.add('vc-hidden');
        if (progStatus) progStatus.textContent = `❌ Error: ${err.message}`;
        byId('vc-post-download-wrap')?.classList.remove('vc-hidden');
      }
    });

    byId('vc-cancel-btn')?.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'CANCEL_DOWNLOAD' });
      isDownloading = false;
      const dlBtn = byId('vc-download-btn');
      if (dlBtn) dlBtn.disabled = false;
      byId('vc-cancel-btn')?.classList.add('vc-hidden');
      const progStatus = byId('vc-progress-status');
      if (progStatus) progStatus.textContent = '⏹ Download cancelled';
    });

    byId('vc-reveal-btn')?.addEventListener('click', async () => {
      if (lastDownloadId === null) return;
      await chrome.runtime.sendMessage({
        type: 'REVEAL_FILE',
        downloadId: lastDownloadId
      });
    });

    byId('vc-donate-btn')?.addEventListener('click', () => {
      window.open(DONATE_URL, '_blank', 'noopener,noreferrer');
    });

    byId('vc-report-bug-btn')?.addEventListener('click', () => {
      const drawer = byId('vc-bug-drawer');
      const btn = byId('vc-report-bug-btn');
      const statusEl = byId('vc-bug-status');
      if (!drawer) return;
      const willOpen = drawer.classList.contains('vc-hidden');
      drawer.classList.toggle('vc-hidden', !willOpen);
      btn?.classList.toggle('vc-active', willOpen);
      if (statusEl) statusEl.classList.add('vc-hidden');
      if (willOpen) {
        setTimeout(() => byId('vc-bug-input')?.focus(), 50);
      }
    });

    byId('vc-bug-close-btn')?.addEventListener('click', () => {
      byId('vc-bug-drawer')?.classList.add('vc-hidden');
      byId('vc-report-bug-btn')?.classList.remove('vc-active');
    });

    byId('vc-bug-send-btn')?.addEventListener('click', async () => {
      const sendBtn = byId('vc-bug-send-btn');
      const inputEl = byId('vc-bug-input');
      const statusEl = byId('vc-bug-status');
      if (!sendBtn || sendBtn.disabled) return;

      const comment = (inputEl?.value || '').trim();

      if (!comment && !lastDownloadError) {
        if (statusEl) {
          statusEl.style.color = '#fca5a5';
          statusEl.textContent = 'Please describe the issue first';
          statusEl.classList.remove('vc-hidden');
        }
        return;
      }

      sendBtn.disabled = true;
      sendBtn.textContent = '⏳ Sending...';
      if (statusEl) statusEl.classList.add('vc-hidden');

      try {
        const res = await chrome.runtime.sendMessage({
          type: 'SEND_FEEDBACK',
          url: getCleanVideoUrl(),
          pageHref: window.location.href,
          title: getVideoTitle(),
          mode,
          startTime: formatTime(startTime),
          endTime: formatTime(endTime),
          quality: selectedQuality.audioOnly ? 'Audio Only (MP3)' : `${selectedQuality.height}p (${selectedQuality.container.toUpperCase()})`,
          tags: [],
          comment,
          lastError: lastDownloadError || ''
        });

        if (res?.ok) {
          if (statusEl) {
            statusEl.style.color = '#86efac';
            statusEl.textContent = '✅ Report & logs sent! Thank you!';
            statusEl.classList.remove('vc-hidden');
          }
          if (inputEl) inputEl.value = '';
          setTimeout(() => {
            byId('vc-bug-drawer')?.classList.add('vc-hidden');
            byId('vc-report-bug-btn')?.classList.remove('vc-active');
          }, 2200);
        } else {
          throw new Error(res?.error || 'Failed to send report');
        }
      } catch (err) {
        if (statusEl) {
          statusEl.style.color = '#fca5a5';
          statusEl.textContent = `❌ ${err.message}`;
          statusEl.classList.remove('vc-hidden');
        }
      } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = '📨 Send Report';
      }
    });
  }

  function toggleUI(forceState) {
    const now = Date.now();
    if (typeof forceState !== 'boolean' && now - (window.__vcLastToggleAt || 0) < 350) {
      return;
    }
    window.__vcLastToggleAt = now;

    ensureUI();
    isOpen = typeof forceState === 'boolean' ? forceState : !isOpen;
    if (!IS_TOP_WINDOW) {
      remoteOpen = isOpen;
      relayToTab({ type: 'VC_SET_OPEN_FROM_IFRAME', isOpen });
    }
    panelEl.classList.toggle('vc-hidden', !isOpen);
    if (isOpen) {
      promotePanelToTopLayer(panelEl);
      refreshVideoState();
      broadcastStateToFrames();
      fetchFormatsForCurrentVideo(false);
    } else {
      try {
        if (typeof panelEl?.hidePopover === 'function') panelEl.hidePopover();
      } catch (_) {}
      if (markersEl) markersEl.classList.add('vc-hidden');
      broadcastStateToFrames();
      if (isPreviewingLoop) {
        if (activeVideo) activeVideo.pause();
        relayToTab({ type: 'VC_IFRAME_CMD', cmd: 'pause' });
        isPreviewingLoop = false;
      }
    }
  }

  const mainTimer = setInterval(() => {
    if (!isContextValid()) {
      clearInterval(mainTimer);
      return;
    }
    if (!isOpen && !remoteOpen) return;
    refreshVideoState();
  }, 200);

  window.addEventListener('resize', () => {
    if (!isContextValid()) return;
    lastExactBarRatio = null;
    if (isOpen || remoteOpen) mountMarkersOnProgressBar();
  });
  window.addEventListener('scroll', () => {
    if (!isContextValid()) return;
    if (isOpen || remoteOpen) mountMarkersOnProgressBar();
  }, true);

  const handleFullscreenChange = () => {
    if (!isContextValid()) return;
    lastExactBarRatio = null;
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (!IS_TOP_WINDOW) {
      if (fsEl) {
        if (remoteOpen && !isOpen) {
          ensureUI();
          isOpen = true;
          panelEl?.classList.remove('vc-hidden');
          refreshVideoState();
          fetchFormatsForCurrentVideo(false);
        }
      } else if (isOpen) {
        isOpen = false;
        panelEl?.classList.add('vc-hidden');
      }
    }
    if (isOpen || remoteOpen) {
      ensureMountedInOverlayRoot();
      mountMarkersOnProgressBar();
    }
  };
  document.addEventListener('fullscreenchange', handleFullscreenChange, true);
  document.addEventListener('webkitfullscreenchange', handleFullscreenChange, true);

  // Automatic YouTube Chapter (Episode) selection when clicking on a chapter on the timeline, in the Chapters panel, or on a description timestamp
  let lastChapterClickAt = 0;

  const handleYouTubeChapterInteraction = (e) => {
    if (!isContextValid() || !window.location.hostname.includes('youtube.com')) return;
    if (draggingSlider) return;
    const target = e.target;
    if (!target || typeof target.closest !== 'function') return;
    if (target.closest('#vc-native-markers, #vc-clipper-panel, #vc-drag-shield')) return;

    const chapters = getYouTubeChapters();
    if (!chapters || chapters.length < 2) return;

    // Case 1: Clicked on or near the YouTube timeline bar (.ytp-progress-bar / .ytp-chapter-hover-container)
    const actualBar = getActiveYouTubeProgressBar();
    if (actualBar) {
      const barRect = actualBar.getBoundingClientRect();
      const clickedBarDOM = Boolean(target.closest('.ytp-progress-bar-container, .ytp-progress-bar, .ytp-scrubber-container'));
      const clickedBarCoords =
        barRect.width > 0 &&
        e.clientX >= barRect.left - 4 &&
        e.clientX <= barRect.right + 4 &&
        e.clientY >= barRect.top - 14 &&
        e.clientY <= barRect.bottom + 14;

      if (clickedBarDOM || clickedBarCoords) {
        let matchedChap = null;
        const allContainers = getYouTubeChapterContainers(actualBar);
        if (allContainers.length >= 2 && allContainers.length === chapters.length) {
          for (let i = 0; i < allContainers.length; i++) {
            const cRect = allContainers[i].getBoundingClientRect();
            if (e.clientX >= cRect.left - 1.5 && e.clientX <= cRect.right + 1.5) {
              matchedChap = chapters[i];
              break;
            }
          }
        }
        if (!matchedChap && barRect.width > 0) {
          const clickedSec = clientXToTimelineTime(e.clientX, barRect);
          matchedChap = findChapterAtTime(clickedSec, chapters);
        }
        if (matchedChap && matchedChap.endTime > matchedChap.startTime) {
          lastChapterClickAt = Date.now();
          startTime = Math.max(0, matchedChap.startTime);
          endTime = Math.min(videoDuration, matchedChap.endTime);
          syncSlidersUI();
          broadcastStateToFrames();
        }
        return;
      }
    }

    // Case 2: Clicked on a chapter card in YouTube's Chapters side panel (ytd-macro-markers-list-item-renderer)
    const macroItem = target.closest('ytd-macro-markers-list-item-renderer');
    if (macroItem) {
      const timeEl = macroItem.querySelector('#time');
      const sec = timeEl ? parseTimeInput((timeEl.textContent || '').trim()) : null;
      if (sec !== null) {
        const matchedChap = findChapterAtTime(sec + 0.1, chapters);
        if (matchedChap && matchedChap.endTime > matchedChap.startTime) {
          lastChapterClickAt = Date.now();
          startTime = Math.max(0, matchedChap.startTime);
          endTime = Math.min(videoDuration, matchedChap.endTime);
          syncSlidersUI();
          broadcastStateToFrames();
        }
      }
      return;
    }

    // Case 3: Clicked on a timestamp link in the description or comments (e.g. "20:25")
    const tsLink = target.closest('a');
    if (tsLink) {
      let sec = parseTimeInput((tsLink.textContent || '').trim());
      if (sec === null && tsLink.href) {
        const m = tsLink.href.match(/[?&]t=(\d+)s?/);
        if (m && m[1]) sec = Number(m[1]);
      }
      if (sec !== null) {
        const matchedChap = findChapterAtTime(sec + 0.1, chapters);
        if (matchedChap && matchedChap.endTime > matchedChap.startTime) {
          lastChapterClickAt = Date.now();
          startTime = Math.max(0, matchedChap.startTime);
          endTime = Math.min(videoDuration, matchedChap.endTime);
          syncSlidersUI();
          broadcastStateToFrames();
        }
      }
    }
  };

  // Listen only on 'click' (after mouseup finishes cleanly) so moving S/E handles never traps YouTube in scrubbing mode
  document.addEventListener('click', handleYouTubeChapterInteraction, true);

  // Also listen for native <video> seeking initiated by YouTube (e.g. clicking a timestamp link, chapter card, or timeline)
  document.addEventListener('seeking', (e) => {
    if (!isContextValid() || !window.location.hostname.includes('youtube.com')) return;
    if (draggingSlider) return;
    // Ignore seeks triggered by our own slider drag, step buttons, or an already-handled chapter click
    if (Date.now() - lastInternalSeekAt < 400 || Date.now() - lastChapterClickAt < 650) return;
    const v = e.target;
    if (!v || v.tagName !== 'VIDEO' || !Number.isFinite(v.currentTime)) return;
    const chapters = getYouTubeChapters();
    if (!chapters || chapters.length < 2) return;
    const matchedChap = findChapterAtTime(v.currentTime + 0.05, chapters);
    if (matchedChap && matchedChap.endTime > matchedChap.startTime) {
      startTime = Math.max(0, matchedChap.startTime);
      endTime = Math.min(videoDuration, matchedChap.endTime);
      syncSlidersUI();
      broadcastStateToFrames();
    }
  }, true);

  window.addEventListener('keydown', async (e) => {
    if (!isContextValid()) return;
    if (isRecordingHotkey) {
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      const parts = [];
      if (e.ctrlKey) parts.push('Ctrl');
      if (e.altKey) parts.push('Alt');
      if (e.shiftKey) parts.push('Shift');
      const keyName = e.code.startsWith('Key') ? e.code.slice(3) : e.key.toUpperCase();
      parts.push(keyName);

      currentHotkey = {
        code: e.code,
        key: e.key,
        shiftKey: e.shiftKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        label: parts.join('+')
      };
      isRecordingHotkey = false;
      updateHotkeyButtonText();
      try {
        await chrome.storage.local.set({ vcHotkeyV2: currentHotkey });
      } catch (_) {}
      return;
    }

    const matchCode = (e.code === currentHotkey.code) || (e.key.toUpperCase() === (currentHotkey.key || '').toUpperCase());
    const matchMods =
      Boolean(e.shiftKey) === Boolean(currentHotkey.shiftKey) &&
      Boolean(e.ctrlKey) === Boolean(currentHotkey.ctrlKey) &&
      Boolean(e.altKey) === Boolean(currentHotkey.altKey);

    if (matchCode && matchMods) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      suppressContextMenuUntil = Date.now() + 1500;
      hotkeyActiveDown = true;

      if (!e.repeat) {
        const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
        if (!IS_TOP_WINDOW && !fsEl) {
          relayToTab({ type: 'VC_TOGGLE_FROM_IFRAME' });
        } else {
          toggleUI();
        }
      }
    }
  }, true);

  window.addEventListener('keyup', (e) => {
    if (!isContextValid()) return;
    const matchCode = (e.code === currentHotkey.code) || (e.key.toUpperCase() === (currentHotkey.key || '').toUpperCase());
    if (hotkeyActiveDown || matchCode) {
      if (matchCode) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        suppressContextMenuUntil = Date.now() + 1200;
        hotkeyActiveDown = false;
      }
    }
  }, true);

  window.addEventListener('contextmenu', (e) => {
    if (!isContextValid()) return;
    if (hotkeyActiveDown || Date.now() < suppressContextMenuUntil) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }
  }, true);

  chrome.runtime.onMessage.addListener((msg) => {
    if (!isContextValid()) return;

    if (msg.type === 'TOGGLE_CLIPPER_UI' || msg.type === 'VC_TOGGLE_FROM_IFRAME') {
      const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
      if (IS_TOP_WINDOW && (!fsEl || fsEl.tagName !== 'IFRAME')) {
        toggleUI();
      } else if (!IS_TOP_WINDOW && fsEl) {
        toggleUI();
      }
      return;
    }

    if (msg.type === 'VC_SET_OPEN_FROM_IFRAME' && IS_TOP_WINDOW) {
      isOpen = Boolean(msg.isOpen);
      if (panelEl) {
        panelEl.classList.toggle('vc-hidden', !isOpen);
      } else if (isOpen) {
        ensureUI();
        panelEl?.classList.remove('vc-hidden');
      }
      if (!isOpen && markersEl) {
        markersEl.classList.add('vc-hidden');
      }
      broadcastStateToFrames();
      return;
    }

    if (msg.type === 'VC_IFRAME_VIDEO_STATE' && IS_TOP_WINDOW) {
      const fId = msg.senderFrameId ?? -1;
      remoteFramesMap.set(fId, {
        ...msg,
        senderFrameId: fId,
        updatedAt: Date.now()
      });
      pickBestRemoteIframeState();
      return;
    }

    if (msg.type === 'VC_PREVIEW_ENDED_FROM_IFRAME' && IS_TOP_WINDOW) {
      isPreviewingLoop = false;
      const previewBtn = byId('vc-preview-btn');
      if (previewBtn) previewBtn.textContent = '▶ Preview Clip';
      return;
    }

    if (msg.type === 'VC_SYNC_STATE' && !IS_TOP_WINDOW) {
      remoteOpen = Boolean(msg.remoteOpen);
      const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
      if (fsEl && isOpen !== remoteOpen) {
        isOpen = remoteOpen;
        if (panelEl) panelEl.classList.toggle('vc-hidden', !isOpen);
      }
      if (typeof msg.activeIframeId === 'number') activeIframeId = msg.activeIframeId;
      mode = msg.mode || 'fragment';
      if (typeof msg.startTime === 'number') startTime = msg.startTime;
      if (typeof msg.endTime === 'number') endTime = msg.endTime;
      if (typeof msg.videoDuration === 'number' && msg.videoDuration > 0) videoDuration = msg.videoDuration;
      if (typeof msg.isDurationLocked === 'boolean') isDurationLocked = msg.isDurationLocked;
      if (typeof msg.lockedDuration === 'number' && msg.lockedDuration > 0) lockedDuration = msg.lockedDuration;

      const v = findLocalVideo();
      const isAllowedFrame = (activeIframeId === null || myFrameId === -1 || activeIframeId === myFrameId);
      if (v && (remoteOpen || isOpen) && mode === 'fragment' && isAllowedFrame) {
        ensureMarkersOnly();
        mountMarkersOnProgressBar();
        syncSlidersUI();
      } else if (markersEl) {
        markersEl.classList.add('vc-hidden');
      }
      return;
    }

    if (msg.type === 'VC_SLIDER_MOVED_FROM_IFRAME' && IS_TOP_WINDOW) {
      if (typeof msg.startTime === 'number') startTime = msg.startTime;
      if (typeof msg.endTime === 'number') endTime = msg.endTime;
      if (typeof msg.videoDuration === 'number' && msg.videoDuration > 0) videoDuration = msg.videoDuration;
      syncSlidersUI();
      return;
    }

    if (msg.type === 'VC_IFRAME_CMD' && !IS_TOP_WINDOW) {
      const v = findLocalVideo();
      if (!v) return;
      if (msg.cmd === 'seek' && typeof msg.time === 'number') {
        applySafeSeekToVideoElement(v, msg.time);
      } else if (msg.cmd === 'preview' && typeof msg.startTime === 'number' && typeof msg.endTime === 'number') {
        try {
          startTime = msg.startTime;
          endTime = msg.endTime;
          isPreviewingLoop = true;
          v.currentTime = startTime;
          v.play().catch(() => {});
        } catch (_) {}
      } else if (msg.cmd === 'pause') {
        isPreviewingLoop = false;
        try { v.pause(); } catch (_) {}
      }
      return;
    }

    if (msg.type === 'DOWNLOAD_EVENT' && msg.event) {
      const ev = msg.event;
      const dlBtn = byId('vc-download-btn');
      const progFill = byId('vc-progress-fill');
      const progStatus = byId('vc-progress-status');
      const revealBtn = byId('vc-reveal-btn');
      const cancelBtn = byId('vc-cancel-btn');

      if (!progStatus) return;

      if (ev.type === 'progress') {
        if (progFill) progFill.style.width = `${ev.percent || 5}%`;
        progStatus.textContent = ev.stage || `Downloading: ${ev.percent}%`;
      } else if (ev.type === 'complete') {
        isDownloading = false;
        lastDownloadId = ev.downloadId;
        lastDownloadError = '';
        if (dlBtn) dlBtn.disabled = false;
        if (progFill) progFill.style.width = '100%';
        progStatus.textContent = `✅ Done! Saved: ${ev.fileName}`;
        revealBtn?.classList.remove('vc-hidden');
        cancelBtn?.classList.add('vc-hidden');
        byId('vc-post-download-wrap')?.classList.remove('vc-hidden');
      } else if (ev.type === 'cancelled') {
        isDownloading = false;
        if (dlBtn) dlBtn.disabled = false;
        if (progFill) progFill.style.width = '0%';
        progStatus.textContent = `⏹ ${ev.message || 'Cancelled'}`;
        cancelBtn?.classList.add('vc-hidden');
      } else if (ev.type === 'error') {
        isDownloading = false;
        lastDownloadError = ev.error || 'Unknown error';
        if (dlBtn) dlBtn.disabled = false;
        progStatus.textContent = `❌ Error: ${ev.error || 'Unknown error'}`;
        cancelBtn?.classList.add('vc-hidden');
        byId('vc-post-download-wrap')?.classList.remove('vc-hidden');
      }
    }
  });
})();
