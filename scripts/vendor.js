// Keeps ffmpeg, ffprobe and VLC inside the project instead of on the machine.
//
// Everything lands under `vendor/`, which main.js searches before the usual
// system locations. Nothing here needs Electron, so the same module runs from
// `npm run vendor` and from the app at startup.

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFile } = require('child_process');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// VLC is published per release with a checksum beside it, so the newest build
// in this folder is picked up rather than a version pinned here.
const VLC_INDEX = 'https://get.videolan.org/vlc/last/macosx/';

// ffmpeg comes from the release the ffmpeg-static package ships, pinned to a
// tag so the assets never move under us.
const FFMPEG_RELEASE = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1';

// Only the combinations that release actually carries.
const FFMPEG_TARGETS = new Set([
  'darwin-arm64', 'darwin-x64',
  'linux-arm', 'linux-arm64', 'linux-ia32', 'linux-x64',
  'win32-ia32', 'win32-x64'
]);

const exeName = (name) => (process.platform === 'win32' ? `${name}.exe` : name);

// Where each tool lives, given the folder that holds `vendor`. That folder is
// the project in development and the resources folder once packaged.
function vendorPaths(root) {
  const dir = path.join(root, 'vendor');
  const binDir = path.join(dir, 'bin');

  return {
    dir,
    binDir,
    tmpDir: path.join(dir, '.tmp'),
    vlcApp: path.join(dir, 'VLC.app'),
    ffmpeg: path.join(binDir, exeName('ffmpeg')),
    ffprobe: path.join(binDir, exeName('ffprobe'))
  };
}

// VLC is only downloadable as a ready-made bundle on macOS; elsewhere it stays
// the machine's job, and the app falls back to a system install.
const canFetchVlc = () => process.platform === 'darwin';
const canFetchFfmpeg = () => FFMPEG_TARGETS.has(`${process.platform}-${process.arch}`);

// What is still missing from `vendor`, in install order.
function missingVendorTools(root) {
  const paths = vendorPaths(root);
  const missing = [];

  if (!fs.existsSync(paths.ffmpeg)) missing.push('ffmpeg');
  if (!fs.existsSync(paths.ffprobe)) missing.push('ffprobe');
  if (!fs.existsSync(paths.vlcApp)) missing.push('VLC');

  return missing;
}

async function fetchOk(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return response;
}

// A stream that reports how much of the download has arrived. Some servers
// send no length, in which case the callback gets a total of 0 and the caller
// shows an indeterminate state.
function counter(total, onProgress) {
  let received = 0;

  return new Transform({
    transform(chunk, encoding, done) {
      received += chunk.length;
      onProgress(received, total);
      done(null, chunk);
    }
  });
}

// Downloads to `target`, optionally gunzipping on the way. Progress is
// reported at most a few times a second so an IPC channel is not flooded.
async function download(url, target, { gunzip = false, onProgress = () => {} } = {}) {
  const response = await fetchOk(url);
  const total = Number(response.headers.get('content-length')) || 0;

  let lastReport = 0;
  const report = (received) => {
    const now = Date.now();
    if (now - lastReport < 200 && received !== total) return;
    lastReport = now;
    onProgress(received, total);
  };

  await fsp.mkdir(path.dirname(target), { recursive: true });

  const stages = [Readable.fromWeb(response.body), counter(total, report)];
  if (gunzip) stages.push(zlib.createGunzip());
  stages.push(fs.createWriteStream(target));

  await pipeline(...stages);
  onProgress(total || 0, total);
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

// --- ffmpeg / ffprobe ----------------------------------------------------

async function installFfmpegTool(name, root, onProgress) {
  const paths = vendorPaths(root);
  const target = name === 'ffmpeg' ? paths.ffmpeg : paths.ffprobe;
  if (fs.existsSync(target)) return;

  if (!canFetchFfmpeg()) {
    throw new Error(`no ${name} build for ${process.platform}-${process.arch}`);
  }

  const asset = `${name}-${process.platform}-${process.arch}.gz`;
  const partial = `${target}.partial`;

  await fsp.rm(partial, { force: true });
  await download(`${FFMPEG_RELEASE}/${asset}`, partial, {
    gunzip: true,
    onProgress: (received, total) => onProgress({ name, phase: 'download', received, total })
  });
  await fsp.chmod(partial, 0o755);

  // A binary that cannot run is worse than a missing one, since the app would
  // then treat the tool as present.
  onProgress({ name, phase: 'verify' });
  try {
    await execFileAsync(partial, ['-version']);
  } catch (error) {
    await fsp.rm(partial, { force: true });
    throw new Error(`${name} downloaded but would not run: ${error.message}`);
  }

  await fsp.rename(partial, target);
}

// --- VLC -----------------------------------------------------------------

// The newest dmg in VideoLAN's folder for this architecture.
async function latestVlcDmg() {
  const suffix = process.arch === 'arm64' ? 'arm64' : 'intel64';
  const listing = await (await fetchOk(VLC_INDEX)).text();

  const pattern = new RegExp(`vlc-(\\d+(?:\\.\\d+)*)-${suffix}\\.dmg`, 'g');
  const found = new Map();
  for (const match of listing.matchAll(pattern)) found.set(match[0], match[1]);

  if (!found.size) throw new Error(`no VLC build for ${suffix} at ${VLC_INDEX}`);

  const rank = (version) => version.split('.').map(Number);
  const newer = (a, b) => {
    const [x, y] = [rank(a), rank(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
      if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
    }
    return false;
  };

  let best = '';
  for (const [file, version] of found) {
    if (!best || newer(version, found.get(best))) best = file;
  }
  return best;
}

// Copies VLC.app out of a mounted dmg. The mount point is our own folder so a
// disk image already attached by the user is never touched.
async function copyFromDmg(dmg, destination, tmpDir) {
  const mount = path.join(tmpDir, `mount-${process.pid}`);
  await fsp.mkdir(mount, { recursive: true });

  await execFileAsync('hdiutil', ['attach', dmg, '-nobrowse', '-readonly', '-mountpoint', mount]);
  try {
    const source = path.join(mount, 'VLC.app');
    if (!fs.existsSync(source)) throw new Error('the disk image holds no VLC.app');

    // `ditto` is the one copy that keeps the bundle's symlinks and signature
    // intact, which the app needs to launch without a Gatekeeper complaint.
    await fsp.rm(destination, { recursive: true, force: true });
    await execFileAsync('ditto', [source, destination]);
  } finally {
    await execFileAsync('hdiutil', ['detach', mount, '-force']).catch(() => {});
    await fsp.rm(mount, { recursive: true, force: true });
  }
}

async function installVlc(root, onProgress) {
  const paths = vendorPaths(root);
  if (fs.existsSync(paths.vlcApp)) return;
  if (!canFetchVlc()) throw new Error(`no VLC download for ${process.platform}`);

  onProgress({ name: 'VLC', phase: 'lookup' });
  const file = await latestVlcDmg();
  const dmg = path.join(paths.tmpDir, file);

  await fsp.mkdir(paths.tmpDir, { recursive: true });
  try {
    await download(`${VLC_INDEX}${file}`, dmg, {
      onProgress: (received, total) => onProgress({ name: 'VLC', phase: 'download', received, total })
    });

    // VideoLAN publishes a checksum beside every build, so a download that was
    // cut short or tampered with never reaches the app folder.
    onProgress({ name: 'VLC', phase: 'verify' });
    const published = await (await fetchOk(`${VLC_INDEX}${file}.sha256`)).text();
    const expected = published.trim().split(/\s+/)[0].toLowerCase();
    const actual = await sha256(dmg);
    if (expected !== actual) throw new Error(`checksum mismatch for ${file}`);

    onProgress({ name: 'VLC', phase: 'install' });
    const partial = `${paths.vlcApp}.partial`;
    await copyFromDmg(dmg, partial, paths.tmpDir);

    // Nothing here went through a browser, so there is no quarantine flag to
    // clear in practice; stripping it anyway keeps a copied-in bundle usable.
    await execFileAsync('xattr', ['-dr', 'com.apple.quarantine', partial]).catch(() => {});

    await fsp.rm(paths.vlcApp, { recursive: true, force: true });
    await fsp.rename(partial, paths.vlcApp);
  } finally {
    await fsp.rm(dmg, { force: true });
  }
}

// --- Entry point ---------------------------------------------------------

// Fetches whatever `vendor` is still missing. Each tool is reported on its
// own, so one failure still leaves the others installed.
async function ensureVendorTools(root, onProgress = () => {}) {
  const missing = missingVendorTools(root);
  const failures = [];

  for (const name of missing) {
    try {
      onProgress({ name, phase: 'start' });
      if (name === 'VLC') await installVlc(root, onProgress);
      else await installFfmpegTool(name, root, onProgress);
      onProgress({ name, phase: 'done' });
    } catch (error) {
      failures.push({ name, message: error.message });
      onProgress({ name, phase: 'failed', message: error.message });
    }
  }

  await fsp.rm(vendorPaths(root).tmpDir, { recursive: true, force: true }).catch(() => {});
  return { installed: missing.filter((name) => !failures.some((f) => f.name === name)), failures };
}

module.exports = {
  vendorPaths,
  missingVendorTools,
  ensureVendorTools,
  canFetchVlc,
  canFetchFfmpeg
};

// `npm run vendor` runs this file directly.
if (require.main === module) {
  const root = path.join(__dirname, '..');
  const bar = (received, total) => (total
    ? `${((received / total) * 100).toFixed(0)}% of ${(total / 1e6).toFixed(0)} MB`
    : `${(received / 1e6).toFixed(0)} MB`);

  ensureVendorTools(root, (info) => {
    if (info.phase === 'download') process.stdout.write(`\r${info.name}: ${bar(info.received, info.total)}   `);
    else if (info.phase === 'start') process.stdout.write(`\n${info.name}: fetching\n`);
    else if (info.phase !== 'failed') process.stdout.write(`\r${info.name}: ${info.phase}          \n`);
    else process.stdout.write(`\r${info.name}: failed — ${info.message}\n`);
  }).then(({ installed, failures }) => {
    const paths = vendorPaths(root);
    if (installed.length) console.log(`Installed ${installed.join(', ')} into ${paths.dir}`);
    else if (!failures.length) console.log(`Nothing to do; ${paths.dir} is complete.`);
    process.exitCode = failures.length ? 1 : 0;
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
