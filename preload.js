const { ipcRenderer } = require('electron');

// Selector for the title component the bottom-bar buttons read.
const TARGET_SELECTOR = '[data-testid="hero__primary-text"], .hero__primary-text';

// The release year sits in the metadata list beside the hero title,
// as a link into the title's release-info page.
const YEAR_SELECTOR = 'a[href*="/releaseinfo"]';

const BAR_ID = '__imdb_inspect_bar__';
const BAR_HEIGHT = 116;
const GALLERY_ROOT_ID = '__local_gallery_root__';
const BLOCKED_ROOT_ID = '__blocked_root__';

const BUTTON_STYLE = {
  padding: '6px 12px',
  font: '600 12px/1.4 Arial, Helvetica, sans-serif',
  color: '#000',
  background: '#f5c518',
  border: 'none',
  borderRadius: '4px',
  cursor: 'pointer'
};

// Buttons that need a title on the page before they do anything.
const titleButtons = [];

let libraryPathLabel;
let locationLabel;
let shownLocation = '';

// The bar's own address line: a web page's URL, or the folder the gallery is in.
function showLocation(text) {
  if (!locationLabel || text === shownLocation) return;
  shownLocation = text;
  locationLabel.textContent = text;
  locationLabel.title = text;
}

function findTitle() {
  const target = document.querySelector(TARGET_SELECTOR);
  return target ? target.textContent.trim() : '';
}

// Look for the year next to the hero title first, then anywhere on the
// page, so a hero without its own metadata list still resolves.
function findYear() {
  const title = document.querySelector(TARGET_SELECTOR);
  const scopes = [title?.closest('[data-testid="hero__pageTitle"]')?.parentElement, document];

  for (const scope of scopes) {
    if (!scope) continue;
    for (const link of scope.querySelectorAll(YEAR_SELECTOR)) {
      const match = link.textContent.match(/\b(?:18|19|20|21)\d{2}\b/);
      if (match) return match[0];
    }
  }

  return '';
}

// Title plus year, the query both searches are built from.
function titleQuery() {
  const title = findTitle();
  if (!title) return '';
  const year = findYear();
  return year ? `${title} ${year}` : title;
}

// The buttons only make sense on a page that has a title to search for.
function refreshTitleButtons() {
  const enabled = Boolean(findTitle());
  for (const button of titleButtons) {
    button.disabled = !enabled;
    button.style.opacity = enabled ? '1' : '0.45';
    button.style.cursor = enabled ? 'pointer' : 'default';
  }
}

function createButton(text, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = text;
  Object.assign(button.style, BUTTON_STYLE);
  button.addEventListener('click', onClick);
  return button;
}

function createSearchButton(text, channel) {
  const button = createButton(text, () => {
    const query = titleQuery();
    if (query) ipcRenderer.send(channel, query);
  });
  titleButtons.push(button);
  return button;
}

function createBaseUrlRow(key, labelText, placeholder) {
  const row = document.createElement('div');
  Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px' });

  const label = document.createElement('span');
  label.textContent = labelText;
  label.title = 'The encoded title and year are appended to this URL';
  Object.assign(label.style, { width: '112px', textAlign: 'right' });

  const input = document.createElement('input');
  input.type = 'text';
  input.spellcheck = false;
  input.placeholder = placeholder;
  Object.assign(input.style, {
    width: '320px',
    padding: '5px 8px',
    font: '400 12px/1.4 Arial, Helvetica, sans-serif',
    color: '#eee',
    background: '#1e1e1e',
    border: '1px solid #3a3a3a',
    borderRadius: '4px',
    outline: 'none'
  });

  const save = createButton('Save', async () => {
    const result = await ipcRenderer.invoke('set-base-url', key, input.value);
    if (result.ok) {
      save.textContent = 'Saved';
      setTimeout(() => {
        save.textContent = 'Save';
      }, 1200);
    } else {
      input.style.borderColor = '#e05252';
      setTimeout(() => {
        input.style.borderColor = '#3a3a3a';
      }, 1200);
    }
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      save.click();
    }
  });

  row.append(label, input, save);
  return { row, input };
}

function showLibraryPath(libraryPath) {
  if (!libraryPathLabel) return;
  libraryPathLabel.textContent = libraryPath || 'No library folder selected';
  libraryPathLabel.title = libraryPath || '';
  libraryPathLabel.style.color = libraryPath ? '#bbb' : '#777';
}

function createLibraryControls() {
  const wrap = document.createElement('div');
  Object.assign(wrap.style, { display: 'flex', flexDirection: 'column', gap: '6px' });

  const buttons = document.createElement('div');
  Object.assign(buttons.style, { display: 'flex', alignItems: 'center', gap: '8px' });

  const pick = createButton('Library Folder…', async () => {
    const result = await ipcRenderer.invoke('pick-library-folder');
    showLibraryPath(result.libraryPath);
  });

  // Without a folder yet, ask for one first and go straight into the gallery.
  const gallery = createButton('Local Gallery', async () => {
    let result = await ipcRenderer.invoke('open-local-gallery');
    if (result.reason !== 'no-library') return;

    const picked = await ipcRenderer.invoke('pick-library-folder');
    showLibraryPath(picked.libraryPath);
    if (picked.ok) result = await ipcRenderer.invoke('open-local-gallery');
  });

  const imdb = createButton('IMDb', () => ipcRenderer.send('open-home'));

  buttons.append(pick, gallery, imdb);

  libraryPathLabel = document.createElement('span');
  Object.assign(libraryPathLabel.style, {
    maxWidth: '420px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
  });

  ipcRenderer.invoke('get-library-path').then(showLibraryPath);

  wrap.append(buttons, libraryPathLabel);
  return wrap;
}

function createBottomBar() {
  const bar = document.createElement('div');
  bar.id = BAR_ID;
  Object.assign(bar.style, {
    position: 'fixed',
    left: '0',
    right: '0',
    bottom: '0',
    zIndex: '2147483647',
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    height: `${BAR_HEIGHT}px`,
    padding: '0 14px',
    boxSizing: 'border-box',
    background: '#121212',
    borderTop: '1px solid #2f2f2f',
    font: '400 12px/1.4 Arial, Helvetica, sans-serif',
    color: '#bbb'
  });

  const left = document.createElement('div');
  Object.assign(left.style, { display: 'flex', flexDirection: 'column', gap: '8px' });

  const actions = document.createElement('div');
  Object.assign(actions.style, { display: 'flex', alignItems: 'center', gap: '8px' });
  actions.append(
    createButton('← Back', () => ipcRenderer.send('inspect-go-back')),
    createSearchButton('Inspect', 'inspect-search'),
    createSearchButton('Subtitles', 'subtitle-search')
  );

  locationLabel = document.createElement('span');
  Object.assign(locationLabel.style, {
    maxWidth: '640px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: '#8a8a8a'
  });

  left.append(actions, createLibraryControls(), locationLabel);

  const fields = document.createElement('div');
  Object.assign(fields.style, { display: 'flex', flexDirection: 'column', gap: '6px', marginLeft: 'auto' });

  const inspect = createBaseUrlRow('inspect', 'Inspect Base URL', 'https://www.google.com/search?q=');
  const subtitle = createBaseUrlRow('subtitle', 'Subtitle Base URL', 'https://www.opensubtitles.org/en/search2?MovieName=');
  fields.append(inspect.row, subtitle.row);

  ipcRenderer.invoke('get-base-urls').then((urls) => {
    inspect.input.value = urls.inspect || '';
    subtitle.input.value = urls.subtitle || '';
  });

  bar.append(left, fields);
  document.body.appendChild(bar);
  document.body.style.paddingBottom = `${BAR_HEIGHT}px`;

  refreshTitleButtons();
}

// --- Local gallery -------------------------------------------------------
// The gallery page is a bare shell; preload owns the filesystem side, so it
// renders the listing rather than exposing an API to page scripts.

const GALLERY_STYLE = `
  .lg-wrap { padding: 20px 24px 8px; }
  .lg-head { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
  .lg-path { color: #999; font-size: 12px; word-break: break-all; }
  .lg-up {
    padding: 6px 12px; font: 600 12px/1.4 Arial, Helvetica, sans-serif;
    color: #000; background: #f5c518; border: none; border-radius: 4px; cursor: pointer;
  }
  .lg-up[disabled] { opacity: 0.45; cursor: default; }
  .lg-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; }
  .lg-card {
    display: flex; flex-direction: column; align-items: stretch;
    gap: 10px; width: 100%; aspect-ratio: 1 / 1;
    padding: 12px; overflow: hidden;
    font: 400 13px/1.4 Arial, Helvetica, sans-serif; text-align: center; color: #eee;
    background: #1e1e1e; border: 1px solid #2f2f2f; border-radius: 8px; cursor: pointer;
  }
  .lg-card:hover { background: #262626; border-color: #f5c518; }
  .lg-thumb {
    position: relative; flex: 1; min-height: 0; display: flex;
    align-items: center; justify-content: center;
    background: #161616; border-radius: 6px; overflow: hidden;
  }
  .lg-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .lg-icon { font-size: 44px; line-height: 1; opacity: 0.55; }
  /* Kept over the frame so folders still read as folders. */
  .lg-badge { position: absolute; top: 6px; left: 6px; font-size: 16px; line-height: 1; text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9); }
  /* Where VLC stopped last time, if it has played this video before. */
  .lg-progress { flex: none; display: none; height: 4px; background: #333; border-radius: 2px; overflow: hidden; }
  .lg-progress-fill { height: 100%; width: 0; background: #f5c518; }
  /* Long names wrap instead of truncating, so the whole name is readable. */
  .lg-name { flex: none; overflow-wrap: anywhere; word-break: break-word; }
  .lg-note { color: #999; font-size: 12px; }
  .lg-empty, .lg-error { color: #999; font-size: 13px; }
  .lg-error { color: #e08080; }
`;

// Cards on screen right now, so their bars can be refreshed in place.
let progressCards = [];

const clock = (seconds) => {
  const total = Math.floor(seconds);
  const parts = [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60];
  if (!parts[0]) parts.shift();
  return parts.map((part, index) => (index ? String(part).padStart(2, '0') : String(part))).join(':');
};

function applyProgress(card, progress) {
  if (!card) return;

  if (!progress || !progress.ratio) {
    card.bar.style.display = 'none';
    return;
  }

  card.bar.style.display = 'block';
  card.fill.style.width = `${Math.round(progress.ratio * 100)}%`;
  card.bar.title = `VLC stopped at ${clock(progress.seconds)} of ${clock(progress.duration)}`;
}

async function refreshProgress() {
  if (!progressCards.length) return;

  const cards = progressCards;
  const results = await ipcRenderer.invoke(
    'get-progress',
    cards.map((card) => ({ path: card.entry.path, isDirectory: card.entry.isDirectory }))
  );

  const byPath = new Map(results.map((result) => [result.path, result.progress]));
  for (const card of cards) {
    if (byPath.has(card.entry.path)) applyProgress(card, byPath.get(card.entry.path));
  }
}

// A frame from the video (or from a folder's first video) replaces the icon
// once ffmpeg has produced it.
async function loadThumbnail(card, entry, thumb, icon, onMissingFfmpeg) {
  const result = await ipcRenderer.invoke('get-thumbnail', entry.path, entry.isDirectory);
  if (!result.ok) {
    if (result.reason === 'no-ffmpeg') onMissingFfmpeg();
    return;
  }

  applyProgress(card, result.progress);

  const image = document.createElement('img');
  image.alt = '';
  image.addEventListener('load', () => icon.remove());
  image.src = result.thumbnail;
  thumb.prepend(image);
}

function galleryCard(entry, onClick, onMissingFfmpeg) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'lg-card';
  card.title = entry.path;

  const thumb = document.createElement('div');
  thumb.className = 'lg-thumb';

  const icon = document.createElement('span');
  icon.className = 'lg-icon';
  icon.textContent = entry.isDirectory ? '📁' : '🎬';

  const badge = document.createElement('span');
  badge.className = 'lg-badge';
  badge.textContent = entry.isDirectory ? '📁' : '🎬';

  thumb.append(icon, badge);
  card.append(thumb);

  // Folders show a frame but no bar: the resume point belongs to a video.
  let tracked = null;
  if (!entry.isDirectory) {
    const bar = document.createElement('div');
    bar.className = 'lg-progress';

    const fill = document.createElement('div');
    fill.className = 'lg-progress-fill';
    bar.append(fill);

    card.append(bar);
    tracked = { entry, bar, fill };
    progressCards.push(tracked);
  }

  const name = document.createElement('span');
  name.className = 'lg-name';
  name.textContent = entry.name;

  card.append(name);
  card.addEventListener('click', onClick);

  loadThumbnail(tracked, entry, thumb, icon, onMissingFfmpeg);
  return card;
}

async function renderGallery(root, dirPath) {
  const listing = await ipcRenderer.invoke('read-library-dir', dirPath);
  root.textContent = '';
  progressCards = [];

  const wrap = document.createElement('div');
  wrap.className = 'lg-wrap';

  if (!listing.ok) {
    const error = document.createElement('p');
    error.className = 'lg-error';
    error.textContent = listing.reason === 'no-library'
      ? 'Pick a library folder in the bar below to browse it here.'
      : `Could not read this folder (${listing.message || listing.reason}).`;
    wrap.append(error);
    root.append(wrap);
    return;
  }

  const head = document.createElement('div');
  head.className = 'lg-head';

  const up = document.createElement('button');
  up.type = 'button';
  up.className = 'lg-up';
  up.textContent = '↑ Up';
  up.disabled = !listing.parent;
  up.addEventListener('click', () => renderGallery(root, listing.parent));

  const pathText = document.createElement('span');
  pathText.className = 'lg-path';
  pathText.textContent = listing.path;
  showLocation(listing.path);

  head.append(up, pathText);
  wrap.append(head);

  const note = document.createElement('p');
  note.className = 'lg-note';
  note.style.display = 'none';
  note.textContent = 'Install ffmpeg to see a scene from each video.';
  wrap.append(note);

  const showFfmpegNote = () => {
    note.style.display = 'block';
  };

  if (!listing.entries.length) {
    const empty = document.createElement('p');
    empty.className = 'lg-empty';
    empty.textContent = 'No folders or videos here.';
    wrap.append(empty);
  } else {
    const grid = document.createElement('div');
    grid.className = 'lg-grid';

    for (const entry of listing.entries) {
      const card = galleryCard(entry, async () => {
        if (entry.isDirectory) {
          renderGallery(root, entry.path);
          return;
        }

        const result = await ipcRenderer.invoke('open-in-vlc', entry.path);
        if (!result.ok) {
          pathText.className = 'lg-error';
          if (result.reason === 'vlc-missing') {
            // Main already showed a dialog; leave the reason on screen too.
            pathText.textContent = 'VLC is not installed on this machine.';
          } else if (result.reason === 'vlc-failed') {
            pathText.textContent = `Could not start VLC (${result.message}).`;
          } else {
            pathText.textContent = `Could not open that file (${result.reason}).`;
          }
        }
      }, showFfmpegNote);

      grid.append(card);
    }

    wrap.append(grid);
  }

  root.append(wrap);
}

function startGallery(root) {
  const style = document.createElement('style');
  style.textContent = GALLERY_STYLE;
  document.head.append(style);
  // Coming back from VLC is the moment a resume point changes.
  ipcRenderer.on('library-progress-changed', refreshProgress);
  renderGallery(root, '');
}

// --- Missing requirements ------------------------------------------------
// Shown instead of the app when ffmpeg, ffprobe or VLC is absent. Nothing
// else is rendered, so there is nothing to click but "Check again".

const BLOCKED_STYLE = `
  .bl-wrap { max-width: 640px; padding: 64px 32px; margin: 0 auto; }
  .bl-title { margin: 0 0 12px; font-size: 20px; color: #f5c518; }
  .bl-text { margin: 0 0 20px; color: #ccc; }
  .bl-list { margin: 0 0 20px; padding-left: 20px; color: #eee; }
  .bl-hint { margin: 0 0 24px; color: #999; font-size: 13px; }
  .bl-hint code { color: #eee; font-family: Menlo, Consolas, monospace; }
  .bl-button {
    padding: 8px 16px; font: 600 13px/1.4 Arial, Helvetica, sans-serif;
    color: #000; background: #f5c518; border: none; border-radius: 4px; cursor: pointer;
  }
`;

function startBlocked(root) {
  const style = document.createElement('style');
  style.textContent = BLOCKED_STYLE;
  document.head.append(style);

  const wrap = document.createElement('div');
  wrap.className = 'bl-wrap';

  const title = document.createElement('h1');
  title.className = 'bl-title';
  title.textContent = 'Missing requirements';

  const text = document.createElement('p');
  text.className = 'bl-text';
  text.textContent = 'This app needs ffmpeg, ffprobe and VLC installed on this machine. '
    + 'Everything stays disabled until all three are found.';

  const list = document.createElement('ul');
  list.className = 'bl-list';

  const showMissing = (missing) => {
    list.textContent = '';
    for (const name of missing) {
      const item = document.createElement('li');
      item.textContent = `${name} — not found`;
      list.append(item);
    }
  };

  showMissing((new URLSearchParams(location.search).get('missing') || '').split(',').filter(Boolean));

  const hint = document.createElement('p');
  hint.className = 'bl-hint';
  hint.append('Install ffmpeg with ');
  const code = document.createElement('code');
  code.textContent = 'brew install ffmpeg';
  hint.append(code, ', and VLC from videolan.org.');

  const recheck = document.createElement('button');
  recheck.type = 'button';
  recheck.className = 'bl-button';
  recheck.textContent = 'Check again';
  recheck.addEventListener('click', async () => {
    recheck.disabled = true;
    const missing = await ipcRenderer.invoke('recheck-dependencies');
    showMissing(missing);
    recheck.disabled = false;
  });

  wrap.append(title, text, list, hint, recheck);
  root.append(wrap);
}

function start() {
  const blockedRoot = document.getElementById(BLOCKED_ROOT_ID);
  if (blockedRoot) {
    startBlocked(blockedRoot);
    return;
  }

  createBottomBar();

  const galleryRoot = document.getElementById(GALLERY_ROOT_ID);
  if (galleryRoot) {
    startGallery(galleryRoot);
    return;
  }

  // IMDb renders client-side, so both the title and the URL can change
  // without a page load.
  new MutationObserver(refreshTitleButtons).observe(document.body, { childList: true, subtree: true });
  showLocation(location.href);
  setInterval(() => showLocation(location.href), 500);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
