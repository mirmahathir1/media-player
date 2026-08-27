const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const HOME_URL = 'https://www.imdb.com';
const GALLERY_FILE = path.join(__dirname, 'gallery.html');
const BLOCKED_FILE = path.join(__dirname, 'blocked.html');

// The bottom-bar buttons append the encoded title to these prefixes, so each
// one can be pointed at any search engine or subtitle site.
const DEFAULT_BASE_URLS = {
  inspect: 'https://www.google.com/search?q=',
  subtitle: 'https://www.opensubtitles.org/en/search2?MovieName='
};

const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.m4v', '.wmv', '.flv', '.webm',
  '.mpg', '.mpeg', '.ts', '.m2ts', '.ogv', '.3gp', '.divx', '.vob'
]);

// A GUI-launched app does not inherit a shell PATH, so look in the usual
// Homebrew locations as well.
const FFMPEG_CANDIDATES = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

// Thumbnails: how deep to hunt for a folder's first video, and how many
// ffmpeg runs may work at once.
const VIDEO_SEARCH_DEPTH = 5;
const MAX_THUMBNAIL_JOBS = 2;

let settingsFile;
let thumbnailDir;
let baseUrls = { ...DEFAULT_BASE_URLS };
let libraryPath = '';
let ffmpegTools = null;
let missingDependencies = [];

// Nothing this app does works without its outside tools, so every entry point
// stays shut until they are all present.
const isBlocked = () => missingDependencies.length > 0;

const hostnameOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

const normalizeUrl = (value) => {
  try {
    const url = new URL(String(value).trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
};

function loadSettings() {
  settingsFile = path.join(app.getPath('userData'), 'settings.json');

  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch {
    saved = {};
  }

  const savedUrls = saved.baseUrls || {};
  baseUrls = Object.fromEntries(
    Object.entries(DEFAULT_BASE_URLS).map(([key, fallback]) => [key, normalizeUrl(savedUrls[key]) || fallback])
  );
  libraryPath = typeof saved.libraryPath === 'string' ? saved.libraryPath : '';
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsFile, JSON.stringify({ baseUrls, libraryPath }, null, 2));
  } catch (error) {
    console.error('Could not save settings:', error);
  }
}

const isSameSite = (host, site) => {
  const base = site.replace(/^www\./, '');
  return Boolean(base) && (host === base || host.endsWith(`.${base}`));
};

// imdb.com and whatever sites the bottom-bar buttons point at stay in the app.
const isInternal = (url) => {
  const host = hostnameOf(url);
  if (!host) return false;
  if (isSameSite(host, 'imdb.com')) return true;
  return Object.values(baseUrls).some((base) => isSameSite(host, hostnameOf(base)));
};

// The gallery may only ever reach inside the folder the user picked.
function insideLibrary(target) {
  if (!libraryPath || typeof target !== 'string') return '';
  const root = path.resolve(libraryPath);
  const resolved = path.resolve(target);
  const allowed = resolved === root || resolved.startsWith(root + path.sep);
  return allowed ? resolved : '';
}

// --- Resume positions ----------------------------------------------------
// VLC records where playback stopped in its own preferences; that is what the
// progress bar under each thumbnail reflects.

const VLC_DOMAIN = 'org.videolan.vlc';
const POSITIONS_TTL = 2000;

const durationCache = new Map();
const folderVideoCache = new Map();

let vlcPositions = new Map();
let vlcPositionsReadAt = 0;

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const decodeXml = (value) => value.replace(/&(amp|lt|gt|quot|apos);/g, (match, name) => XML_ENTITIES[name]);

// `defaults export` goes through the preferences daemon, so it sees positions
// VLC has not flushed to disk yet, and it prints proper UTF-8 XML.
async function readVlcPositions() {
  if (Date.now() - vlcPositionsReadAt < POSITIONS_TTL) return vlcPositions;

  const positions = new Map();
  try {
    const { stdout } = await execFileAsync('defaults', ['export', VLC_DOMAIN, '-'], {
      maxBuffer: 16 * 1024 * 1024
    });

    const section = stdout.slice(stdout.indexOf('<key>recentlyPlayedMedia</key>'));
    const dict = section.slice(0, section.indexOf('</dict>'));
    const pairs = dict.matchAll(/<key>(file:\/\/[^<]*)<\/key>\s*<(?:integer|real)>([\d.]+)<\/(?:integer|real)>/g);

    for (const [, url, seconds] of pairs) {
      // VLC stores these unencoded, so the path is the URL minus its scheme.
      positions.set(path.resolve(decodeXml(url).slice('file://'.length)), Number.parseFloat(seconds));
    }
  } catch {
    // VLC has never run, or has no resume points yet.
  }

  vlcPositions = positions;
  vlcPositionsReadAt = Date.now();
  return positions;
}

// --- Thumbnails ----------------------------------------------------------

// Resolve ffmpeg/ffprobe once; without them cards keep their emoji icon.
async function findFfmpegTools() {
  if (ffmpegTools) return ffmpegTools;

  for (const dir of ['', ...FFMPEG_CANDIDATES]) {
    const ffmpeg = dir ? path.join(dir, 'ffmpeg') : 'ffmpeg';
    const ffprobe = dir ? path.join(dir, 'ffprobe') : 'ffprobe';
    try {
      await execFileAsync(ffmpeg, ['-version']);
      await execFileAsync(ffprobe, ['-version']);
      ffmpegTools = { ffmpeg, ffprobe };
      return ffmpegTools;
    } catch {
      // Try the next location.
    }
  }

  ffmpegTools = { ffmpeg: '', ffprobe: '' };
  return ffmpegTools;
}

const isVideoFile = (name) => VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase());

// Depth-first, name-ordered, so a folder always resolves to the same video.
async function findFirstVideo(dir, depth = VIDEO_SEARCH_DEPTH) {
  let dirents;
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return '';
  }

  const visible = dirents
    .filter((dirent) => !dirent.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

  const video = visible.find((dirent) => !dirent.isDirectory() && isVideoFile(dirent.name));
  if (video) return path.join(dir, video.name);
  if (depth <= 0) return '';

  for (const dirent of visible) {
    if (!dirent.isDirectory()) continue;
    const found = await findFirstVideo(path.join(dir, dirent.name), depth - 1);
    if (found) return found;
  }

  return '';
}

// Only a couple of ffmpeg runs at a time, so a big folder does not stall the app.
let runningJobs = 0;
const jobQueue = [];

function queueJob(job) {
  return new Promise((resolve) => {
    const run = async () => {
      runningJobs += 1;
      let result;
      try {
        result = await job();
      } catch (error) {
        result = { ok: false, reason: 'thumbnail-failed', message: error.message };
      }
      runningJobs -= 1;
      const next = jobQueue.shift();
      if (next) next();
      resolve(result);
    };

    if (runningJobs < MAX_THUMBNAIL_JOBS) run();
    else jobQueue.push(run);
  });
}

// Thumbnail and duration share one cache key, so both survive a restart.
async function cacheKeyFor(videoPath) {
  const stats = await fsp.stat(videoPath);
  return crypto
    .createHash('sha1')
    .update(`${videoPath}:${stats.size}:${stats.mtimeMs}`)
    .digest('hex');
}

async function probeDuration(ffprobe, videoPath) {
  try {
    const { stdout } = await execFileAsync(ffprobe, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1',
      videoPath
    ]);
    const duration = Number.parseFloat(stdout.trim());
    return Number.isFinite(duration) && duration > 0 ? duration : 0;
  } catch {
    return 0;
  }
}

// Runtime in seconds, remembered next to the thumbnail so the progress bar
// never has to re-probe a file.
async function durationFor(videoPath) {
  if (durationCache.has(videoPath)) return durationCache.get(videoPath);

  let key;
  try {
    key = await cacheKeyFor(videoPath);
  } catch {
    return 0;
  }

  const metaFile = path.join(thumbnailDir, `${key}.json`);
  let duration = 0;

  try {
    duration = JSON.parse(await fsp.readFile(metaFile, 'utf8')).duration || 0;
  } catch {
    const { ffprobe } = await findFfmpegTools();
    if (ffprobe) duration = await probeDuration(ffprobe, videoPath);
    if (duration) await fsp.writeFile(metaFile, JSON.stringify({ duration })).catch(() => {});
  }

  durationCache.set(videoPath, duration);
  return duration;
}

// How far into the video VLC was when it last quit, as a 0-1 fraction.
async function progressFor(videoPath) {
  const positions = await readVlcPositions();
  const seconds = positions.get(path.resolve(videoPath));
  if (!seconds) return null;

  const duration = await durationFor(videoPath);
  if (!duration) return null;

  return { seconds, duration, ratio: Math.min(seconds / duration, 1) };
}

// A folder is represented by the same video its thumbnail came from.
async function videoForEntry(entryPath, isDirectory) {
  if (!isDirectory) return entryPath;
  if (folderVideoCache.has(entryPath)) return folderVideoCache.get(entryPath);

  const videoPath = await findFirstVideo(entryPath);
  folderVideoCache.set(entryPath, videoPath);
  return videoPath;
}

// A frame from somewhere in the middle of the video, cached on disk so the
// same card keeps the same scene between visits.
async function buildThumbnail(videoPath) {
  const { ffmpeg } = await findFfmpegTools();
  if (!ffmpeg) return { ok: false, reason: 'no-ffmpeg' };

  let key;
  try {
    key = await cacheKeyFor(videoPath);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }

  const cacheFile = path.join(thumbnailDir, `${key}.jpg`);

  // A file:// page cannot load images from another directory, so the frame
  // travels to the gallery inline.
  const asDataUrl = async () => ({
    ok: true,
    thumbnail: `data:image/jpeg;base64,${(await fsp.readFile(cacheFile)).toString('base64')}`,
    video: videoPath
  });

  if (fs.existsSync(cacheFile)) return asDataUrl();

  const duration = await durationFor(videoPath);
  // Stay clear of titles and credits when the duration is known.
  const seek = duration ? duration * (0.1 + Math.random() * 0.8) : 5;

  try {
    await execFileAsync(ffmpeg, [
      '-nostdin',
      '-ss', seek.toFixed(2),
      '-i', videoPath,
      '-frames:v', '1',
      '-vf', 'scale=480:-2',
      '-q:v', '4',
      '-update', '1',
      '-y', cacheFile
    ]);
  } catch (error) {
    return { ok: false, reason: 'thumbnail-failed', message: error.message };
  }

  if (!fs.existsSync(cacheFile)) return { ok: false, reason: 'thumbnail-failed' };
  return asDataUrl();
}

// --- Requirements --------------------------------------------------------

async function findVlc() {
  if (process.platform !== 'darwin') {
    try {
      await execFileAsync('vlc', ['--version']);
      return 'vlc';
    } catch {
      return '';
    }
  }

  const bundles = ['/Applications/VLC.app', path.join(os.homedir(), 'Applications', 'VLC.app')];
  const installed = bundles.find((bundle) => fs.existsSync(bundle));
  if (installed) return installed;

  // Installed somewhere else: ask Launch Services rather than guessing.
  try {
    const { stdout } = await execFileAsync('osascript', ['-e', 'POSIX path of (path to application "VLC")']);
    return stdout.trim();
  } catch {
    return '';
  }
}

async function checkDependencies() {
  const { ffmpeg, ffprobe } = await findFfmpegTools();
  const vlc = await findVlc();

  missingDependencies = [
    ffmpeg ? '' : 'ffmpeg',
    ffprobe ? '' : 'ffprobe',
    vlc ? '' : 'VLC'
  ].filter(Boolean);

  return missingDependencies;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'IMDb',
    backgroundColor: '#121212',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  if (isBlocked()) win.loadFile(BLOCKED_FILE, { query: { missing: missingDependencies.join(',') } });
  else win.loadURL(HOME_URL);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternal(url)) {
      win.loadURL(url);
    } else {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  win.on('focus', () => win.webContents.send('library-progress-changed'));

  win.webContents.on('will-navigate', (event, url) => {
    if (!isInternal(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
}

// Replace the current page with a search built from the title.
function runSearch(event, key, query) {
  if (isBlocked() || typeof query !== 'string' || !baseUrls[key]) return;

  // Strip everything that isn't alphanumeric; runs of other characters
  // collapse into a single space so words stay separated.
  const term = query.replace(/[^a-zA-Z0-9]+/g, ' ').trim().slice(0, 300).trim();
  if (!term) return;

  event.sender.loadURL(`${baseUrls[key]}${encodeURIComponent(term)}`);
}

ipcMain.on('inspect-search', (event, query) => runSearch(event, 'inspect', query));
ipcMain.on('subtitle-search', (event, query) => runSearch(event, 'subtitle', query));

// Bottom-bar IMDb button: straight back to the site the app is built around.
ipcMain.on('open-home', (event) => {
  if (!isBlocked()) event.sender.loadURL(HOME_URL);
});

// Bottom-bar back button: step back in history, or fall back to the IMDb home page.
ipcMain.on('inspect-go-back', (event) => {
  if (isBlocked()) return;

  const contents = event.sender;
  const history = contents.navigationHistory;

  if (history && history.canGoBack()) {
    history.goBack();
  } else {
    contents.loadURL(HOME_URL);
  }
});

ipcMain.handle('get-base-urls', () => baseUrls);

// The blocked page's only action: look again, and start the app if the
// missing tools have since been installed.
ipcMain.handle('recheck-dependencies', async (event) => {
  const missing = await checkDependencies();
  if (!missing.length) event.sender.loadURL(HOME_URL);
  return missing;
});

ipcMain.handle('set-base-url', (event, key, value) => {
  if (isBlocked()) return { ok: false, reason: 'blocked', baseUrls };

  const url = normalizeUrl(value);
  if (!url || !(key in baseUrls)) return { ok: false, baseUrls };

  baseUrls[key] = url;
  saveSettings();
  return { ok: true, baseUrls };
});

ipcMain.handle('get-library-path', () => libraryPath);

ipcMain.handle('pick-library-folder', async (event) => {
  if (isBlocked()) return { ok: false, reason: 'blocked', libraryPath };

  const win = BrowserWindow.fromWebContents(event.sender);
  const options = { properties: ['openDirectory', 'createDirectory'], title: 'Choose library folder' };
  if (libraryPath) options.defaultPath = libraryPath;

  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);

  if (result.canceled || !result.filePaths.length) return { ok: false, libraryPath };

  libraryPath = result.filePaths[0];
  saveSettings();
  return { ok: true, libraryPath };
});

ipcMain.handle('open-local-gallery', (event) => {
  if (isBlocked()) return { ok: false, reason: 'blocked' };
  if (!libraryPath) return { ok: false, reason: 'no-library' };
  event.sender.loadFile(GALLERY_FILE);
  return { ok: true };
});

// Folders and video files inside the library, folders first.
ipcMain.handle('read-library-dir', async (event, dirPath) => {
  if (isBlocked()) return { ok: false, reason: 'blocked' };
  if (!libraryPath) return { ok: false, reason: 'no-library' };

  const target = insideLibrary(dirPath || libraryPath);
  if (!target) return { ok: false, reason: 'outside-library' };

  let dirents;
  try {
    dirents = await fsp.readdir(target, { withFileTypes: true });
  } catch (error) {
    return { ok: false, reason: 'unreadable', message: error.message };
  }

  const entries = dirents
    .filter((dirent) => !dirent.name.startsWith('.'))
    .map((dirent) => ({
      name: dirent.name,
      path: path.join(target, dirent.name),
      isDirectory: dirent.isDirectory(),
      isVideo: !dirent.isDirectory() && VIDEO_EXTENSIONS.has(path.extname(dirent.name).toLowerCase())
    }))
    .filter((entry) => entry.isDirectory || entry.isVideo)
    .sort((a, b) => (a.isDirectory === b.isDirectory
      ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      : a.isDirectory ? -1 : 1));

  const root = path.resolve(libraryPath);
  return {
    ok: true,
    path: target,
    root,
    parent: target === root ? '' : path.dirname(target),
    entries
  };
});

// One frame per card: the video itself, or a folder's first video.
ipcMain.handle('get-thumbnail', async (event, entryPath, isDirectory) => {
  if (isBlocked()) return { ok: false, reason: 'blocked' };

  const target = insideLibrary(entryPath);
  if (!target) return { ok: false, reason: 'outside-library' };

  return queueJob(async () => {
    const videoPath = await videoForEntry(target, isDirectory);
    if (!videoPath) return { ok: false, reason: 'no-video' };

    const result = await buildThumbnail(videoPath);
    if (!result.ok) return result;
    // Only a video has a resume point of its own; a folder just borrows a frame.
    return { ...result, progress: isDirectory ? null : await progressFor(videoPath) };
  });
});

// Refreshed on window focus, so a bar catches up right after VLC is quit.
ipcMain.handle('get-progress', async (event, entries) => {
  if (isBlocked() || !Array.isArray(entries)) return [];

  const results = [];
  for (const entry of entries) {
    if (!entry || entry.isDirectory) continue;

    const target = insideLibrary(entry.path);
    if (!target) continue;

    results.push({ path: entry.path, progress: await progressFor(target) });
  }

  return results;
});

// Hand the file to the VLC installed on this machine.
ipcMain.handle('open-in-vlc', (event, filePath) => {
  if (isBlocked()) return { ok: false, reason: 'blocked' };

  const target = insideLibrary(filePath);
  if (!target || !VIDEO_EXTENSIONS.has(path.extname(target).toLowerCase())) {
    return { ok: false, reason: 'not-a-library-video' };
  }

  const [command, args] = process.platform === 'darwin'
    ? ['open', ['-a', 'VLC', target]]
    : ['vlc', [target]];

  // `open` reports a missing app on stderr; elsewhere the binary itself is absent.
  const isMissing = (error) => error.code === 'ENOENT' || /unable to find application/i.test(error.message);

  return new Promise((resolve) => {
    execFile(command, args, (error) => {
      if (!error) {
        resolve({ ok: true });
        return;
      }

      if (isMissing(error)) {
        const win = BrowserWindow.fromWebContents(event.sender);
        const options = {
          type: 'error',
          title: 'VLC not found',
          message: 'VLC is not installed.',
          detail: 'Install VLC on this machine, then try playing the video again.',
          buttons: ['OK']
        };
        if (win) dialog.showMessageBox(win, options);
        else dialog.showMessageBox(options);

        resolve({ ok: false, reason: 'vlc-missing' });
        return;
      }

      resolve({ ok: false, reason: 'vlc-failed', message: error.message });
    });
  });
});

app.whenReady().then(async () => {
  loadSettings();
  thumbnailDir = path.join(app.getPath('userData'), 'thumbnails');
  fs.mkdirSync(thumbnailDir, { recursive: true });
  await checkDependencies();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
