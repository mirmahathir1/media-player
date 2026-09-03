const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { promisify } = require('util');

const vendor = require('./scripts/vendor');

const execFileAsync = promisify(execFile);

// ffmpeg, ffprobe, VLC and WebTorrent are kept inside the project so no
// install on the machine is needed. In development that folder sits next to
// this file; a packaged build carries it in its resources instead.
const VENDOR_ROOT = app.isPackaged ? process.resourcesPath : __dirname;
const VENDOR = vendor.vendorPaths(VENDOR_ROOT);

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

const NAME_SORT = { numeric: true, sensitivity: 'base' };
const compareNames = (a, b) => a.localeCompare(b, undefined, NAME_SORT);

// A GUI-launched app does not inherit a shell PATH, so look in the usual
// Homebrew locations as well. The downloaded copies come first, since those
// are the only ones this app can vouch for.
const FFMPEG_CANDIDATES = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

// Thumbnails: how deep to hunt for a folder's first video, and how many
// ffmpeg runs may work at once.
// Subtitle files VLC picks up when they sit beside a video under its name.
const SUBTITLE_EXTENSIONS = ['.srt', '.ass', '.ssa', '.sub', '.vtt', '.smi', '.sbv'];

const VIDEO_SEARCH_DEPTH = 5;
const MAX_THUMBNAIL_JOBS = 2;

let settingsFile;
let thumbnailDir;
let baseUrls = { ...DEFAULT_BASE_URLS };
let libraryPath = '';
let ffmpegTools = null;
let vlcPath = '';
let missingDependencies = [];
let installing = null;

// Nothing this app does works without its outside tools, so every entry point
// stays shut until they are all present.
const isBlocked = () => missingDependencies.length > 0;

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

// The gallery may only ever reach inside the folder the user picked.
function insideLibrary(target) {
  if (!libraryPath || typeof target !== 'string') return '';
  const root = path.resolve(libraryPath);
  const resolved = path.resolve(target);
  const allowed = resolved === root || resolved.startsWith(root + path.sep);
  return allowed ? resolved : '';
}

// --- Resume positions ----------------------------------------------------
// VLC records where playback stopped in its own preferences, but it drops a
// video from that list the moment it plays to the end, and the list only holds
// the last few dozen items. Either would blank a bar the user has earned, so
// VLC is treated as a live feed and the app keeps its own durable copy.

const VLC_DOMAIN = 'org.videolan.vlc';
const POSITIONS_TTL = 2000;
// A launched video VLC no longer remembers is only called finished once VLC
// has quit, so a movie still playing does not read as watched.
const WATCHED_LIMIT = 5000;
const MAX_QUEUES = 20;
// How much of a video must have run, with nothing kept by VLC, to call it done,
// and the least time on screen that may count — a video resumed a minute from
// the end still has to have been watched, not just opened.
const FINISHED_RATIO = 0.85;
const MIN_PLAYED = 30;

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
  await absorbPositions(positions);
  return positions;
}

// --- Watched store -------------------------------------------------------
// One record per video the app has seen played: where it stopped, or that it
// ran to the end. Nothing here is ever cleared by VLC forgetting a file.

let progressFile;
let watched = new Map();
// Playlists handed to VLC, so a video it has forgotten can be read as either
// "finished, the queue moved past it" or "never reached".
let queues = [];
let saveTimer = null;

function loadWatched() {
  try {
    const data = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
    watched = new Map(Object.entries(data.videos || {}));
    queues = Array.isArray(data.queues) ? data.queues : [];
  } catch {
    watched = new Map();
    queues = [];
  }
}

function saveWatched() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const data = { videos: Object.fromEntries(watched), queues };
    await fsp.writeFile(progressFile, JSON.stringify(data)).catch(() => {});
  }, 500);
  saveTimer.unref();
}

function remember(target, record) {
  watched.delete(target);
  watched.set(target, record);
  // Map order is insertion order, so the stalest records fall off the front.
  while (watched.size > WATCHED_LIMIT) watched.delete(watched.keys().next().value);
}

async function isVlcRunning() {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-x', process.platform === 'darwin' ? 'VLC' : 'vlc']);
    return stdout.trim().length > 0;
  } catch {
    // pgrep exits non-zero when nothing matches.
    return false;
  }
}

// Fold what VLC currently remembers into the store, then work out which
// forgotten videos were forgotten because they finished.
async function absorbPositions(positions) {
  let changed = false;

  for (const [target, seconds] of positions) {
    const record = watched.get(target);
    if (record && record.seconds === seconds && !record.finished && !record.superseded) continue;
    // A live resume point outranks every guess: this video is part-watched, and
    // whatever was observed on an earlier pass is stale.
    remember(target, { seconds, finished: false, played: 0 });
    changed = true;
  }

  // VLC playing on past a video is how it says that video ran out.
  for (const [target, record] of watched) {
    if (!record.superseded || positions.has(target)) continue;
    remember(target, { ...record, finished: true, superseded: false });
    changed = true;
  }

  const vlcRunning = await isVlcRunning();

  for (const queue of queues) {
    // The furthest item VLC has ever held a position for: everything before it
    // in the queue was played through.
    let seen = typeof queue.maxSeen === 'number' ? queue.maxSeen : -1;
    for (let i = queue.paths.length - 1; i > seen; i -= 1) {
      if (positions.has(queue.paths[i])) {
        seen = i;
        break;
      }
    }

    if (seen !== queue.maxSeen) {
      queue.maxSeen = seen;
      changed = true;
    }

    // Items the queue has moved past are certainly finished. The furthest one
    // is not: VLC may simply have pushed it out of its capped list, and a
    // half-watched video wrongly shown as done is worse than a stale bar.
    // A queue of one is the exception — nothing can have moved past it, so
    // once VLC has quit without a resume point, it played to the end. This is
    // the guess made when the app was closed during playback; if the watcher
    // was up, how long the video actually ran decides instead.
    const lonely = queue.paths.length === 1 && !vlcRunning && !watched.get(queue.paths[0])?.played;
    const limit = lonely ? 0 : seen - 1;

    for (let i = 0; i <= limit; i += 1) {
      const target = queue.paths[i];
      if (positions.has(target)) continue;

      const record = watched.get(target);
      if (record && record.finished) continue;
      remember(target, { ...record, seconds: record ? record.seconds : 0, finished: true });
      changed = true;
    }
  }

  if (changed) saveWatched();
}

// --- Playback watch ------------------------------------------------------
// VLC only writes a resume point when it stops part-way through a video, and
// not even then if barely any of it played, so its preferences alone cannot
// say what was watched. Asking the running VLC which file it holds open fills
// that in: the video it moves on from ran to the end, and time spent open
// says whether the last one did.

const WATCH_INTERVAL = 10000;
const VLC_PROCESS = process.platform === 'darwin' ? 'VLC' : 'vlc';

let watchTimer = null;
// Videos VLC has open right now, and when each was last seen.
let openVideos = new Map();

// The video files a running VLC has open, or null when VLC is not running.
async function openVlcVideos() {
  let pids;
  try {
    const { stdout } = await execFileAsync('pgrep', ['-x', VLC_PROCESS]);
    pids = stdout.trim().split('\n').filter(Boolean);
  } catch {
    return null;
  }

  const open = new Set();
  for (const pid of pids) {
    try {
      const { stdout } = await execFileAsync('lsof', ['-p', pid, '-Fn'], { maxBuffer: 16 * 1024 * 1024 });
      for (const line of stdout.split('\n')) {
        // -Fn prints one field per line; the name field is `n` then the path.
        if (line[0] !== 'n' || line[1] !== '/') continue;
        const file = line.slice(1);
        if (isVideoFile(file)) open.add(path.resolve(file));
      }
    } catch {
      // VLC quit between the two calls.
    }
  }

  return open;
}

async function pollPlayback() {
  const open = await openVlcVideos();
  const now = Date.now();

  if (!open) {
    if (!openVideos.size) return;
    // VLC has quit: it has just written its resume points, so read them now
    // rather than waiting for the window to be focused.
    openVideos.clear();
    await refreshProgressBars();
    return;
  }

  let changed = false;

  for (const target of open) {
    const since = openVideos.get(target);
    openVideos.set(target, now);
    if (!since) continue;

    const record = watched.get(target) || { seconds: 0, finished: false, played: 0 };
    remember(target, { ...record, played: (record.played || 0) + (now - since) / 1000 });
    changed = true;
  }

  for (const target of [...openVideos.keys()]) {
    if (open.has(target)) continue;
    openVideos.delete(target);

    // Closed while another video is open: VLC moved on, so this one ran out.
    // Whether VLC kept a resume point decides it, on the next read.
    const record = watched.get(target);
    if (!open.size || (record && record.finished)) continue;
    remember(target, { seconds: 0, played: 0, ...record, superseded: true });
    changed = true;
  }

  if (changed) {
    saveWatched();
    await refreshProgressBars();
  }
}

// Re-read VLC's side and let every open gallery redraw its bars.
async function refreshProgressBars() {
  vlcPositionsReadAt = 0;
  await readVlcPositions();
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('library-progress-changed');
  }
}

function startPlaybackWatch() {
  if (watchTimer) return;
  watchTimer = setInterval(() => { pollPlayback().catch(() => {}); }, WATCH_INTERVAL);
}

// Remembered so the bars can tell a finished video from one never reached.
function rememberQueue(paths) {
  queues = queues.filter((queue) => queue.paths[0] !== paths[0]);
  queues.push({ paths, maxSeen: -1, at: Date.now() });
  while (queues.length > MAX_QUEUES) queues.shift();
  saveWatched();
}

// --- Thumbnails ----------------------------------------------------------

// Resolve ffmpeg/ffprobe once; without them cards keep their emoji icon.
async function findFfmpegTools() {
  if (ffmpegTools) return ffmpegTools;

  for (const dir of [VENDOR.binDir, '', ...FFMPEG_CANDIDATES]) {
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

function libraryEntry(dir, dirent) {
  const isDirectory = dirent.isDirectory();
  const isVideo = !isDirectory && isVideoFile(dirent.name);
  return {
    name: dirent.name,
    path: path.join(dir, dirent.name),
    isDirectory,
    isVideo
  };
}

function sortLikeGallery(a, b) {
  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
  return compareNames(a.name, b.name);
}

async function readLibraryEntries(dir) {
  const dirents = await fsp.readdir(dir, { withFileTypes: true });
  return dirents
    .filter((dirent) => !dirent.name.startsWith('.'))
    .map((dirent) => libraryEntry(dir, dirent))
    .filter((entry) => entry.isDirectory || entry.isVideo)
    .sort(sortLikeGallery);
}

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
    .sort((a, b) => compareNames(a.name, b.name));

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

// How far into the video playback has reached, as a 0-1 fraction. Reading
// refreshes the store first, so a bar only ever moves forward.
async function progressFor(videoPath) {
  await readVlcPositions();

  const record = watched.get(path.resolve(videoPath));
  if (!record) return null;

  const duration = await durationFor(videoPath);
  if (!duration) return null;

  if (record.finished) return { seconds: duration, duration, ratio: 1, finished: true };

  // Nearly everything still unwatched has now run, and VLC kept no new resume
  // point: the video played out. Measuring against what was left, rather than
  // the whole runtime, catches a video picked up where it was left off.
  const left = Math.max(duration - (record.seconds || 0), 0);
  if (record.played >= Math.max(left * FINISHED_RATIO, MIN_PLAYED)) {
    remember(path.resolve(videoPath), { ...record, finished: true });
    saveWatched();
    return { seconds: duration, duration, ratio: 1, finished: true };
  }

  // Otherwise VLC's resume point is where the video stands.
  if (record.seconds) {
    return { seconds: record.seconds, duration, ratio: Math.min(record.seconds / duration, 1) };
  }

  return null;
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

  const bundles = [VENDOR.vlcApp, '/Applications/VLC.app', path.join(os.homedir(), 'Applications', 'VLC.app')];
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
  ffmpegTools = null;
  const { ffmpeg, ffprobe } = await findFfmpegTools();
  const vlc = await findVlc();
  vlcPath = vlc;

  // Unlike VLC, which the machine may already have somewhere, WebTorrent is
  // only ever the vendored copy: this app opens that bundle by path.
  const webtorrent = fs.existsSync(VENDOR.webtorrentApp);

  missingDependencies = [
    ffmpeg ? '' : 'ffmpeg',
    ffprobe ? '' : 'ffprobe',
    vlc ? '' : 'VLC',
    webtorrent ? '' : 'WebTorrent'
  ].filter(Boolean);

  return missingDependencies;
}

// Subtitle downloads land in the library root, next to the videos they belong
// to. A name already taken gets a numeric suffix rather than being overwritten.
function freeDownloadPath(dir, filename) {
  const safe = path.basename(filename || 'download').replace(/[/\\]/g, '_') || 'download';
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length) || 'download';

  let candidate = path.join(dir, safe);
  for (let n = 2; fs.existsSync(candidate); n += 1) candidate = path.join(dir, `${stem} (${n})${ext}`);
  return candidate;
}

// A download worth connecting to a video: the subtitle itself, or the zip
// subtitle sites wrap it in.
const isSubtitleDownload = (file) => {
  const ext = path.extname(file).toLowerCase();
  return ext === '.zip' || SUBTITLE_EXTENSIONS.includes(ext);
};

// Prefer .srt, and among equals the biggest file — multi-part archives keep
// their largest track for the feature, with the rest being samples or notes.
function pickSubtitle(files) {
  const ranked = files
    .map((file) => ({ ...file, rank: SUBTITLE_EXTENSIONS.indexOf(path.extname(file.name).toLowerCase()) }))
    .filter((file) => file.rank >= 0)
    .sort((a, b) => (a.rank === b.rank ? b.size - a.size : a.rank - b.rank));

  return ranked[0] || null;
}

// Moves across a device boundary, which a plain rename cannot do: the archive
// is unpacked in the system temp folder, the library may be another disk.
async function moveFile(from, to) {
  try {
    await fsp.rename(from, to);
  } catch {
    await fsp.copyFile(from, to);
    await fsp.unlink(from);
  }
}

// Unpack the archive, keep only its subtitle under the video's own name, and
// clear away the archive and everything else that came with it.
async function attachSubtitle(archivePath, videoPath) {
  const target = `${videoPath.slice(0, videoPath.length - path.extname(videoPath).length)}`;

  if (path.extname(archivePath).toLowerCase() !== '.zip') {
    const subtitle = `${target}${path.extname(archivePath).toLowerCase()}`;
    await moveFile(archivePath, subtitle);
    return subtitle;
  }

  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'subtitle-'));
  try {
    // -j flattens the archive's own folders, so every file lands in one place.
    await execFileAsync('unzip', ['-o', '-j', '-q', archivePath, '-d', workDir]);

    const names = await fsp.readdir(workDir);
    const files = await Promise.all(names.map(async (name) => ({
      name,
      size: await fsp.stat(path.join(workDir, name)).then((stat) => stat.size, () => 0)
    })));

    const chosen = pickSubtitle(files);
    if (!chosen) throw new Error('the archive holds no subtitle file');

    const subtitle = `${target}${path.extname(chosen.name).toLowerCase()}`;
    await moveFile(path.join(workDir, chosen.name), subtitle);
    await fsp.rm(archivePath, { force: true });
    return subtitle;
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true });
  }
}

// --- Torrents ------------------------------------------------------------
// A magnet link is not a page, so Chromium has nowhere to send it and the
// click goes nowhere. Every route one can arrive by is caught instead and
// handed to WebTorrent Desktop, the copy kept under `vendor`, exactly as a
// video is handed to the VLC kept beside it. Downloading, and everything
// shown about it, is then that app's business rather than this one's.

const isMagnet = (value) => typeof value === 'string' && value.startsWith('magnet:');

const sendAll = (channel, payload) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
};

const torrentStatus = (text, failed) => sendAll('download-status', { text, failed });

// WebTorrent keeps its settings in one file under Application Support, named
// after the app rather than after any one copy of it. The vendored copy reads
// the same file as one installed on the machine would, so this rewrites the
// one setting that matters here and leaves every other one alone.
const WEBTORRENT_CONFIG = path.join(
  os.homedir(), 'Library', 'Application Support', 'WebTorrent', 'config.json'
);

const isWebtorrentRunning = () => execFileAsync('pgrep', ['-x', 'WebTorrent']).then(() => true, () => false);

// Points WebTorrent at the library folder, so what it downloads lands where
// the gallery looks. A running copy holds its settings in memory and writes
// them out when it quits, which would undo this, so it is left alone then —
// by that point an earlier launch has already set the folder.
async function pointWebtorrentAtLibrary() {
  if (await isWebtorrentRunning()) return;

  let config = {};
  try {
    config = JSON.parse(await fsp.readFile(WEBTORRENT_CONFIG, 'utf8'));
  } catch {
    // No settings yet: WebTorrent has never run, so this writes the first ones.
  }

  const prefs = { ...config.prefs };
  if (prefs.downloadPath === libraryPath) return;

  prefs.downloadPath = libraryPath;
  await fsp.mkdir(path.dirname(WEBTORRENT_CONFIG), { recursive: true });
  await fsp.writeFile(WEBTORRENT_CONFIG, JSON.stringify({ ...config, prefs }, null, 2));
}

async function addMagnet(magnetURI) {
  if (isBlocked()) return { ok: false, reason: 'blocked' };
  if (!isMagnet(magnetURI)) return { ok: false, reason: 'not-a-magnet' };

  if (!libraryPath) {
    torrentStatus('Pick a library folder before downloading.', true);
    return { ok: false, reason: 'no-library' };
  }

  if (!fs.existsSync(VENDOR.webtorrentApp)) {
    torrentStatus('WebTorrent is not installed in the app’s vendor folder.', true);
    return { ok: false, reason: 'webtorrent-missing' };
  }

  try {
    await pointWebtorrentAtLibrary();
  } catch (error) {
    // Worth going on for: the download still runs, just into whatever folder
    // WebTorrent already had, so the gallery is what misses out.
    torrentStatus(`Could not point WebTorrent at the library folder: ${error.message}`, true);
  }

  // `open` hands the link to the bundle and returns; the download belongs to
  // that app from here, and outlives this one.
  try {
    await execFileAsync('open', ['-a', VENDOR.webtorrentApp, magnetURI]);
  } catch (error) {
    torrentStatus(`Could not start WebTorrent: ${error.message}`, true);
    return { ok: false, reason: 'webtorrent-failed', message: error.message };
  }

  torrentStatus('Opened in WebTorrent, which downloads into the library folder.');
  return { ok: true };
}

ipcMain.handle('add-magnet', (event, magnetURI) => addMagnet(magnetURI));

// WebTorrent downloads in its own window and tells this app nothing, so a
// finished download is noticed rather than announced: coming back to this
// window is the moment to look, and a new folder in the library is the sign.
let libraryStamp = 0;

async function refreshLibraryIfChanged(win) {
  if (!libraryPath) return;

  try {
    const { mtimeMs } = await fsp.stat(libraryPath);
    if (mtimeMs === libraryStamp) return;

    // The first look only records where the folder stood, so opening the app
    // does not redraw a gallery that has not changed.
    const known = libraryStamp !== 0;
    libraryStamp = mtimeMs;
    if (known && !win.isDestroyed()) win.webContents.send('library-changed');
  } catch {
    // The library folder has been moved or unplugged; the gallery says so.
  }
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

  // Every site is browsed in the window itself, sign-in flows on other domains
  // included; a link meant for a new tab simply takes the window with it.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isMagnet(url)) addMagnet(url);
    else win.loadURL(url);
    return { action: 'deny' };
  });

  // Torrent sites reach a magnet either by a plain link or by setting the
  // location from a script. Both land here as a navigation Chromium cannot
  // carry out, so it is stopped and the link goes to WebTorrent instead.
  win.webContents.on('will-navigate', (event, url) => {
    if (!isMagnet(url)) return;
    event.preventDefault();
    addMagnet(url);
  });

  win.on('focus', () => {
    win.webContents.send('library-progress-changed');
    refreshLibraryIfChanged(win);
  });

  // Subtitle sites hand the file over through an ad interstitial, which leaves
  // the window on a blank page once the download takes over. Save the file into
  // the library and step back to the page the download was started from.
  win.webContents.session.on('will-download', (event, item) => {
    const status = (text, failed) => win.webContents.send('download-status', { text, failed });

    if (!libraryPath) {
      item.cancel();
      status('Pick a library folder before downloading.', true);
      return;
    }

    const target = freeDownloadPath(libraryPath, item.getFilename());
    item.setSavePath(target);
    status(`Downloading ${path.basename(target)}…`);

    // Clicking the link navigates to the file itself, which commits and then
    // hands off to the download, leaving an empty page behind. Only that case
    // needs undoing: a download that left the page alone is not in the chain.
    const chain = item.getURLChain();
    const history = win.webContents.navigationHistory;
    if (chain.includes(win.webContents.getURL()) && history && history.canGoBack()) {
      setImmediate(() => history.goBack());
    }

    item.once('done', (doneEvent, state) => {
      if (state !== 'completed') {
        status(`Download ${state} (${path.basename(target)}).`, true);
        return;
      }

      status(`Saved ${path.basename(target)} to the library folder.`);
      // Subtitles are only useful once they sit beside their video under its
      // name, so the window asks which video this one belongs to.
      if (isSubtitleDownload(target)) {
        win.webContents.send('subtitle-downloaded', { archive: target, name: path.basename(target) });
      }
    });
  });

}

// English-only filter for OpenSubtitles. The site accepts it either as a query
// parameter or as a path segment, so it is matched to the base URL's shape —
// appending the path form to a query-style base makes the site ignore it.
const subtitleSuffix = (base) => (base.includes('?') ? '&SubLanguageID=eng' : '/sublanguageid-eng');

// Replace the current page with a search built from the title.
function runSearch(event, key, query) {
  if (isBlocked() || typeof query !== 'string' || !baseUrls[key]) return;

  // Strip everything that isn't alphanumeric; runs of other characters
  // collapse into a single space so words stay separated.
  const term = query.replace(/[^a-zA-Z0-9]+/g, ' ').trim().slice(0, 300).trim();
  if (!term) return;

  const suffix = key === 'subtitle' ? subtitleSuffix(baseUrls[key]) : '';
  event.sender.loadURL(`${baseUrls[key]}${encodeURIComponent(term)}${suffix}`);
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

// Fetch whatever is missing into `vendor`. The blocked page asks for this as
// soon as it opens, and watches 'dependency-progress' while it runs. A second
// window asking mid-download joins the run already going rather than starting
// its own.
ipcMain.handle('install-dependencies', async (event) => {
  if (!installing) {
    const report = (info) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('dependency-progress', info);
      }
    };

    installing = vendor.ensureVendorTools(VENDOR_ROOT, report)
      .then(async (result) => ({ ...result, missing: await checkDependencies() }))
      .catch((error) => ({ installed: [], failures: [{ name: 'setup', message: error.message }], missing: missingDependencies }))
      .finally(() => { installing = null; });
  }

  const result = await installing;
  if (!result.missing.length && !event.sender.isDestroyed()) event.sender.loadURL(HOME_URL);
  return result;
});

ipcMain.handle('set-base-url', (event, key, value) => {
  if (isBlocked()) return { ok: false, reason: 'blocked', baseUrls };

  const url = normalizeUrl(value);
  if (!url || !(key in baseUrls)) return { ok: false, baseUrls };

  baseUrls[key] = url;
  saveSettings();
  return { ok: true, baseUrls };
});

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
ipcMain.handle('attach-subtitle', async (event, archivePath, videoPath) => {
  if (isBlocked()) return { ok: false, reason: 'blocked' };
  if (!libraryPath) return { ok: false, reason: 'no-library' };

  const archive = insideLibrary(archivePath);
  const video = insideLibrary(videoPath);
  if (!archive || !video) return { ok: false, reason: 'outside-library' };
  if (!isVideoFile(video)) return { ok: false, reason: 'not-a-video' };

  try {
    const subtitle = await attachSubtitle(archive, video);
    return { ok: true, subtitle: path.basename(subtitle) };
  } catch (error) {
    return { ok: false, reason: 'failed', message: error.message };
  }
});

ipcMain.handle('read-library-dir', async (event, dirPath) => {
  if (isBlocked()) return { ok: false, reason: 'blocked' };
  if (!libraryPath) return { ok: false, reason: 'no-library' };

  const target = insideLibrary(dirPath || libraryPath);
  if (!target) return { ok: false, reason: 'outside-library' };

  let entries;
  try {
    entries = await readLibraryEntries(target);
  } catch (error) {
    return { ok: false, reason: 'unreadable', message: error.message };
  }

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

// How many videos may follow the clicked one into VLC's playlist.
const MAX_QUEUE = 100;
const VLC_SEQUENCE_OPTIONS = ['--no-random', '--no-loop', '--no-repeat', '--playlist-autostart'];

// Everything after the clicked video in its own folder, in the order the
// gallery shows it. VLC plays the list straight through, so finishing one
// video rolls on to the next by itself.
function queueFromVisibleEntries(videoPath, visibleEntries) {
  if (!Array.isArray(visibleEntries)) return [];

  const folder = path.dirname(videoPath);
  const siblings = [];

  for (const entry of visibleEntries) {
    if (!entry || entry.isDirectory) continue;

    const target = insideLibrary(entry.path);
    if (!target || path.dirname(target) !== folder || !isVideoFile(target)) continue;

    siblings.push(target);
  }

  const start = siblings.indexOf(videoPath);
  return start === -1 ? [] : siblings.slice(start, start + MAX_QUEUE);
}

async function queueFrom(videoPath, visibleEntries) {
  const visibleQueue = queueFromVisibleEntries(videoPath, visibleEntries);
  if (visibleQueue.length) return visibleQueue;

  let entries;
  try {
    entries = await readLibraryEntries(path.dirname(videoPath));
  } catch {
    return [videoPath];
  }

  const siblings = entries
    .filter((entry) => entry.isVideo)
    .map((entry) => entry.path);

  const start = siblings.indexOf(videoPath);
  // A file that vanished between listing and click still plays on its own.
  if (start === -1) return [videoPath];

  return siblings.slice(start, start + MAX_QUEUE);
}

async function vlcPlaylistFor(queue) {
  if (queue.length === 1) return queue[0];

  const playlistDir = path.join(app.getPath('userData'), 'playlists');
  await fsp.mkdir(playlistDir, { recursive: true });

  const playlist = path.join(playlistDir, 'autoplay.m3u8');
  const body = ['#EXTM3U', ...queue.map((videoPath) => pathToFileURL(videoPath).href)].join('\n') + '\n';
  await fsp.writeFile(playlist, body, 'utf8');
  return playlist;
}

function vlcExecutable(player) {
  if (process.platform !== 'darwin') return player || 'vlc';
  if (!player) return '';

  const executable = player.endsWith('.app')
    ? path.join(player, 'Contents', 'MacOS', 'VLC')
    : player;

  return fs.existsSync(executable) ? executable : '';
}

function launchDetached(command, args) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore' });
      child.once('error', (error) => finish({ ok: false, error }));
      child.once('spawn', () => {
        child.unref();
        finish({ ok: true });
      });
    } catch (error) {
      finish({ ok: false, error });
    }
  });
}

async function launchVlc(player, playlist) {
  const executable = vlcExecutable(player);
  if (executable) {
    return launchDetached(executable, [...VLC_SEQUENCE_OPTIONS, playlist]);
  }

  if (process.platform === 'darwin') {
    return new Promise((resolve) => {
      execFile('open', ['-a', player || 'VLC', playlist, '--args', ...VLC_SEQUENCE_OPTIONS], (error) => {
        resolve(error ? { ok: false, error } : { ok: true });
      });
    });
  }

  return launchDetached(player || 'vlc', [...VLC_SEQUENCE_OPTIONS, playlist]);
}

// Hand the file, and the rest of its folder, to the VLC installed here.
ipcMain.handle('open-in-vlc', async (event, filePath, visibleEntries) => {
  if (isBlocked()) return { ok: false, reason: 'blocked' };

  const target = insideLibrary(filePath);
  if (!target || !VIDEO_EXTENSIONS.has(path.extname(target).toLowerCase())) {
    return { ok: false, reason: 'not-a-library-video' };
  }

  const queue = await queueFrom(target, visibleEntries);
  rememberQueue(queue);
  setTimeout(() => { pollPlayback().catch(() => {}); }, 4000);

  // Launch the copy that was actually found: the downloaded bundle when there
  // is one, and only otherwise whatever the machine happens to have.
  const player = vlcPath || await findVlc();
  let playlist;
  try {
    playlist = await vlcPlaylistFor(queue);
  } catch (error) {
    return { ok: false, reason: 'playlist-failed', message: error.message };
  }

  // `open` reports a missing app on stderr; elsewhere the binary itself is absent.
  const isMissing = (error) => error.code === 'ENOENT' || /unable to find application/i.test(error.message);

  const launched = await launchVlc(player, playlist);
  if (launched.ok) return { ok: true };

  if (isMissing(launched.error)) {
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

    return { ok: false, reason: 'vlc-missing' };
  }

  return { ok: false, reason: 'vlc-failed', message: launched.error.message };
});

// Caches keyed by path outlive the file, so drop anything under a deleted
// entry before the gallery asks about it again.
function forgetCached(target) {
  const prefix = target + path.sep;
  const isGone = (value) => value === target || value.startsWith(prefix);

  for (const key of durationCache.keys()) {
    if (isGone(key)) durationCache.delete(key);
  }
  for (const [key, videoPath] of folderVideoCache) {
    if (isGone(key) || (videoPath && isGone(videoPath))) folderVideoCache.delete(key);
  }
  for (const key of watched.keys()) {
    if (isGone(key)) watched.delete(key);
  }
  queues = queues.filter((queue) => !queue.paths.some(isGone));
  saveWatched();
}

// Deleting is the one destructive thing the gallery can do, so it asks first
// and then goes to the Trash rather than unlinking outright.
ipcMain.handle('delete-library-entry', async (event, entryPath) => {
  if (isBlocked()) return { ok: false, reason: 'blocked' };

  const target = insideLibrary(entryPath);
  if (!target) return { ok: false, reason: 'outside-library' };
  if (target === path.resolve(libraryPath)) return { ok: false, reason: 'is-library-root' };

  let isDirectory;
  try {
    isDirectory = (await fsp.stat(target)).isDirectory();
  } catch (error) {
    return { ok: false, reason: 'unreadable', message: error.message };
  }

  const win = BrowserWindow.fromWebContents(event.sender);
  const options = {
    type: 'warning',
    title: 'Move to Trash',
    message: `Move "${path.basename(target)}" to the Trash?`,
    detail: isDirectory
      ? `The folder and everything inside it goes to the Trash:\n${target}`
      : target,
    buttons: ['Move to Trash', 'Cancel'],
    defaultId: 1,
    cancelId: 1
  };

  const { response } = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options);
  if (response !== 0) return { ok: false, reason: 'canceled' };

  try {
    await shell.trashItem(target);
  } catch (error) {
    return { ok: false, reason: 'delete-failed', message: error.message };
  }

  forgetCached(target);
  return { ok: true };
});

app.whenReady().then(async () => {
  loadSettings();
  progressFile = path.join(app.getPath('userData'), 'progress.json');
  loadWatched();
  thumbnailDir = path.join(app.getPath('userData'), 'thumbnails');
  fs.mkdirSync(thumbnailDir, { recursive: true });
  await checkDependencies();
  createWindow();
  startPlaybackWatch();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
