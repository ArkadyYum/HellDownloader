const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const net = require('net');
const dns = require('dns');
const { spawn, execFileSync } = require('child_process');

const hostDir = __dirname;
const publicSafeDir = path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'HellDownloader');
const logPath = path.join(hostDir, 'debug.log');

// Rotate debug.log on startup if larger than 256 KB
try {
  if (fs.existsSync(logPath) && fs.statSync(logPath).size > 262144) {
    fs.writeFileSync(logPath, '', 'utf8');
  }
} catch (_) {}

function getAsciiTempDir() {
  try {
    const pubTmp = path.join(publicSafeDir, 'temp');
    fs.mkdirSync(pubTmp, { recursive: true });
    return pubTmp;
  } catch (_) {
    return os.tmpdir();
  }
}

function logDebug(msg) {
  try {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(logPath, line, 'utf8');
  } catch (_) {}
}

// Native Messaging protocol: 4-byte UInt32LE length + UTF-8 JSON
function sendMessage(obj) {
  try {
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);
    process.stdout.write(Buffer.concat([header, payload]));
  } catch (err) {
    logDebug(`sendMessage error: ${err.message}`);
  }
}

let inputBuffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  while (inputBuffer.length >= 4) {
    const msgLen = inputBuffer.readUInt32LE(0);
    if (inputBuffer.length < 4 + msgLen) break;
    const rawMsg = inputBuffer.slice(4, 4 + msgLen).toString('utf8');
    inputBuffer = inputBuffer.slice(4 + msgLen);
    try {
      const msg = JSON.parse(rawMsg);
      handleMessage(msg);
    } catch (err) {
      logDebug(`JSON parse error: ${err.message}`);
    }
  }
});

process.stdin.on('end', () => {
  cleanupAll();
  process.exit(0);
});

function findYtDlp() {
  // Prefer pure-ASCII path in C:\Users\Public\DevilDownload\bin first to avoid any non-ASCII path issues
  const publicBin = path.join(publicSafeDir, 'bin', 'yt-dlp.exe');
  if (fs.existsSync(publicBin)) return publicBin;

  const localBin = path.join(hostDir, 'bin', 'yt-dlp.exe');
  if (fs.existsSync(localBin)) return localBin;
  try {
    const out = execFileSync('where.exe', ['yt-dlp'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
    if (out && fs.existsSync(out)) return out;
  } catch (_) {}
  return localBin;
}

// Silent 24h auto-updates from official GitHub repository (can be toggled via the Autoupdate checkbox in the UI)
const GITHUB_REPO = 'ArkadyYum/HellDownloader';
const SETTINGS_FILE = path.join(publicSafeDir, 'settings.json');

function isAutoUpdateEnabled() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      if (typeof data.autoUpdate === 'boolean') return data.autoUpdate;
    }
  } catch (_) {}
  return true;
}

function setAutoUpdateEnabled(enabled) {
  try {
    let data = {};
    if (fs.existsSync(SETTINGS_FILE)) {
      try { data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || {}; } catch (_) {}
    }
    data.autoUpdate = Boolean(enabled);
    fs.mkdirSync(publicSafeDir, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (_) {}
}

function fetchHttpsText(urlStr) {
  return new Promise((resolve) => {
    const req = https.get(urlStr, { timeout: 6000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      let data = '';
      res.on('data', (c) => { data += c.toString('utf8'); });
      res.on('end', () => resolve(data));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

// Silently auto-update HellDownloader scripts (host.js + extension/*) from GitHub once every 24 hours (only when Autoupdate is enabled)
async function maybeAutoUpdateFromGitHub() {
  if (!GITHUB_REPO || !isAutoUpdateEnabled()) return;
  try {
    const stampFile = path.join(getAsciiTempDir(), 'last_github_update.txt');
    const now = Date.now();
    if (fs.existsSync(stampFile)) {
      const last = Number(fs.readFileSync(stampFile, 'utf8').trim()) || 0;
      if (now - last < 24 * 3600 * 1000) return;
    }
    fs.writeFileSync(stampFile, String(now), 'utf8');

    const baseRaw = `https://raw.githubusercontent.com/${GITHUB_REPO}/main`;
    const remoteManifestStr = await fetchHttpsText(`${baseRaw}/extension/manifest.json`);
    if (!remoteManifestStr) return;
    const remoteManifest = JSON.parse(remoteManifestStr);
    const localManifestPath = path.join(publicSafeDir, 'extension', 'manifest.json');
    let localVer = '0.0.0';
    if (fs.existsSync(localManifestPath)) {
      localVer = JSON.parse(fs.readFileSync(localManifestPath, 'utf8')).version || '0.0.0';
    }
    if (!remoteManifest.version || remoteManifest.version === localVer) return;

    const filesToSync = [
      { remote: 'native_host/host.js', local: path.join(publicSafeDir, 'host.js') },
      { remote: 'extension/background.js', local: path.join(publicSafeDir, 'extension', 'background.js') },
      { remote: 'extension/content.js', local: path.join(publicSafeDir, 'extension', 'content.js') },
      { remote: 'extension/content.css', local: path.join(publicSafeDir, 'extension', 'content.css') },
      { remote: 'extension/unclose_shadow.js', local: path.join(publicSafeDir, 'extension', 'unclose_shadow.js') },
      { remote: 'extension/manifest.json', local: localManifestPath }
    ];

    for (const item of filesToSync) {
      const content = await fetchHttpsText(`${baseRaw}/${item.remote}`);
      if (content && content.length > 50) {
        fs.mkdirSync(path.dirname(item.local), { recursive: true });
        fs.writeFileSync(item.local, content, 'utf8');
      }
    }
    logDebug(`Auto-updated HellDownloader from GitHub (${localVer} -> ${remoteManifest.version})`);
  } catch (_) {}
}

// Silently auto-update yt-dlp.exe in the background once every 24 hours so users never have to update it manually
function maybeAutoUpdateYtDlp() {
  try {
    const stampFile = path.join(getAsciiTempDir(), 'last_ytdlp_update.txt');
    const now = Date.now();
    if (fs.existsSync(stampFile)) {
      const last = Number(fs.readFileSync(stampFile, 'utf8').trim()) || 0;
      if (now - last < 24 * 3600 * 1000) return;
    }
    fs.writeFileSync(stampFile, String(now), 'utf8');
    const ytdlp = findYtDlp();
    if (fs.existsSync(ytdlp)) {
      const child = spawn(ytdlp, ['-U'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.unref();
    }
  } catch (_) {}
}

maybeAutoUpdateYtDlp();
maybeAutoUpdateFromGitHub();

function findFfmpegDir() {
  const publicFfmpeg = path.join(publicSafeDir, 'bin', 'ffmpeg.exe');
  if (fs.existsSync(publicFfmpeg)) return path.dirname(publicFfmpeg);

  const localFfmpeg = path.join(hostDir, 'bin', 'ffmpeg.exe');
  if (fs.existsSync(localFfmpeg)) return path.dirname(localFfmpeg);
  try {
    const out = execFileSync('where.exe', ['ffmpeg'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
    if (out && fs.existsSync(out)) return path.dirname(out);
  } catch (_) {}
  const wingetBase = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  if (fs.existsSync(wingetBase)) {
    try {
      for (const entry of fs.readdirSync(wingetBase)) {
        if (entry.toLowerCase().includes('ffmpeg')) {
          const pkgPath = path.join(wingetBase, entry);
          const found = findFileRecursive(pkgPath, 'ffmpeg.exe', 3);
          if (found) return path.dirname(found);
        }
      }
    } catch (_) {}
  }
  return null;
}

function findFileRecursive(dir, targetName, maxDepth) {
  if (maxDepth < 0) return null;
  try {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isFile() && item.name.toLowerCase() === targetName.toLowerCase()) {
        return full;
      }
      if (item.isDirectory()) {
        const sub = findFileRecursive(full, targetName, maxDepth - 1);
        if (sub) return sub;
      }
    }
  } catch (_) {}
  return null;
}

function sanitizeFileName(name) {
  return (name || 'video')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140) || 'video';
}

function formatTimeForFilename(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 10);
  const parts = [];
  if (hrs > 0) parts.push(String(hrs).padStart(2, '0'));
  parts.push(String(mins).padStart(2, '0'));
  parts.push(String(secs).padStart(2, '0'));
  const base = parts.join('.');
  return ms > 0 ? `${base}_${ms}` : base;
}

function formatTimeForYtDlp(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = (s % 60).toFixed(2);
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${secs.padStart(5, '0')}`;
}

function isVkUrl(urlStr) {
  return /(^|\.|\/)(vk\.com|vkvideo\.ru)/i.test(urlStr || '');
}

function isYouTubeUrl(urlStr) {
  return /(^|\.|\/)(youtube\.com|youtu\.be)/i.test(urlStr || '');
}

function isBareFeedRootUrl(urlStr) {
  if (!urlStr || !/^https?:\/\//i.test(urlStr)) return true;
  try {
    const u = new URL(urlStr);
    const p = u.pathname.replace(/\/+$/, '') || '/';
    if (p === '/' && !u.searchParams.get('v') && !u.searchParams.get('z')) return true;
    if (/^\/(feed|home|explore|foryou|following|reels|clips|shorts)$/i.test(p)) return true;
    // Subreddit feeds (e.g. reddit.com/r/videos) are feed pages; only /comments/ post URLs are direct video pages
    if (/reddit\.com$/i.test(u.hostname) && !/\/comments\//i.test(p)) return true;
  } catch (_) {}
  return false;
}

function isDirectYtDlpSite(urlStr) {
  if (isBareFeedRootUrl(urlStr)) return false;
  return /(youtube\.com|youtu\.be|vk\.com|vkvideo\.ru|rutube\.ru|twitch\.tv|tiktok\.com|instagram\.com|threads\.net|threads\.com|x\.com|twitter\.com|reddit\.com\/r\/[^/]+\/comments\/|v\.redd\.it|ok\.ru|vimeo\.com|nicovideo\.jp|bilibili\.com|dailymotion\.com|archive\.org|coub\.com)/i.test(urlStr || '');
}

function isAudioOnlyStreamUrl(urlStr) {
  if (!urlStr) return false;
  return /(\/audio[-_][^/]*\.m3u8|\/playlist_a\.m3u8|[?&]st=audio\b)/i.test(urlStr);
}

function isAdNetworkUrl(urlStr) {
  if (!urlStr) return false;
  return /(serving-sys\.|eyeblaster\.|flashtalking\.|adriver\.ru|adfox\.ru|betweendigital\.|buzzoola\.|videonow\.ru|pladform\.ru|mradx\.net|target\.my\.com|ads\.vk\.com|googlesyndication\.com|doubleclick\.net|an\.yandex\.ru|yandexadexchange|2mdn\.net)/i.test(urlStr);
}

function isValidOutputFile(filePath) {
  try {
    return Boolean(filePath && fs.existsSync(filePath) && fs.statSync(filePath).size > 4096);
  } catch (_) {
    return false;
  }
}

function isKodikStreamUrl(urlStr) {
  return /\/(240|360|480|720|1080)\.mp4(:hls:manifest\.m3u8|\?|$)/i.test(urlStr || '');
}

function buildKodikResolutionUrl(urlStr, targetHeight) {
  return (urlStr || '').replace(/\/(240|360|480|720|1080)\.mp4/i, `/${targetHeight}.mp4`);
}

function isPikabuStreamUrl(urlStr) {
  return /^https?:\/\/cs\d*\.pikabu\.ru\/s\/[^"'?\s]+?_\d+x\d+_(hslp|hlp|slp|lp|sd|low)\.mp4(\?|$)/i.test(urlStr || '');
}

function buildPikabuResolutionUrl(urlStr, targetHeight) {
  if (!isPikabuStreamUrl(urlStr)) return urlStr;
  const suffix = targetHeight >= 720 ? '_hslp.mp4' : (targetHeight >= 480 ? '_sd.mp4' : '_low.mp4');
  return String(urlStr).replace(/_(hslp|hlp|slp|lp|sd|low)\.mp4(\?|$)/i, `${suffix}$2`);
}

let activeProc = null;
let activeTempCookie = null;
let activeTempVideo = null;
let activeTempFullVideo = null;
let activeServer = null;
let downloadGeneration = 0;

function cleanupAll() {
  downloadGeneration++;
  if (activeProc && activeProc.pid) {
    try {
      execFileSync('taskkill.exe', ['/PID', String(activeProc.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch (_) {}
    activeProc = null;
  }
  if (activeTempCookie && fs.existsSync(activeTempCookie)) {
    try { fs.unlinkSync(activeTempCookie); } catch (_) {}
    activeTempCookie = null;
  }
  if (activeServer) {
    try { activeServer.close(); } catch (_) {}
    activeServer = null;
  }
  if (activeTempFullVideo && fs.existsSync(activeTempFullVideo)) {
    try { fs.unlinkSync(activeTempFullVideo); } catch (_) {}
    activeTempFullVideo = null;
  }
  if (activeTempVideo && fs.existsSync(activeTempVideo)) {
    try { fs.unlinkSync(activeTempVideo); } catch (_) {}
    activeTempVideo = null;
  }
}

function writeTempCookies(cookiesTxt) {
  if (!cookiesTxt || typeof cookiesTxt !== 'string' || !cookiesTxt.trim()) return null;
  const tmpFile = path.join(getAsciiTempDir(), `vc_cookies_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(tmpFile, cookiesTxt, 'utf8');
  return tmpFile;
}

function serveFileForChromeDownload(filePath, fileName, ext) {
  return new Promise((resolve, reject) => {
    const mimeMap = {
      mp4: 'video/mp4',
      mkv: 'video/x-matroska',
      mp3: 'audio/mpeg'
    };
    const contentType = mimeMap[ext] || 'application/octet-stream';
    const asciiFallback = String(fileName || 'video.mp4').replace(/[^\x20-\x7E]|["\\]/g, '_');

    const server = http.createServer((req, res) => {
      if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const stat = fs.statSync(filePath);
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        'Cache-Control': 'no-store'
      });
      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
      req.on('close', () => {
        stream.destroy();
      });
    });

    server.on('error', (err) => reject(err));
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      activeServer = server;
      resolve(`http://127.0.0.1:${address.port}/${encodeURIComponent(fileName)}`);
    });
  });
}

function normalizeTargetUrl(urlStr) {
  if (!urlStr) return '';
  const vimeoMatch = String(urlStr).match(/^https?:\/\/(?:www\.)?vimeo\.com\/(\d+)(?:[/?#]|$)/i);
  if (vimeoMatch && vimeoMatch[1]) {
    return `https://player.vimeo.com/video/${vimeoMatch[1]}`;
  }
  return urlStr;
}

// ============================================================================
// Built-in DNS-over-HTTPS (DoH) Local Proxy for Zapret / Poisoned ISP DNS
// When VPN is off and Zapret is used, Chrome resolves domains via DoH while
// Windows system DNS (getaddrinfo) may fail with Errno 11001 for youtube.com.
// This local tunnel resolves hostnames via 1.1.1.1 / 8.8.8.8 DoH (raw IPv4,
// zero system DNS needed) and connects directly over TCP so Zapret's WinDivert
// driver still sees and desyncs the outbound port 443 TLS ClientHello!
// ============================================================================
const dohDnsCache = new Map();
let dohProxyServer = null;
let dohProxyPort = 0;
let forceDohProxyGlobal = false;

function queryDohEndpoint(endpointUrl) {
  return new Promise((resolve) => {
    const req = https.get(
      endpointUrl,
      {
        headers: { accept: 'application/dns-json' },
        timeout: 2500,
        rejectUnauthorized: false
      },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            const ans = Array.isArray(data.Answer)
              ? data.Answer.find((a) => a.type === 1 && /^\d+\.\d+\.\d+\.\d+$/.test(a.data))
              : null;
            resolve(ans ? ans.data : null);
          } catch (_) {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function resolveHostWithDoH(hostname) {
  if (!hostname) return '127.0.0.1';
  const cleanHost = hostname.replace(/^\[|\]$/g, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(cleanHost) || cleanHost === 'localhost') {
    return cleanHost;
  }
  const cached = dohDnsCache.get(cleanHost);
  if (cached && cached.expires > Date.now()) {
    return cached.ip;
  }

  // For CDN edge domains (e.g. *.googlevideo.com), try fast system DNS first so ISP-local GGC edge servers are used
  if (!/(^|\.)(youtube\.com|youtu\.be)$/i.test(cleanHost)) {
    const sysIp = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 800);
      dns.lookup(cleanHost, { family: 4 }, (err, address) => {
        clearTimeout(timer);
        resolve(!err && address && !/^(127\.|0\.)/.test(address) ? address : null);
      });
    });
    if (sysIp) {
      dohDnsCache.set(cleanHost, { ip: sysIp, expires: Date.now() + 10 * 60 * 1000 });
      return sysIp;
    }
  }

  // Try Google (8.8.8.8) and Cloudflare (1.1.1.1) DoH in parallel using raw IPv4 literals
  const [ggIp, cfIp] = await Promise.all([
    queryDohEndpoint(`https://8.8.8.8/resolve?name=${encodeURIComponent(cleanHost)}&type=A`),
    queryDohEndpoint(`https://1.1.1.1/dns-query?name=${encodeURIComponent(cleanHost)}&type=A`)
  ]);
  const resolvedIp = ggIp || cfIp;
  if (resolvedIp && !/^(127\.|0\.|10\.|192\.168\.)/.test(resolvedIp)) {
    dohDnsCache.set(cleanHost, { ip: resolvedIp, expires: Date.now() + 10 * 60 * 1000 });
    return resolvedIp;
  }

  return new Promise((resolve) => {
    dns.lookup(cleanHost, { family: 4 }, (err, address) => {
      resolve(!err && address ? address : cleanHost);
    });
  });
}

function ensureDohProxyServer() {
  if (dohProxyServer && dohProxyPort > 0) {
    return Promise.resolve(`http://127.0.0.1:${dohProxyPort}`);
  }
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      try {
        const parsed = new URL(req.url);
        const ip = await resolveHostWithDoH(parsed.hostname);
        const port = Number(parsed.port) || 80;
        const proxyReq = http.request(
          {
            host: ip,
            port,
            method: req.method,
            path: parsed.pathname + parsed.search,
            headers: { ...req.headers, host: parsed.host }
          },
          (proxyRes) => {
            res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
            proxyRes.pipe(res);
          }
        );
        proxyReq.on('error', () => {
          try { res.writeHead(502); res.end(); } catch (_) {}
        });
        req.pipe(proxyReq);
      } catch (_) {
        try { res.writeHead(500); res.end(); } catch (_) {}
      }
    });

    server.on('connect', async (req, clientSocket, head) => {
      try {
        const parts = String(req.url || '').split(':');
        const targetPort = Number(parts.pop()) || 443;
        const targetHost = parts.join(':');
        const resolvedIp = await resolveHostWithDoH(targetHost);

        const upstream = net.connect(targetPort, resolvedIp, () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head && head.length > 0) upstream.write(head);
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
        });
        upstream.on('error', () => {
          try { clientSocket.destroy(); } catch (_) {}
        });
        clientSocket.on('error', () => {
          try { upstream.destroy(); } catch (_) {}
        });
      } catch (_) {
        try { clientSocket.destroy(); } catch (_) {}
      }
    });

    server.on('error', () => resolve(null));
    server.listen(0, '127.0.0.1', () => {
      dohProxyServer = server;
      dohProxyPort = server.address().port;
      server.unref();
      logDebug(`DoH local bridge listening on http://127.0.0.1:${dohProxyPort}`);
      resolve(`http://127.0.0.1:${dohProxyPort}`);
    });
  });
}

async function getDohProxyIfNeeded(targetUrl, forceProxy = false) {
  if (forceProxy || forceDohProxyGlobal) {
    return ensureDohProxyServer();
  }
  try {
    const u = new URL(normalizeTargetUrl(targetUrl));
    const host = u.hostname;
    if (!host || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host === 'localhost') return null;
    const systemOk = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 1200);
      dns.lookup(host, { family: 4 }, (err, address) => {
        clearTimeout(timer);
        if (err || !address || /^(127\.|0\.0\.0\.0)/.test(address)) {
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });
    if (!systemOk) {
      logDebug(`System DNS lookup failed or poisoned for ${host}; activating DoH local bridge`);
      forceDohProxyGlobal = true;
      return ensureDohProxyServer();
    }
  } catch (_) {}
  return null;
}

function isDnsFailureText(text) {
  return /(getaddrinfo failed|Failed to resolve|Errno 11001|Name or service not known|Temporary failure in name resolution)/i.test(text || '');
}

async function runDumpJsonOnce(ytdlp, ffmpegDir, targetUrl, cookieFile, userAgent, referer, forceProxy = false) {
  const proxyUrl = await getDohProxyIfNeeded(targetUrl, forceProxy);
  return new Promise((resolve) => {
    const args = [
      '--dump-single-json',
      '--no-playlist',
      '--no-warnings',
      '--force-ipv4',
      '--js-runtimes', `node:${process.execPath}`
    ];
    if (proxyUrl) args.push('--proxy', proxyUrl);
    if (ffmpegDir) args.push('--ffmpeg-location', ffmpegDir);
    if (cookieFile && fs.existsSync(cookieFile)) args.push('--cookies', cookieFile);
    if (userAgent) args.push('--user-agent', userAgent);
    if (referer && /^https?:\/\//i.test(referer)) args.push('--referer', referer);
    args.push(normalizeTargetUrl(targetUrl));

    const proc = spawn(ytdlp, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    proc.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    proc.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
    proc.on('error', (err) => {
      resolve({ code: 1, stdout: '', stderr: err.message });
    });
  });
}

async function runDumpJsonWithCookieFallback(ytdlp, ffmpegDir, targetUrl, cookiesTxt, userAgent, referer) {
  const preferNoCookieFirst = isVkUrl(targetUrl) || isYouTubeUrl(targetUrl);
  const firstUseCookie = !preferNoCookieFirst && Boolean(cookiesTxt);
  const secondUseCookie = preferNoCookieFirst && Boolean(cookiesTxt);

  const runAttempt = async (useCookie, forceProxy = false) => {
    const tmpCookie = useCookie ? writeTempCookies(cookiesTxt) : null;
    try {
      let r = await runDumpJsonOnce(ytdlp, ffmpegDir, targetUrl, tmpCookie, userAgent, referer, forceProxy);
      if (r.code !== 0 && !forceProxy && isDnsFailureText(r.stderr)) {
        logDebug(`DNS failure detected in get_formats (${targetUrl}); retrying via DoH local bridge`);
        forceDohProxyGlobal = true;
        r = await runDumpJsonOnce(ytdlp, ffmpegDir, targetUrl, tmpCookie, userAgent, referer, true);
      }
      return r;
    } finally {
      if (tmpCookie && fs.existsSync(tmpCookie)) {
        try { fs.unlinkSync(tmpCookie); } catch (_) {}
      }
    }
  };

  let res = await runAttempt(firstUseCookie);
  if ((res.code !== 0 || !res.stdout.trim()) && firstUseCookie !== secondUseCookie) {
    res = await runAttempt(secondUseCookie);
  }
  return res;
}

const FEEDBACK_WEBHOOK_URL = 'https://script.google.com/macros/s/AKfycbwkPMkhX8mCEWPhgxfpAeJytluBnNJs8-LKDZqEtUSfuvocZKHy9mOZLTEGYJQ7LULB2A/exec';
const APP_FEEDBACK_TAG = '#HellDownloader';

function getRecentDebugLogSnippet(maxLines = 14) {
  try {
    if (!fs.existsSync(logPath)) return 'No debug.log entries';
    const raw = fs.readFileSync(logPath, 'utf8');
    const lines = raw
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.includes('Received action: send_feedback'))
      .slice(-maxLines)
      .map((l) => l.replace(/vc_cookies_[a-z0-9_]+\.txt/gi, 'cookies.txt').slice(0, 260));
    return lines.join('\n') || 'Empty log';
  } catch (_) {
    return 'Could not read debug.log';
  }
}

function sendFeedbackViaWebhook(textPayload, urlStr = FEEDBACK_WEBHOOK_URL, redirectsLeft = 3) {
  return new Promise((resolve) => {
    try {
      const u = new URL(urlStr);
      const isPost = redirectsLeft === 3;
      const bodyStr = isPost ? JSON.stringify({ text: textPayload }) : '';
      const req = https.request(
        {
          hostname: u.hostname,
          path: u.pathname + u.search,
          port: 443,
          method: isPost ? 'POST' : 'GET',
          headers: isPost
            ? {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': Buffer.byteLength(bodyStr, 'utf8')
              }
            : {},
          timeout: 10000
        },
        (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
            res.resume();
            resolve(sendFeedbackViaWebhook(textPayload, res.headers.location, redirectsLeft - 1));
            return;
          }
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch (_) {
              resolve({ ok: res.statusCode >= 200 && res.statusCode < 300 });
            }
          });
        }
      );
      req.on('error', (err) => resolve({ ok: false, description: err.message }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, description: 'Feedback webhook timeout' });
      });
      if (isPost) req.write(bodyStr, 'utf8');
      req.end();
    } catch (err) {
      resolve({ ok: false, description: err.message });
    }
  });
}

async function handleMessage(msg) {
  const { action, requestId } = msg;
  logDebug(`Received action: ${action} for url=${msg.url || ''}, candidates=${(msg.streamCandidates || []).length}`);

  if (action === 'send_feedback') {
    try {
      const logSnippet = getRecentDebugLogSnippet(14);
      const tagsStr = Array.isArray(msg.tags) && msg.tags.length > 0 ? msg.tags.join(', ') : 'Не указано';
      const rangeInfo = msg.mode === 'fragment' ? `Cut Fragment (${msg.startTime} — ${msg.endTime})` : 'Full Video';

      // Save locally to feedback_history.jsonl so the AI assistant can inspect reports anytime
      try {
        const historyFile = path.join(publicSafeDir, 'feedback_history.jsonl');
        const entry = {
          timestamp: new Date().toISOString(),
          app: APP_FEEDBACK_TAG,
          url: msg.url || msg.pageHref || '',
          title: msg.title || '',
          mode: rangeInfo,
          quality: msg.quality || '',
          tags: msg.tags || [],
          comment: msg.comment || '',
          lastError: msg.lastError || '',
          logSnippet
        };
        fs.appendFileSync(historyFile, `${JSON.stringify(entry)}\n`, 'utf8');
      } catch (_) {}

      const lines = [
        `📦 Приложение: ${APP_FEEDBACK_TAG}`,
        `🌐 Ссылка: ${msg.url || msg.pageHref || '—'}`,
        `🎬 Видео: ${(msg.title || '—').slice(0, 140)}`,
        `⚙️ Режим: ${rangeInfo} • ${msg.quality || '—'}`
      ];
      if (Array.isArray(msg.tags) && msg.tags.length > 0) {
        lines.push(`🏷 Причина: ${tagsStr}`);
      }
      if (msg.comment && msg.comment.trim()) {
        lines.push(`💬 Комментарий: ${msg.comment.trim().slice(0, 500)}`);
      }
      if (msg.lastError && msg.lastError.trim()) {
        lines.push(`❌ Ошибка: ${msg.lastError.trim().slice(0, 350)}`);
      }
      lines.push('', '📋 Лог (debug.log):', logSnippet.slice(0, 2400));

      const textPayload = lines.join('\n').slice(0, 4050);
      const webhookRes = await sendFeedbackViaWebhook(textPayload);

      if (webhookRes?.ok) {
        sendMessage({ requestId, type: 'feedback_result', ok: true });
      } else {
        sendMessage({
          requestId,
          type: 'feedback_result',
          ok: false,
          error: webhookRes?.description || webhookRes?.error || 'Ошибка отправки отчёта'
        });
      }
    } catch (err) {
      sendMessage({ requestId, type: 'feedback_result', ok: false, error: err.message });
    }
    return;
  }

  if (action === 'set_autoupdate') {
    setAutoUpdateEnabled(Boolean(msg.enabled));
    sendMessage({ requestId, type: 'autoupdate_set', ok: true, enabled: Boolean(msg.enabled) });
    return;
  }

  if (action === 'ping') {
    const ytdlp = findYtDlp();
    const ffmpegDir = findFfmpegDir();
    sendMessage({
      requestId,
      type: 'pong',
      ok: fs.existsSync(ytdlp) && Boolean(ffmpegDir),
      ytdlpFound: fs.existsSync(ytdlp),
      ffmpegFound: Boolean(ffmpegDir)
    });
    return;
  }

  if (action === 'cleanup') {
    cleanupAll();
    return;
  }

  if (action === 'cancel') {
    cleanupAll();
    sendMessage({ requestId, type: 'cancelled', message: 'Operation cancelled' });
    return;
  }

  if (action === 'get_formats') {
    const ytdlp = findYtDlp();
    const ffmpegDir = findFfmpegDir();
    const candidates = Array.isArray(msg.streamCandidates) ? msg.streamCandidates : [];

    try {
      // Check if the active top candidate is a Kodik multi-resolution stream URL (e.g. aniru.pro / AnimeGO Kodik tab)
      const kodikCand = candidates[0] && isKodikStreamUrl(candidates[0].url) ? candidates[0] : null;
      if (kodikCand && !isDirectYtDlpSite(msg.url)) {
        const qualities = [1080, 720, 480, 360].map((h) => ({
          height: h,
          fps: 30,
          container: 'mp4',
          vcodec: 'avc1'
        }));
        sendMessage({
          requestId,
          type: 'formats_result',
          ok: true,
          title: '',
          duration: 0,
          qualities
        });
        return;
      }

      let res = { code: 1, stdout: '', stderr: '' };

      // 1. If known yt-dlp site with a specific video URL (YouTube, VK, TikTok post, Instagram Reel, etc.), try page URL first
      if (isDirectYtDlpSite(msg.url)) {
        res = await runDumpJsonWithCookieFallback(ytdlp, ffmpegDir, msg.url, msg.cookiesTxt, msg.userAgent, msg.url);
      }

      // 2. Try direct <video src> of the currently visible <video> element before generic tab candidates
      if ((res.code !== 0 || !res.stdout.trim()) && msg.videoSrc && /^https?:\/\//i.test(msg.videoSrc) && !isAdNetworkUrl(msg.videoSrc) && !(/archive\.org\/details\//i.test(msg.url || '') && /archive\.org\/download\//i.test(msg.videoSrc))) {
        res = await runDumpJsonWithCookieFallback(ytdlp, ffmpegDir, msg.videoSrc, msg.cookiesTxt, msg.userAgent, msg.url);
      }

      // 3. Try captured .m3u8 / .mpd / .mp4 / embed iframe candidates (Yandex Video, VK embeds, Kodik, Ivi, etc.)
      if (res.code !== 0 || !res.stdout.trim()) {
        for (const cand of candidates.slice(0, 6)) {
          if (isAudioOnlyStreamUrl(cand.url) || isAdNetworkUrl(cand.url)) continue;
          // On Archive.org /details/ pages, don't stop at a single .mp4 derivative candidate so step 4 can query the full /details/ item
          if (/archive\.org\/details\//i.test(msg.url || '') && /archive\.org\/download\//i.test(cand.url || '')) continue;
          logDebug(`get_formats trying stream candidate: ${cand.url}`);
          res = await runDumpJsonWithCookieFallback(
            ytdlp,
            ffmpegDir,
            cand.url,
            msg.cookiesTxt,
            msg.userAgent,
            cand.referer || msg.url
          );
          if (res.code === 0 && res.stdout.trim()) break;
        }
      }

      // 4. If non-standard site wasn't tried by page URL yet (and isn't a bare feed homepage), try page URL last
      if ((res.code !== 0 || !res.stdout.trim()) && !isDirectYtDlpSite(msg.url) && !isBareFeedRootUrl(msg.url)) {
        res = await runDumpJsonWithCookieFallback(ytdlp, ffmpegDir, msg.url, msg.cookiesTxt, msg.userAgent, msg.url);
      }

      if (res.code !== 0 || !res.stdout.trim()) {
        sendMessage({
          requestId,
          type: 'formats_result',
          ok: false,
          error: res.stderr.trim() || 'Could not retrieve quality list'
        });
        return;
      }

      const info = JSON.parse(res.stdout);
      const STANDARD_TIERS = [144, 240, 270, 360, 480, 540, 720, 1080, 1440, 2160, 4320];
      const normalizeQualityHeight = (f) => {
        const rawH = Number(f.height) || 0;
        const rawW = Number(f.width) || 0;
        if (rawH <= 0 && rawW <= 0) return 0;

        // If format_id explicitly ends with a standard tier (e.g. VK url1080, url720, url480), use it
        const idMatch = String(f.format_id || '').match(/^url(\d{3,4})$/i);
        if (idMatch) return Number(idMatch[1]);

        // For portrait 9:16 videos (e.g. 1080x1920, 720x1280, 576x1024 on TikTok/Reels/Shorts), use the short dimension (width)
        // For landscape videos with non-standard aspect ratio (e.g. 1920x1030, 1920x800, 1280x686),
        // map the horizontal width (1920 -> 1080p, 1280 -> 720p, 852 -> 480p, 640 -> 360p, 426 -> 240p, 256 -> 144p)
        let candidateH = (rawW > 0 && rawH > rawW) ? rawW : rawH;
        if (rawW > rawH && rawW >= 240) {
          const equiv16x9 = Math.round((rawW * 9) / 16);
          if (equiv16x9 > candidateH) {
            candidateH = equiv16x9;
          }
        }

        for (const tier of STANDARD_TIERS) {
          if (Math.abs(candidateH - tier) / tier <= 0.08) {
            return tier;
          }
        }
        for (const tier of STANDARD_TIERS) {
          if (Math.abs(rawH - tier) / tier <= 0.08) {
            return tier;
          }
        }
        return candidateH;
      };

      const heightsMap = new Map();
      for (const f of info.formats || []) {
        if (f.vcodec !== 'none' && (f.height || f.width)) {
          const h = normalizeQualityHeight(f);
          if (h < 144) continue;
          const prev = heightsMap.get(h);
          const fps = Math.round(Number(f.fps) || 30);
          if (!prev || fps > prev.fps) {
            heightsMap.set(h, {
              height: h,
              fps,
              container: h <= 1080 ? 'mp4' : 'mkv',
              vcodec: f.vcodec || 'avc1'
            });
          }
        }
      }

      // Only if heightsMap is completely empty (0 heights reported in manifest), use nativeVideoHeight if known or fallback choices
      if (heightsMap.size === 0) {
        const nativeH = Number(msg.nativeVideoHeight) || Number(info.height) || 0;
        if (nativeH >= 144) {
          heightsMap.set(nativeH, {
            height: nativeH,
            fps: 30,
            container: nativeH <= 1080 ? 'mp4' : 'mkv',
            vcodec: 'avc1'
          });
        } else {
          for (const h of [1080, 720, 480, 360]) {
            heightsMap.set(h, { height: h, fps: 30, container: 'mp4', vcodec: 'avc1' });
          }
        }
      }

      const qualities = Array.from(heightsMap.values()).sort((a, b) => b.height - a.height);
      const chapters = Array.isArray(info.chapters)
        ? info.chapters
            .filter((c) => typeof c.start_time === 'number' && typeof c.end_time === 'number' && c.end_time > c.start_time)
            .map((c) => ({
              startTime: Number(c.start_time),
              endTime: Number(c.end_time),
              title: c.title || ''
            }))
        : [];
      sendMessage({
        requestId,
        type: 'formats_result',
        ok: true,
        title: info.title || '',
        duration: Number(info.duration) || 0,
        isLive: Boolean(info.is_live),
        qualities,
        chapters
      });
    } catch (err) {
      sendMessage({
        requestId,
        type: 'formats_result',
        ok: false,
        error: err.message
      });
    }
    return;
  }

  if (action === 'download') {
    cleanupAll();
    const myGen = ++downloadGeneration;

    const ytdlp = findYtDlp();
    const ffmpegDir = findFfmpegDir();
    if (!fs.existsSync(ytdlp)) {
      sendMessage({ requestId, type: 'error', error: 'yt-dlp.exe not found in native_host/bin' });
      return;
    }
    if (!ffmpegDir) {
      sendMessage({ requestId, type: 'error', error: 'ffmpeg.exe not found on this system' });
      return;
    }

    const height = Number(msg.height) || 1080;
    const audioOnly = Boolean(msg.audioOnly);
    const isFragment = msg.mode === 'fragment';
    const startTime = Number(msg.startTime) || 0;
    const endTime = Number(msg.endTime) || 0;

    // Container rule: <= 1080p -> mp4, > 1080p -> mkv, audioOnly -> mp3
    const ext = audioOnly ? 'mp3' : (height <= 1080 ? 'mp4' : 'mkv');
    const cleanTitle = sanitizeFileName(msg.title || 'video');
    const qualityTag = audioOnly ? 'Audio' : `${height}p`;
    const rangeTag = isFragment
      ? `_[${formatTimeForFilename(startTime)}-${formatTimeForFilename(endTime)}]`
      : '';
    const defaultFileName = `${cleanTitle}${rangeTag}_[${qualityTag}].${ext}`;

    const tempVideoPath = path.join(getAsciiTempDir(), `vc_stage_${Date.now()}.${ext}`);
    activeTempVideo = tempVideoPath;
    const hasCookies = Boolean(msg.cookiesTxt && typeof msg.cookiesTxt === 'string' && msg.cookiesTxt.trim());

    const candidates = Array.isArray(msg.streamCandidates) ? msg.streamCandidates : [];

    const buildYtDlpArgs = (targetUrl, useCookies, referer, forceFullDownload = false, customOutPath = tempVideoPath, proxyUrl = null) => {
      const isArchiveOrg = /archive\.org\//i.test(targetUrl || '');
      const isYt = isYouTubeUrl(targetUrl);
      // On YouTube, never override yt-dlp's internal 'source' sort with ',proto:https', because YouTube throttles/drops
      // web https streams when a GVS po_token is missing; let yt-dlp pick its best working client stream!
      const sortSpec = isYt ? `res:${height}` : `res:${height},proto:https`;
      const args = [
        '--no-playlist',
        '--newline',
        '--progress',
        '--force-overwrites',
        '--force-ipv4',
        '--socket-timeout', '8',
        '--retries', '3',
        '--fragment-retries', '3',
        '--concurrent-fragments', isArchiveOrg ? '16' : '4',
        '--js-runtimes', `node:${process.execPath}`,
        '--ffmpeg-location', ffmpegDir,
        '--downloader-args', 'ffmpeg_i:-tls_verify 0 -multiple_requests 1 -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 -rw_timeout 15000000'
      ];
      if (proxyUrl) {
        args.push('--proxy', proxyUrl);
      }

      if (useCookies && activeTempCookie && fs.existsSync(activeTempCookie)) {
        args.push('--cookies', activeTempCookie);
      }
      if (msg.userAgent) {
        args.push('--user-agent', msg.userAgent);
      }
      if (referer && /^https?:\/\//i.test(referer)) {
        args.push('--referer', referer);
      }

      const isLiveStream = Boolean(msg.isLive);

      if (audioOnly) {
        args.push('-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0');
      } else if (isLiveStream) {
        // On live broadcasts, always prefer a single muxed video+audio stream (b) so ffmpeg captures both video and audio in sync
        args.push(
          '-S', `res:${height}`,
          '-f', 'b/bv*+ba',
          '--merge-output-format',
          height <= 1080 ? 'mp4' : 'mkv'
        );
      } else if (isArchiveOrg && height <= 480) {
        // On Archive.org, formats are single muxed files (.ia.mp4 480p @ 700kbps vs .mp4 1080p @ 8000kbps)
        args.push(
          '-S', `res:${height}`,
          '-f', `b[height<=${height}]/b/bv*+ba`,
          '--merge-output-format', 'mp4'
        );
      } else if (height <= 1080) {
        args.push(
          '-S', sortSpec,
          '-f',
          'bv*[vcodec^=avc]+ba[ext=m4a]/bv*[vcodec^=avc]+ba/bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b[ext=mp4]/b',
          '--merge-output-format',
          'mp4',
          '--ppa',
          'Merger+ffmpeg_o:-c:v copy -c:a aac'
        );
      } else {
        args.push(
          '-S', sortSpec,
          '-f',
          'bv*+ba/b',
          '--merge-output-format',
          'mkv'
        );
      }

      if (!forceFullDownload && isFragment && endTime > startTime) {
        const fragDuration = Math.max(1, endTime - startTime);
        if (isLiveStream) {
          const endLiveStr = formatTimeForYtDlp(fragDuration);
          args.push('--download-sections', `*00:00:00.00-${endLiveStr}`);
        } else {
          const startStr = formatTimeForYtDlp(startTime);
          const endStr = formatTimeForYtDlp(endTime);
          args.push('--download-sections', `*${startStr}-${endStr}`);
          // Only re-encode keyframes on ultra-short (< 6s) sub-gop clips; for >= 6s clips stream-copy is 10x-15x faster!
          if (msg.preciseCut && fragDuration < 6) {
            args.push('--force-keyframes-at-cuts');
          }
        }
      }

      args.push('-o', customOutPath, normalizeTargetUrl(targetUrl));
      return args;
    };

    const runLocalFfmpegCut = (inputPath, outputPath) => new Promise((resolve) => {
      const ffmpegExe = path.join(ffmpegDir, 'ffmpeg.exe');
      const durationSec = Math.max(0.1, endTime - startTime);
      const ffArgs = [
        '-y',
        '-ss', startTime.toFixed(3),
        '-i', inputPath,
        '-t', durationSec.toFixed(3)
      ];
      if (audioOnly) {
        ffArgs.push('-vn', '-c:a', 'libmp3lame', '-q:a', '0');
      } else {
        ffArgs.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart');
      }
      ffArgs.push(outputPath);

      logDebug(`Running local ffmpeg cut: ${ffmpegExe} ${ffArgs.join(' ')}`);
      sendMessage({
        requestId,
        type: 'progress',
        percent: 90,
        stage: `Cutting fragment locally (${durationSec.toFixed(1)}s)...`
      });

      activeProc = spawn(ffmpegExe, ffArgs, { windowsHide: true });
      activeProc.on('close', (code) => {
        activeProc = null;
        resolve(code);
      });
      activeProc.on('error', () => {
        activeProc = null;
        resolve(1);
      });
    });

    sendMessage({
      requestId,
      type: 'progress',
      percent: 3,
      stage: isFragment
        ? `Downloading & cutting fragment (${ext.toUpperCase()})...`
        : `Downloading video (${ext.toUpperCase()})...`
    });

    let lastPercent = 3;
    let errorLines = [];

    const runYtDlpProcess = (args, isFallbackFull = false) => new Promise((resolve) => {
      logDebug(`Starting yt-dlp with args: ${args.join(' ')}`);
      // Note: Do not set HTTPS_PROXY in process.env because yt-dlp already receives --proxy, while ffmpeg's GnuTLS
      // fails with code 4294967158 when HTTPS_PROXY env var is set (and CDN hosts resolve directly via system DNS).
      activeProc = spawn(ytdlp, args, { windowsHide: true });

      const parseOutput = (chunkStr) => {
        const lines = chunkStr.split(/\r?\n/);
        for (const line of lines) {
          if (!line.trim()) continue;

          const pctMatch = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
          if (pctMatch) {
            const rawPct = parseFloat(pctMatch[1]);
            const scaledPct = isFallbackFull ? Math.round(rawPct * 0.85) : rawPct;
            const pct = Math.min(97, Math.max(lastPercent, scaledPct));
            lastPercent = pct;
            const speedMatch = line.match(/at\s+([^\s]+)\s+/);
            const etaMatch = line.match(/ETA\s+([^\s]+)/);
            const extra = [
              speedMatch ? speedMatch[1] : '',
              etaMatch ? `ETA ${etaMatch[1]}` : ''
            ].filter(Boolean).join(' • ');

            sendMessage({
              requestId,
              type: 'progress',
              percent: Math.round(pct),
              stage: `Downloading: ${Math.round(pct)}%${extra ? ` (${extra})` : ''}`
            });
            continue;
          }

          const timeMatch = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
          if (timeMatch && isFragment && endTime > startTime) {
            const curSec = Number(timeMatch[1]) * 3600 + Number(timeMatch[2]) * 60 + Number(timeMatch[3]);
            const totalDur = Math.max(1, endTime - startTime);
            const pct = Math.min(96, Math.max(lastPercent, Math.round((curSec / totalDur) * 95)));
            lastPercent = pct;
            const curClock = formatTimeForFilename(curSec).replace(/-/g, ':');
            const totClock = formatTimeForFilename(totalDur).replace(/-/g, ':');
            sendMessage({
              requestId,
              type: 'progress',
              percent: pct,
              stage: `Cutting fragment: ${pct}% (${curClock} / ${totClock})`
            });
            continue;
          }

          if (line.includes('[Merger]') || line.includes('[ExtractAudio]') || line.includes('[Fixup')) {
            sendMessage({
              requestId,
              type: 'progress',
              percent: isFallbackFull ? 88 : 98,
              stage: isFallbackFull ? 'Preparing local fragment cut...' : `Merging into .${ext.toUpperCase()}...`
            });
          }

          if (line.startsWith('ERROR:')) {
            logDebug(`[yt-dlp] ${line}`);
            errorLines.push(line);
          }
        }
      };

      activeProc.stdout.on('data', (d) => parseOutput(d.toString('utf8')));
      activeProc.stderr.on('data', (d) => parseOutput(d.toString('utf8')));
      activeProc.on('close', (code) => {
        activeProc = null;
        resolve(code);
      });
      activeProc.on('error', () => {
        activeProc = null;
        resolve(1);
      });
    });

    const runDownloadAttempt = async (targetUrl, useCookies, referer) => {
      if (myGen !== downloadGeneration) return 1;
      errorLines = [];
      if (activeTempCookie && fs.existsSync(activeTempCookie)) {
        try { fs.unlinkSync(activeTempCookie); } catch (_) {}
        activeTempCookie = null;
      }
      if (useCookies && hasCookies) {
        activeTempCookie = writeTempCookies(msg.cookiesTxt);
      }

      let proxyUrl = await getDohProxyIfNeeded(targetUrl, false);
      if (myGen !== downloadGeneration) return 1;
      let args = buildYtDlpArgs(targetUrl, useCookies, referer, false, tempVideoPath, proxyUrl);
      let code = await runYtDlpProcess(args, false);
      if (myGen !== downloadGeneration) return 1;

      // If yt-dlp failed with DNS resolution error (e.g. getaddrinfo failed under Zapret without VPN), retry immediately through our built-in DoH bridge!
      if (code !== 0 && !proxyUrl && errorLines.some((l) => isDnsFailureText(l))) {
        logDebug(`DNS failure during download (${targetUrl}); retrying via built-in DoH bridge`);
        forceDohProxyGlobal = true;
        errorLines = [];
        proxyUrl = await ensureDohProxyServer();
        if (myGen !== downloadGeneration) return 1;
        args = buildYtDlpArgs(targetUrl, useCookies, referer, false, tempVideoPath, proxyUrl);
        code = await runYtDlpProcess(args, false);
        if (myGen !== downloadGeneration) return 1;
      }

      // Reject 0-frame / empty MP4 headers (<= 4KB) caused by ad-stream fallbacks or out-of-range timestamps
      if (code === 0 && !isValidOutputFile(tempVideoPath)) {
        logDebug(`Output file too small or invalid (${tempVideoPath}), treating as failed attempt`);
        if (fs.existsSync(tempVideoPath)) {
          try { fs.unlinkSync(tempVideoPath); } catch (_) {}
        }
        code = 1;
      }

      // Automatic Two-Step Local Cut Fallback:
      // If cutting a fragment directly over the network failed because FFmpeg's internal HLS/DASH demuxer
      // rejected segment TLS or manifest seeking (e.g. strm.yandex.ru/*.mpd), download full stream via yt-dlp and cut locally!
      const hadFfmpegNetworkError = errorLines.some((l) => /ffmpeg exited with code/i.test(l));
      if (code !== 0 && isFragment && endTime > startTime && hadFfmpegNetworkError && myGen === downloadGeneration) {
        logDebug(`Direct --download-sections failed with ffmpeg error on ${targetUrl}; falling back to full download + local ffmpeg cut`);
        errorLines = [];
        const tempFullPath = path.join(getAsciiTempDir(), `vc_full_${Date.now()}.${ext}`);
        activeTempFullVideo = tempFullPath;
        try {
          const fullArgs = buildYtDlpArgs(targetUrl, useCookies, referer, true, tempFullPath, proxyUrl);
          const fullCode = await runYtDlpProcess(fullArgs, true);
          if (myGen === downloadGeneration && fullCode === 0 && isValidOutputFile(tempFullPath)) {
            const cutCode = await runLocalFfmpegCut(tempFullPath, tempVideoPath);
            if (myGen === downloadGeneration && cutCode === 0 && isValidOutputFile(tempVideoPath)) {
              code = 0;
            } else {
              if (fs.existsSync(tempVideoPath)) {
                try { fs.unlinkSync(tempVideoPath); } catch (_) {}
              }
              code = 1;
            }
          }
        } finally {
          if (fs.existsSync(tempFullPath)) {
            try { fs.unlinkSync(tempFullPath); } catch (_) {}
          }
          activeTempFullVideo = null;
        }
      }

      return code;
    };

    const addUrlAttempts = (attemptsArr, url, referer) => {
      if (!url || !/^https?:\/\//i.test(url)) return;
      // On VK and YouTube, try without cookies first so yt-dlp uses its unthrottled default clients (android_vr/tv)
      // instead of throttled web cookies streams; fall back to cookies only if age-restricted/private!
      const preferNoCookie = isVkUrl(url) || isYouTubeUrl(url);
      attemptsArr.push({ url, useCookies: !preferNoCookie && hasCookies, referer });
      if (hasCookies) {
        attemptsArr.push({ url, useCookies: preferNoCookie, referer });
      }
    };

    // Build ordered list of download attempts
    const attempts = [];
    const hasKodikCandidate = Boolean(candidates[0] && isKodikStreamUrl(candidates[0].url));
    const isArchivePage = /archive\.org\/details\//i.test(msg.url || '');

    // Fast path for Archive.org fragment cuts: if the browser <video src> is already a direct .mp4 on Archive.org's CDN
    // (e.g. https://dn720301.ca.archive.org/.../video.ia.mp4 for <=480p or video.mp4 for 1080p), use it directly to skip
    // yt-dlp's 15-second collection metadata scrape and HTTP 302 redirect overhead!
    if (isArchivePage && isFragment && msg.videoSrc && /^https?:\/\//i.test(msg.videoSrc)) {
      const isIa480Src = /\.ia\.mp4(\?|$)/i.test(msg.videoSrc);
      if (height <= 480 && isIa480Src) {
        addUrlAttempts(attempts, msg.videoSrc, msg.url);
      } else if (height > 480 && isIa480Src) {
        // Also try replacing .ia.mp4 with .mp4 directly on the resolved Archive CDN node!
        addUrlAttempts(attempts, msg.videoSrc.replace(/\.ia\.mp4(\?|$)/i, '.mp4$1'), msg.url);
      }
    }

    if (isDirectYtDlpSite(msg.url)) {
      addUrlAttempts(attempts, msg.url, msg.url);
    }

    // Try the active <video>'s own direct stream URL before generic tab candidates (unless Kodik resolution switching is active)
    if (!hasKodikCandidate && msg.videoSrc && /^https?:\/\//i.test(msg.videoSrc) && !isAdNetworkUrl(msg.videoSrc) && (!audioOnly ? !isAudioOnlyStreamUrl(msg.videoSrc) : true)) {
      if (isPikabuStreamUrl(msg.videoSrc) && !audioOnly) {
        const pkbUrl = buildPikabuResolutionUrl(msg.videoSrc, height);
        if (pkbUrl !== msg.videoSrc) {
          addUrlAttempts(attempts, pkbUrl, msg.url);
        }
      }
      addUrlAttempts(attempts, msg.videoSrc, msg.url);
    }

    // Add captured stream candidates (with Kodik / Pikabu resolution substitution if applicable)
    for (const cand of candidates.slice(0, 6)) {
      if (isAdNetworkUrl(cand.url)) continue;
      if (!audioOnly && isAudioOnlyStreamUrl(cand.url)) continue;
      const ref = cand.referer || msg.url;
      if (isKodikStreamUrl(cand.url) && !audioOnly && height <= 1080) {
        const resUrl = buildKodikResolutionUrl(cand.url, height);
        if (resUrl !== cand.url) {
          addUrlAttempts(attempts, resUrl, ref);
        }
      } else if (isPikabuStreamUrl(cand.url) && !audioOnly) {
        const pkbUrl = buildPikabuResolutionUrl(cand.url, height);
        if (pkbUrl !== cand.url) {
          addUrlAttempts(attempts, pkbUrl, ref);
        }
      }
      addUrlAttempts(attempts, cand.url, ref);
    }

    if (hasKodikCandidate && msg.videoSrc && /^https?:\/\//i.test(msg.videoSrc) && !isAdNetworkUrl(msg.videoSrc)) {
      addUrlAttempts(attempts, msg.videoSrc, msg.url);
    }

    if (!isDirectYtDlpSite(msg.url) && !isBareFeedRootUrl(msg.url)) {
      addUrlAttempts(attempts, msg.url, msg.url);
    }

    let exitCode = 1;
    let firstErrorLines = [];
    const triedUrls = new Set();
    for (const att of attempts) {
      if (myGen !== downloadGeneration) return;
      const key = `${att.url}|${att.useCookies}`;
      if (triedUrls.has(key)) continue;
      triedUrls.add(key);

      exitCode = await runDownloadAttempt(att.url, att.useCookies, att.referer);
      if (myGen !== downloadGeneration) return;
      if (exitCode === 0 && isValidOutputFile(tempVideoPath)) {
        break;
      }
      if (firstErrorLines.length === 0 && errorLines.length > 0) {
        firstErrorLines = [...errorLines];
      }
    }

    if (myGen !== downloadGeneration) return;

    if (activeTempCookie && fs.existsSync(activeTempCookie)) {
      try { fs.unlinkSync(activeTempCookie); } catch (_) {}
      activeTempCookie = null;
    }

    if (exitCode === 0 && isValidOutputFile(tempVideoPath)) {
      try {
        const localUrl = await serveFileForChromeDownload(tempVideoPath, defaultFileName, ext);
        sendMessage({
          requestId,
          type: 'ready_for_chrome_download',
          downloadUrl: localUrl,
          fileName: defaultFileName
        });
      } catch (err) {
        cleanupAll();
        sendMessage({
          requestId,
          type: 'error',
          error: `Failed to hand file to Chrome: ${err.message}`
        });
      }
    } else {
      cleanupAll();
      const finalErrors = firstErrorLines.length > 0 ? firstErrorLines : errorLines;
      let errText = finalErrors.join('\n') || 'Could not download video stream (make sure video playback has started)';
      if (/getaddrinfo failed|Failed to resolve/i.test(errText)) {
        errText = 'Системный DNS провайдера блокирует этот домен для внешних программ (в Chrome работает только за счёт встроенного Secure DNS + Zapret). Включите VPN или пропишите DNS 8.8.8.8 / 1.1.1.1 в настройках сетевого адаптера Windows.';
      }
      sendMessage({
        requestId,
        type: 'error',
        error: errText
      });
    }
  }
}
