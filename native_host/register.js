const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const extDir = path.join(rootDir, 'extension');
const iconsDir = path.join(extDir, 'icons');
const hostDir = __dirname;
const keyFile = path.join(hostDir, 'ext_key.json');

fs.mkdirSync(iconsDir, { recursive: true });

// 1. Load or generate RSA key for deterministic Extension ID across all PCs
let keyData;
if (fs.existsSync(keyFile)) {
  keyData = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
} else {
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const keyBase64 = der.toString('base64');
  const hash = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
  const extId = hash.split('').map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
  keyData = { keyBase64, extId };
  fs.writeFileSync(keyFile, JSON.stringify(keyData, null, 2), 'utf8');
}

const customId = process.argv[2] ? process.argv[2].trim() : null;

// 2. Ensure extension/manifest.json has the deterministic key & HellDownloader metadata
const manifestPath = path.join(extDir, 'manifest.json');
let manifest = {
  manifest_version: 3,
  name: 'HellDownloader',
  version: '1.1.0',
  description: 'HellDownloader — universal HTML5 video & frame-accurate fragment clipper up to 4K.',
  key: keyData.keyBase64,
  icons: {
    '16': 'icons/icon-16.png',
    '48': 'icons/icon-48.png',
    '128': 'icons/icon-128.png'
  },
  action: {
    default_title: 'HellDownloader (Shift+F8)',
    default_icon: {
      '16': 'icons/icon-16.png',
      '48': 'icons/icon-48.png',
      '128': 'icons/icon-128.png'
    }
  },
  permissions: [
    'nativeMessaging',
    'downloads',
    'webRequest',
    'cookies',
    'storage',
    'activeTab',
    'scripting',
    'tabs'
  ],
  host_permissions: [
    '<all_urls>'
  ],
  background: {
    service_worker: 'background.js'
  },
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['unclose_shadow.js'],
      run_at: 'document_start',
      world: 'MAIN',
      all_frames: true
    },
    {
      matches: ['<all_urls>'],
      js: ['content.js'],
      css: ['content.css'],
      run_at: 'document_idle',
      all_frames: true
    }
  ]
};

if (fs.existsSync(manifestPath)) {
  try {
    const existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest = {
      ...existing,
      name: 'HellDownloader',
      description: 'HellDownloader — universal HTML5 video & frame-accurate fragment clipper up to 4K.',
      key: keyData.keyBase64
    };
  } catch (_) {}
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

// 3. Install Native Messaging Host into a guaranteed 100% pure-ASCII directory: C:\Users\Public\HellDownloader
// This eliminates all Windows cmd.exe / yt-dlp / ffmpeg bugs with Cyrillic or non-English folder/user names!
let safeRuntimeDir = path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'HellDownloader');
try {
  fs.mkdirSync(safeRuntimeDir, { recursive: true });
} catch (_) {
  safeRuntimeDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'HellDownloader');
  fs.mkdirSync(safeRuntimeDir, { recursive: true });
}

const safeBinDir = path.join(safeRuntimeDir, 'bin');
const safeTempDir = path.join(safeRuntimeDir, 'temp');
const safeExtDir = path.join(safeRuntimeDir, 'extension');
fs.mkdirSync(safeBinDir, { recursive: true });
fs.mkdirSync(safeTempDir, { recursive: true });

// Copy host.js to pure-ASCII runtime dir
const srcHostJs = path.join(hostDir, 'host.js');
const dstHostJs = path.join(safeRuntimeDir, 'host.js');
fs.copyFileSync(srcHostJs, dstHostJs);

// Copy binaries (yt-dlp.exe, ffmpeg.exe if present) to pure-ASCII bin dir
const localBinDir = path.join(hostDir, 'bin');
if (fs.existsSync(localBinDir)) {
  for (const file of fs.readdirSync(localBinDir)) {
    const srcFile = path.join(localBinDir, file);
    const dstFile = path.join(safeBinDir, file);
    try {
      if (fs.statSync(srcFile).isFile()) {
        fs.copyFileSync(srcFile, dstFile);
      }
    } catch (_) {}
  }
}

// Also mirror extension/ into C:\Users\Public\DevilDownload\extension
function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const item of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, item.name);
    const d = path.join(dest, item.name);
    if (item.isDirectory()) {
      copyDirRecursive(s, d);
    } else if (item.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}
try {
  copyDirRecursive(extDir, safeExtDir);
  // Also keep legacy C:\Users\Public\DevilDownload\extension synced if present on this machine
  const legacyDir = path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'DevilDownload');
  if (fs.existsSync(legacyDir)) {
    copyDirRecursive(extDir, path.join(legacyDir, 'extension'));
    fs.copyFileSync(srcHostJs, path.join(legacyDir, 'host.js'));
  }
} catch (_) {}

// Write bootstrap.js that auto-syncs host.js from source folder (if newer) and runs from pure-ASCII dstHostJs
const bootstrapJsPath = path.join(safeRuntimeDir, 'bootstrap.js');
const bootstrapCode = `const fs = require('fs');
const src = ${JSON.stringify(srcHostJs)};
const dst = ${JSON.stringify(dstHostJs)};
try {
  if (fs.existsSync(src)) {
    const sStat = fs.statSync(src);
    const dStat = fs.existsSync(dst) ? fs.statSync(dst) : null;
    if (!dStat || sStat.mtimeMs > dStat.mtimeMs || sStat.size !== dStat.size) {
      fs.copyFileSync(src, dst);
    }
  }
} catch (_) {}
require(dst);
`;
fs.writeFileSync(bootstrapJsPath, bootstrapCode, 'utf8');

const hostBatPath = path.join(safeRuntimeDir, 'host_launcher.bat');
const nodeExe = process.execPath;
fs.writeFileSync(
  hostBatPath,
  `@echo off\r\n"${nodeExe}" "${bootstrapJsPath}" %*\r\n`,
  'utf8'
);

// Also keep local host_launcher.bat valid
fs.writeFileSync(
  path.join(hostDir, 'host_launcher.bat'),
  `@echo off\r\n"${nodeExe}" "${bootstrapJsPath}" %*\r\n`,
  'utf8'
);

const allowedOrigins = [`chrome-extension://${keyData.extId}/`];
if (customId && customId !== keyData.extId) {
  allowedOrigins.push(`chrome-extension://${customId}/`);
}

const hostManifestName = 'com.vibecoding.videoclipper';
const hostManifestPath = path.join(safeRuntimeDir, `${hostManifestName}.json`);
const hostManifest = {
  name: hostManifestName,
  description: 'Local yt-dlp + ffmpeg helper for HellDownloader',
  path: hostBatPath,
  type: 'stdio',
  allowed_origins: allowedOrigins
};
fs.writeFileSync(hostManifestPath, JSON.stringify(hostManifest, null, 2), 'utf8');
fs.writeFileSync(path.join(hostDir, `${hostManifestName}.json`), JSON.stringify(hostManifest, null, 2), 'utf8');

// 4. Register in Windows Registry for Chrome, Edge, Brave, Chromium, Yandex Browser, Opera, Opera GX, Vivaldi
const regKeys = [
  `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostManifestName}`,
  `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${hostManifestName}`,
  `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${hostManifestName}`,
  `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${hostManifestName}`,
  `HKCU\\Software\\Yandex\\YandexBrowser\\NativeMessagingHosts\\${hostManifestName}`,
  `HKCU\\Software\\Opera Software\\NativeMessagingHosts\\${hostManifestName}`,
  `HKCU\\Software\\Vivaldi\\NativeMessagingHosts\\${hostManifestName}`
];

for (const rk of regKeys) {
  try {
    execFileSync('reg.exe', ['add', rk, '/ve', '/t', 'REG_SZ', '/d', hostManifestPath, '/f'], { stdio: 'ignore' });
  } catch (_) {}
}

console.log('============================================================');
console.log('  HellDownloader — Installed Successfully!');
console.log('============================================================');
console.log('  Extension ID:      ', keyData.extId);
console.log('  Runtime Folder:    ', safeRuntimeDir);
console.log('  Extension Folder:  ', safeExtDir);
console.log('------------------------------------------------------------');
console.log('  How to add to Chrome / Edge / Brave:');
console.log('  1. Open chrome://extensions/');
console.log('  2. Enable "Developer mode" (top right)');
console.log('  3. Click "Load unpacked" and select:');
console.log('     ' + safeExtDir);
console.log('     (or the "extension" folder inside this directory)');
console.log('============================================================');
