const { ipcRenderer } = require('electron');

// --- Accent colour -------------------------------------------------------
// The app used to be IMDb yellow throughout. It now takes a hue at random on
// every launch, chosen once in the main process so every window and page in the
// same run agrees on it. Asked for synchronously: the styles below are built as
// this file loads, before anything is drawn.
const ACCENT_HUE = ipcRenderer.sendSync('get-accent-hue');

// The yellow this replaced is about hsl(47, 82%, 53%). Every hue borrows that
// saturation and lightness, so whatever comes up is vivid to the same degree
// and hue 47 reproduces the old look exactly.
const ACCENT_SATURATION = 82;
const ACCENT_LIGHTNESS = 53;

const accentAt = (lightness) => `hsl(${ACCENT_HUE}, ${ACCENT_SATURATION}%, ${lightness}%)`;

// sRGB channels, 0-255, for an HSL triple.
function hslToRgb(h, s, l) {
  const chroma = (1 - Math.abs(2 * (l / 100) - 1)) * (s / 100);
  const second = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const base = l / 100 - chroma / 2;

  const [r, g, b] = h < 60 ? [chroma, second, 0]
    : h < 120 ? [second, chroma, 0]
    : h < 180 ? [0, chroma, second]
    : h < 240 ? [0, second, chroma]
    : h < 300 ? [second, 0, chroma]
    : [chroma, 0, second];

  return [r + base, g + base, b + base].map((channel) => Math.round(channel * 255));
}

// WCAG relative luminance, which is what makes the two ratios below mean
// anything: a hue's brightness is nothing like its lightness number.
function luminance([r, g, b]) {
  const straighten = (value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * straighten(r) + 0.7152 * straighten(g) + 0.0722 * straighten(b);
}

function contrast(a, b) {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

const ACCENT = accentAt(ACCENT_LIGHTNESS);

// Buttons paint the accent behind their label. Black reads on a yellow, white
// on a navy, so the label takes whichever the drawn hue actually carries
// rather than the black the yellow could always assume.
const ACCENT_INK = (() => {
  const accent = hslToRgb(ACCENT_HUE, ACCENT_SATURATION, ACCENT_LIGHTNESS);
  return contrast(accent, [0, 0, 0]) >= contrast(accent, [255, 255, 255]) ? '#000' : '#fff';
})();

// The accent is also printed as text on the near-black chrome, where a dark
// hue would all but vanish. Lighten it until it clears a comfortable ratio
// against the palest of those backgrounds; a yellow already clears it and so
// stays exactly as it was.
const ACCENT_ON_DARK = (() => {
  const background = [30, 30, 30]; // #1e1e1e, the lightest surface it sits on.

  for (let lightness = ACCENT_LIGHTNESS; lightness < 92; lightness += 1) {
    if (contrast(hslToRgb(ACCENT_HUE, ACCENT_SATURATION, lightness), background) >= 5.5) {
      return accentAt(lightness);
    }
  }

  return accentAt(92);
})();

// Selector for the title component the bottom-bar buttons read.
const TARGET_SELECTOR = '[data-testid="hero__primary-text"], .hero__primary-text';

// The release year sits in the metadata list beside the hero title,
// as a link into the title's release-info page.
const YEAR_SELECTOR = 'a[href*="/releaseinfo"]';

const BAR_ID = '__imdb_inspect_bar__';
const BAR_HEIGHT = 92;
const TOP_BAR_ID = '__imdb_location_bar__';
const TOP_BAR_HEIGHT = 34;
const GALLERY_ROOT_ID = '__local_gallery_root__';
const SUBTITLE_MODAL_ID = '__connect_subtitle_modal__';
const BLOCKED_ROOT_ID = '__blocked_root__';
const TILE_SIZE = 72;

const BUTTON_STYLE = {
  padding: '6px 12px',
  font: '600 12px/1.4 Arial, Helvetica, sans-serif',
  color: ACCENT_INK,
  background: ACCENT,
  border: 'none',
  borderRadius: '4px',
  cursor: 'pointer'
};

// The bar's own actions are square tiles, big enough to hit without aiming.
const TILE_STYLE = {
  ...BUTTON_STYLE,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flex: '0 0 auto',
  width: `${TILE_SIZE}px`,
  height: `${TILE_SIZE}px`,
  padding: '6px',
  font: '600 12px/1.25 Arial, Helvetica, sans-serif',
  textAlign: 'center',
  whiteSpace: 'normal',
  wordBreak: 'break-word'
};

// Buttons that need a title on the page before they do anything.
const titleButtons = [];

let locationLabel;
let statusLabel;
let statusTimer;
let bottomBar;

// What the bar's one Back tile does. A web page steps back through history;
// the gallery swaps this for a step up its folders while it is open, so the
// same button reads the same way wherever it is pressed.
const historyBack = () => ipcRenderer.send('inspect-go-back');
let goBack = historyBack;

// Torrent rows by id, so a redraw updates them in place.

// The bar's own address line: the web page's URL, or the folder the gallery is
// showing — one line for both, since only one of them is ever on screen.
// Compared against the label itself, so a rebuilt bar always gets filled in.
function showLocation(text) {
  if (!locationLabel || locationLabel.textContent === text) return;
  locationLabel.textContent = text;
  locationLabel.title = text;
}

// One-off notes from the main process, such as where a download was saved.
function showStatus(text, failed) {
  if (!statusLabel) return;
  clearTimeout(statusTimer);
  statusLabel.textContent = text;
  statusLabel.style.color = failed ? '#e08080' : ACCENT_ON_DARK;
  statusLabel.style.display = text ? 'block' : 'none';
  if (text) statusTimer = setTimeout(() => showStatus(''), 8000);
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

// The query a search is built from. Download Content wants the year to pin
// down the title; OpenSubtitles matches better on the name alone.
function titleQuery(withYear) {
  const title = findTitle();
  if (!title || !withYear) return title;
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

function createButton(text, onClick, style = BUTTON_STYLE) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = text;
  Object.assign(button.style, style);
  button.addEventListener('click', onClick);
  return button;
}

const createTile = (text, onClick) => createButton(text, onClick, TILE_STYLE);

function createSearchButton(text, channel, withYear) {
  const button = createTile(text, () => {
    const query = titleQuery(withYear);
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
  label.title = key === 'subtitle'
    ? 'The encoded title is appended to this URL'
    : 'The encoded title and year are appended to this URL';
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

const createPickTile = () =>
  createTile('Select Local Gallery', () => ipcRenderer.invoke('pick-library-folder'));

function createLibraryTiles() {
  // Without a folder yet, ask for one first and go straight into the gallery.
  const gallery = createTile('Local Gallery', async () => {
    const result = await ipcRenderer.invoke('open-local-gallery');
    if (result.reason !== 'no-library') return;

    const picked = await ipcRenderer.invoke('pick-library-folder');
    if (picked.ok) await ipcRenderer.invoke('open-local-gallery');
  });

  const imdb = createTile('IMDb', () => ipcRenderer.send('open-home'));

  return [gallery, imdb];
}

// --- Connect subtitle ----------------------------------------------------
// A freshly downloaded subtitle is an archive sitting in the library root. The
// modal browses the library the gallery way, and the video the user picks is
// the one the subtitle is unpacked next to and named after.

function createModalButton(text, onClick, primary) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = text;
  Object.assign(button.style, {
    padding: '6px 12px',
    font: '600 12px/1.4 Arial, Helvetica, sans-serif',
    color: primary ? ACCENT_INK : '#ddd',
    background: primary ? ACCENT : 'transparent',
    border: primary ? 'none' : '1px solid #444',
    borderRadius: '4px',
    whiteSpace: 'nowrap',
    flex: '0 0 auto',
    cursor: 'pointer'
  });
  button.addEventListener('click', onClick);
  return button;
}

function openSubtitleModal(archive, name) {
  document.getElementById(SUBTITLE_MODAL_ID)?.remove();

  const overlay = document.createElement('div');
  overlay.id = SUBTITLE_MODAL_ID;
  Object.assign(overlay.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483646',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0, 0, 0, 0.72)',
    font: '400 13px/1.5 Arial, Helvetica, sans-serif',
    color: '#eee'
  });

  const panel = document.createElement('div');
  Object.assign(panel.style, {
    display: 'flex',
    flexDirection: 'column',
    width: 'min(560px, 90vw)',
    maxHeight: '72vh',
    background: '#1b1b1b',
    border: '1px solid #333',
    borderRadius: '8px',
    boxShadow: '0 18px 48px rgba(0, 0, 0, 0.55)',
    overflow: 'hidden'
  });

  const head = document.createElement('div');
  Object.assign(head.style, { padding: '14px 16px', borderBottom: '1px solid #2f2f2f' });

  const heading = document.createElement('div');
  heading.textContent = 'Connect Subtitle';
  Object.assign(heading.style, { font: '600 15px/1.4 Arial, Helvetica, sans-serif', color: ACCENT_ON_DARK });

  const sub = document.createElement('div');
  sub.textContent = `Pick the video ${name} belongs to.`;
  Object.assign(sub.style, { marginTop: '4px', color: '#aaa', wordBreak: 'break-all' });

  head.append(heading, sub);

  const nav = document.createElement('div');
  Object.assign(nav.style, {
    display: 'flex', alignItems: 'center', gap: '10px',
    padding: '10px 16px', borderBottom: '1px solid #2f2f2f'
  });

  const pathText = document.createElement('span');
  Object.assign(pathText.style, {
    color: '#999', fontSize: '12px', overflow: 'hidden',
    textOverflow: 'ellipsis', whiteSpace: 'nowrap'
  });

  const list = document.createElement('div');
  Object.assign(list.style, { overflowY: 'auto', padding: '6px 0', flex: '1 1 auto', minHeight: '120px' });

  const foot = document.createElement('div');
  Object.assign(foot.style, {
    display: 'flex', alignItems: 'center', gap: '12px',
    padding: '12px 16px', borderTop: '1px solid #2f2f2f'
  });

  const note = document.createElement('span');
  Object.assign(note.style, { color: '#888', fontSize: '12px', flex: '1 1 auto' });

  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
  };

  function onKey(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  }

  const cancel = createModalButton('Not now', () => {
    close();
    showStatus(`${name} is waiting in the library folder.`);
  });

  let up;

  async function render(dirPath) {
    const listing = await ipcRenderer.invoke('read-library-dir', dirPath);
    list.textContent = '';

    if (!listing.ok) {
      note.textContent = `Could not read the library (${listing.message || listing.reason}).`;
      note.style.color = '#e08080';
      return;
    }

    pathText.textContent = listing.path;
    up.disabled = !listing.parent;
    up.style.opacity = listing.parent ? '1' : '0.45';
    up.style.cursor = listing.parent ? 'pointer' : 'default';
    up.onclick = () => render(listing.parent);

    if (!listing.entries.length) {
      const empty = document.createElement('div');
      empty.textContent = 'No folders or videos here.';
      Object.assign(empty.style, { padding: '10px 16px', color: '#888' });
      list.append(empty);
      return;
    }

    for (const entry of listing.entries) {
      const row = document.createElement('div');
      row.textContent = `${entry.isDirectory ? '📁' : '🎬'}  ${entry.name}`;
      Object.assign(row.style, {
        padding: '8px 16px', cursor: 'pointer', color: '#eee',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
      });
      row.addEventListener('mouseenter', () => { row.style.background = '#2a2a2a'; });
      row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });

      row.addEventListener('click', async () => {
        if (entry.isDirectory) {
          render(entry.path);
          return;
        }

        note.style.color = '#888';
        note.textContent = `Connecting to ${entry.name}…`;
        const result = await ipcRenderer.invoke('attach-subtitle', archive, entry.path);

        if (result.ok) {
          close();
          showStatus(`Connected ${result.subtitle} to ${entry.name}.`);
        } else {
          note.style.color = '#e08080';
          note.textContent = `Could not connect it (${result.message || result.reason}).`;
        }
      });

      list.append(row);
    }
  }

  up = createModalButton('↑ Up', () => {});
  nav.append(up, pathText);
  foot.append(note, cancel);
  panel.append(head, nav, list, foot);
  overlay.append(panel);
  document.body.append(overlay);
  document.addEventListener('keydown', onKey, true);

  render('');
}

// The address line rides at the top of the page, the way the gallery prints the
// folder it is showing.
function createTopBar() {
  document.getElementById(TOP_BAR_ID)?.remove();

  const top = document.createElement('div');
  top.id = TOP_BAR_ID;
  Object.assign(top.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    right: '0',
    zIndex: '2147483647',
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    height: `${TOP_BAR_HEIGHT}px`,
    padding: '0 14px',
    boxSizing: 'border-box',
    background: '#121212',
    borderBottom: '1px solid #2f2f2f',
    font: '400 12px/1.4 Arial, Helvetica, sans-serif',
    color: '#bbb'
  });

  locationLabel = document.createElement('span');
  Object.assign(locationLabel.style, {
    flex: '1 1 auto',
    minWidth: '0',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: '#999'
  });

  statusLabel = document.createElement('span');
  Object.assign(statusLabel.style, {
    flex: '0 0 auto',
    maxWidth: '420px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    display: 'none'
  });

  top.append(locationLabel, statusLabel);
  document.body.appendChild(top);
  document.body.style.paddingTop = `${TOP_BAR_HEIGHT}px`;
}

// The bar grows when the settings row opens, so the page padding follows it.
function resizeBar(bar) {
  document.body.style.paddingBottom = `${Math.max(bar.offsetHeight, BAR_HEIGHT)}px`;
}

// --- Torrents ------------------------------------------------------------
// Magnet links go to the main process, which hands them to WebTorrent. That
// app has a window of its own and reports nothing back, so all this side shows
// is the one line saying the link was passed on.

function createBottomBar() {
  // Some sites run this preload a second time after load. Without this the
  // pages end up with two stacked bars, the empty newer one hiding the older.
  document.getElementById(BAR_ID)?.remove();
  titleButtons.length = 0;

  const bar = document.createElement('div');
  bar.id = BAR_ID;
  Object.assign(bar.style, {
    position: 'fixed',
    left: '0',
    right: '0',
    bottom: '0',
    zIndex: '2147483647',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'stretch',
    gap: '10px',
    minHeight: `${BAR_HEIGHT}px`,
    padding: '10px 14px',
    boxSizing: 'border-box',
    background: '#121212',
    borderTop: '1px solid #2f2f2f',
    font: '400 12px/1.4 Arial, Helvetica, sans-serif',
    color: '#bbb'
  });

  // The settings live on their own row under the buttons, hidden until asked for.
  const settings = document.createElement('div');
  Object.assign(settings.style, { display: 'none', alignItems: 'center', gap: '16px' });

  const settingsToggle = createTile('Show Settings', () => {
    const shown = settings.style.display !== 'none';
    settings.style.display = shown ? 'none' : 'flex';
    settingsToggle.textContent = shown ? 'Show Settings' : 'Hide Settings';
    resizeBar(bar);
  });

  const left = document.createElement('div');
  Object.assign(left.style, { display: 'flex', flexDirection: 'column', gap: '8px' });

  bottomBar = bar;

  const actions = document.createElement('div');
  Object.assign(actions.style, { display: 'flex', alignItems: 'center', gap: '8px' });
  actions.append(
    createTile('← Back', () => goBack()),
    createSearchButton('Download Content', 'inspect-search', true),
    createSearchButton('Download Subtitle', 'subtitle-search', false),
    ...createLibraryTiles(),
    settingsToggle
  );

  // A second pass over the same page rebuilds the bar, so the old listener goes.
  ipcRenderer.removeAllListeners('download-status');
  ipcRenderer.removeAllListeners('subtitle-downloaded');
  ipcRenderer.on('download-status', (event, payload) => showStatus(payload.text, payload.failed));
  ipcRenderer.on('subtitle-downloaded', (event, payload) => openSubtitleModal(payload.archive, payload.name));

  left.append(actions);

  const fields = document.createElement('div');
  Object.assign(fields.style, { display: 'flex', flexDirection: 'column', gap: '6px' });

  const inspect = createBaseUrlRow('inspect', 'Download Base URL', 'https://www.google.com/search?q=');
  const subtitle = createBaseUrlRow('subtitle', 'Subtitle Base URL', 'https://www.opensubtitles.org/en/search2?MovieName=');
  fields.append(inspect.row, subtitle.row);

  ipcRenderer.invoke('get-base-urls').then((urls) => {
    inspect.input.value = urls.inspect || '';
    subtitle.input.value = urls.subtitle || '';
  });

  settings.append(fields, createPickTile());

  bar.append(left, settings);
  document.body.appendChild(bar);
  resizeBar(bar);

  refreshTitleButtons();
}

// --- Local gallery -------------------------------------------------------
// The gallery page is a bare shell; preload owns the filesystem side, so it
// renders the listing rather than exposing an API to page scripts.

const GALLERY_STYLE = `
  .lg-wrap { padding: 20px 24px 8px; }
  .lg-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; }
  /* The delete button rides over the card, which is itself a button. */
  .lg-cell { position: relative; }
  .lg-delete {
    position: absolute; top: 10px; right: 10px; z-index: 1;
    display: flex; align-items: center; justify-content: center;
    width: 26px; height: 26px; padding: 0;
    font: 600 13px/1 Arial, Helvetica, sans-serif; color: #eee;
    background: rgba(0, 0, 0, 0.65); border: 1px solid #3a3a3a; border-radius: 50%;
    opacity: 0.5; cursor: pointer;
  }
  .lg-cell:hover .lg-delete, .lg-delete:focus { opacity: 1; }
  .lg-delete:hover { color: #fff; background: #c0392b; border-color: #c0392b; }
  .lg-delete[disabled] { opacity: 0.35; cursor: default; }
  .lg-card {
    display: flex; flex-direction: column; align-items: stretch;
    gap: 10px; width: 100%; aspect-ratio: 1 / 1;
    padding: 12px; overflow: hidden;
    font: 400 13px/1.4 Arial, Helvetica, sans-serif; text-align: center; color: #eee;
    background: #1e1e1e; border: 1px solid #2f2f2f; border-radius: 8px; cursor: pointer;
  }
  .lg-card:hover { background: #262626; border-color: ${ACCENT}; }
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
  .lg-progress-fill { height: 100%; width: 0; background: ${ACCENT}; }
  /* Long names wrap instead of truncating, so the whole name is readable. */
  .lg-name { flex: none; overflow-wrap: anywhere; word-break: break-word; }
  .lg-note { color: #999; font-size: 12px; }
  .lg-empty, .lg-error { color: #999; font-size: 13px; }
  .lg-error { color: #e08080; }
`;

// Cards on screen right now, so their bars can be refreshed in place.
let progressCards = [];

// Where the gallery is currently pointed, so a folder that appears while it is
// open — a download WebTorrent has just finished, say — can be drawn without a
// navigation.
let galleryRoot;
let galleryDir = '';

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
  card.bar.title = progress.finished
    ? `Finished — ${clock(progress.duration)}`
    : `VLC stopped at ${clock(progress.seconds)} of ${clock(progress.duration)}`;
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

function galleryCard(entry, onClick, onDelete, onMissingFfmpeg) {
  const cell = document.createElement('div');
  cell.className = 'lg-cell';

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

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'lg-delete';
  remove.textContent = '\u2715';
  remove.title = `Move ${entry.isDirectory ? 'folder' : 'video'} to the Trash`;
  remove.setAttribute('aria-label', `Move ${entry.name} to the Trash`);
  remove.addEventListener('click', async (event) => {
    // Without this the card underneath would play or open the entry too.
    event.stopPropagation();
    remove.disabled = true;
    await onDelete();
    remove.disabled = false;
  });

  cell.append(card, remove);
  loadThumbnail(tracked, entry, thumb, icon, onMissingFfmpeg);
  return cell;
}

async function renderGallery(root, dirPath) {
  const listing = await ipcRenderer.invoke('read-library-dir', dirPath);
  root.textContent = '';
  progressCards = [];
  galleryDir = listing.ok ? listing.path : dirPath;

  const wrap = document.createElement('div');
  wrap.className = 'lg-wrap';

  if (!listing.ok) {
    goBack = historyBack;

    const error = document.createElement('p');
    error.className = 'lg-error';
    error.textContent = listing.reason === 'no-library'
      ? 'Pick a library folder in the bar below to browse it here.'
      : `Could not read this folder (${listing.message || listing.reason}).`;
    wrap.append(error);
    root.append(wrap);
    return;
  }

  // The folder is the address here, so it goes on the same line a web page's
  // URL does rather than being printed a second time above the grid.
  showLocation(listing.path);

  // Back steps up a folder while there is one to step up to, and at the
  // library root falls through to history, which is the page arrived from.
  goBack = listing.parent ? () => renderGallery(root, listing.parent) : historyBack;

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
      const cell = galleryCard(entry, async () => {
        if (entry.isDirectory) {
          renderGallery(root, entry.path);
          return;
        }

        const visibleEntries = listing.entries.map((visible) => ({
          path: visible.path,
          isDirectory: visible.isDirectory,
          isVideo: visible.isVideo
        }));
        const result = await ipcRenderer.invoke('open-in-vlc', entry.path, visibleEntries);
        if (!result.ok) {
          if (result.reason === 'vlc-missing') {
            // Main already showed a dialog; leave the reason on screen too.
            showStatus('VLC is not installed on this machine.', true);
          } else if (result.reason === 'vlc-failed') {
            showStatus(`Could not start VLC (${result.message}).`, true);
          } else if (result.reason === 'playlist-failed') {
            showStatus(`Could not build the autoplay playlist (${result.message}).`, true);
          } else {
            showStatus(`Could not open that file (${result.reason}).`, true);
          }
        }
      }, async () => {
        const result = await ipcRenderer.invoke('delete-library-entry', entry.path);
        if (result.ok) {
          // The listing changed underneath us, so redraw this folder.
          renderGallery(root, listing.path);
        } else if (result.reason !== 'canceled') {
          showStatus(`Could not delete ${entry.name} (${result.message || result.reason}).`, true);
        }
      }, showFfmpegNote);

      grid.append(cell);
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
  // A download landing in the library adds a folder the listing has never
  // seen, which needs the whole listing again rather than only its bars.
  ipcRenderer.on('library-changed', () => renderGallery(galleryRoot, galleryDir));
  galleryRoot = root;
  renderGallery(root, '');
}

// --- Missing requirements ------------------------------------------------
// ffmpeg, ffprobe, VLC and WebTorrent are the machine's to install, not this
// app's. When any of them is absent this page takes over and says which one
// and how to get it; nothing else is rendered, so there is nothing to click
// until they are there.

const BLOCKED_STYLE = `
  .bl-wrap { max-width: 640px; padding: 64px 32px; margin: 0 auto; }
  .bl-title { margin: 0 0 12px; font-size: 20px; color: ${ACCENT_ON_DARK}; }
  .bl-text { margin: 0 0 24px; color: #ccc; }
  .bl-list { margin: 0 0 24px; padding: 0; list-style: none; color: #eee; }
  .bl-item { margin: 0 0 18px; }
  .bl-what { color: #999; font-size: 13px; }
  .bl-cmd {
    display: block; margin-top: 8px; padding: 8px 10px;
    font: 400 13px/1.4 Menlo, Consolas, monospace; color: ${ACCENT_ON_DARK};
    background: #1e1e1e; border: 1px solid #2f2f2f; border-radius: 4px; user-select: all;
  }
  .bl-hint { margin: 0 0 24px; color: #777; font-size: 12px; }
  .bl-button {
    padding: 8px 16px; font: 600 13px/1.4 Arial, Helvetica, sans-serif;
    color: ${ACCENT_INK}; background: ${ACCENT}; border: none; border-radius: 4px; cursor: pointer;
  }
  .bl-button[disabled] { opacity: 0.5; cursor: default; }
`;

// What each tool is for, and the one command that installs it.
const INSTALL_GUIDE = {
  ffmpeg: {
    what: 'grabs the scene shown on each tile',
    command: 'brew install ffmpeg'
  },
  ffprobe: {
    what: 'reads video length for the progress bar (ships with ffmpeg)',
    command: 'brew install ffmpeg'
  },
  VLC: {
    what: 'plays the videos you click',
    command: 'brew install --cask vlc'
  },
  WebTorrent: {
    what: 'downloads the magnet links you open',
    command: 'brew install --cask webtorrent'
  }
};

function startBlocked(root) {
  const style = document.createElement('style');
  style.textContent = BLOCKED_STYLE;
  document.head.append(style);

  const wrap = document.createElement('div');
  wrap.className = 'bl-wrap';

  const title = document.createElement('h1');
  title.className = 'bl-title';
  title.textContent = 'Missing programs';

  const text = document.createElement('p');
  text.className = 'bl-text';
  text.textContent = 'IMDb runs these as outside programs and does not install them. '
    + 'Install what is listed below, then check again.';

  const list = document.createElement('ul');
  list.className = 'bl-list';

  const hint = document.createElement('p');
  hint.className = 'bl-hint';
  hint.textContent = 'The commands need Homebrew (https://brew.sh). '
    + 'Installing by hand works just as well, as long as the app ends up somewhere the system knows about.';

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'bl-button';
  retry.textContent = 'Check again';

  // One row per missing tool, redrawn whenever the check is run again.
  const showMissing = (missing) => {
    list.textContent = '';

    for (const name of missing) {
      const guide = INSTALL_GUIDE[name];
      if (!guide) continue;

      const item = document.createElement('li');
      item.className = 'bl-item';

      const heading = document.createElement('strong');
      heading.textContent = name;

      const what = document.createElement('span');
      what.className = 'bl-what';
      what.textContent = ` \u00b7 ${guide.what}`;

      const command = document.createElement('code');
      command.className = 'bl-cmd';
      command.textContent = guide.command;

      item.append(heading, what, command);
      list.append(item);
    }
  };

  // The main process hands the window back to the app as soon as nothing is
  // missing, so a successful check ends this page on its own.
  const recheck = async () => {
    retry.disabled = true;
    try {
      showMissing(await ipcRenderer.invoke('recheck-dependencies'));
    } finally {
      retry.disabled = false;
    }
  };

  retry.addEventListener('click', recheck);

  showMissing((new URLSearchParams(location.search).get('missing') || '').split(',').filter(Boolean));
  wrap.append(title, text, list, hint, retry);
  root.append(wrap);
}

function start() {
  const blockedRoot = document.getElementById(BLOCKED_ROOT_ID);
  if (blockedRoot) {
    startBlocked(blockedRoot);
    return;
  }

  createTopBar();
  createBottomBar();

  // Caught on the way down, before the page turns the click into a navigation
  // Chromium has nowhere to send. Scripted magnets are stopped in the main
  // process instead, where the navigation itself shows up.
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const link = target && target.closest('a[href^="magnet:"]');
    if (!link) return;
    event.preventDefault();
    ipcRenderer.invoke('add-magnet', link.href);
  }, true);

  // The gallery is served from a file:// page whose URL says nothing useful,
  // so it fills the address line with the folder it is showing instead.
  const galleryRoot = document.getElementById(GALLERY_ROOT_ID);
  if (galleryRoot) {
    startGallery(galleryRoot);
    return;
  }

  goBack = historyBack;
  showLocation(location.href);

  // IMDb renders client-side, so both the title and the URL can change
  // without a page load.
  new MutationObserver(refreshTitleButtons).observe(document.body, { childList: true, subtree: true });
  setInterval(() => showLocation(location.href), 500);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
