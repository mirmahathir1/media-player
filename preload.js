const { ipcRenderer } = require('electron');

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
  color: '#000',
  background: '#f5c518',
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
let torrentPanel;

// Torrent rows by id, so a redraw updates them in place.
const torrentRows = new Map();

// The bar's own address line: the current web page's URL. Compared against the
// label itself, so a rebuilt bar always gets filled in.
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
  statusLabel.style.color = failed ? '#e08080' : '#f5c518';
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
    color: primary ? '#000' : '#ddd',
    background: primary ? '#f5c518' : 'transparent',
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
  Object.assign(heading.style, { font: '600 15px/1.4 Arial, Helvetica, sans-serif', color: '#f5c518' });

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
// Magnet links go to the main process, which downloads them into the library
// folder. The bar grows a row per torrent while they run and shrinks back to
// its usual height once the list empties.

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

function humanSize(bytes) {
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit && value < 10 ? value.toFixed(1) : Math.round(value)} ${SIZE_UNITS[unit]}`;
}

// A magnet names the swarm and nothing else, so the first seconds of a torrent
// have no name, no size and no percentage worth showing.
function torrentDetail(torrent) {
  // A finished torrent leaves the swarm at once, so this is what the row shows
  // in the moment between the last piece landing and the row going away.
  if (torrent.done) return `Done · ${humanSize(torrent.length)}`;
  if (!torrent.length) return `Fetching metadata · ${torrent.peers} peers`;

  return [
    `${(torrent.progress * 100).toFixed(1)}%`,
    `${humanSize(torrent.downloaded)} / ${humanSize(torrent.length)}`,
    `${humanSize(torrent.speed)}/s`,
    `${torrent.peers} peers`
  ].join(' · ');
}

function createTorrentRow(torrent) {
  const root = document.createElement('div');
  Object.assign(root.style, { display: 'flex', alignItems: 'center', gap: '10px' });

  const text = document.createElement('div');
  Object.assign(text.style, { flex: '1 1 auto', minWidth: '0' });

  const name = document.createElement('div');
  Object.assign(name.style, {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: '#eee',
    font: '600 12px/1.4 Arial, Helvetica, sans-serif'
  });

  const track = document.createElement('div');
  Object.assign(track.style, {
    height: '4px',
    margin: '5px 0',
    borderRadius: '2px',
    background: '#2f2f2f',
    overflow: 'hidden'
  });

  const fill = document.createElement('div');
  Object.assign(fill.style, { height: '100%', width: '0%', background: '#f5c518' });
  track.append(fill);

  const detail = document.createElement('div');
  detail.style.color = '#999';

  text.append(name, track, detail);

  // Gives up on a download that has not finished; a finished one takes itself
  // out of the list without being asked.
  const stop = createButton('Stop', () => ipcRenderer.invoke('remove-torrent', torrent.id), {
    ...BUTTON_STYLE,
    flex: '0 0 auto'
  });

  root.append(text, stop);
  return { root, name, fill, detail };
}

function updateTorrentRow(row, torrent) {
  const label = torrent.name || 'Starting torrent…';
  if (row.name.textContent !== label) {
    row.name.textContent = label;
    row.name.title = label;
  }
  row.fill.style.width = `${(torrent.progress * 100).toFixed(1)}%`;
  row.detail.textContent = torrentDetail(torrent);
}

// Rows are kept and updated rather than rebuilt: the list redraws every second,
// and a rebuild there would throw away the Stop button under the user's cursor.
function renderTorrents(list) {
  if (!torrentPanel) return;
  const before = torrentPanel.offsetHeight;

  for (const [id, row] of torrentRows) {
    if (list.some((torrent) => torrent.id === id)) continue;
    row.root.remove();
    torrentRows.delete(id);
  }

  for (const torrent of list) {
    let row = torrentRows.get(torrent.id);
    if (!row) {
      row = createTorrentRow(torrent);
      torrentRows.set(torrent.id, row);
      torrentPanel.append(row.root);
    }
    updateTorrentRow(row, torrent);
  }

  torrentPanel.style.display = list.length ? 'flex' : 'none';
  if (bottomBar && torrentPanel.offsetHeight !== before) resizeBar(bottomBar);
}


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

  // Empty until a magnet link is clicked, and hidden while it is.
  bottomBar = bar;
  torrentRows.clear();
  torrentPanel = document.createElement('div');
  Object.assign(torrentPanel.style, { display: 'none', flexDirection: 'column', gap: '8px' });

  const actions = document.createElement('div');
  Object.assign(actions.style, { display: 'flex', alignItems: 'center', gap: '8px' });
  actions.append(
    createTile('← Back', () => ipcRenderer.send('inspect-go-back')),
    createSearchButton('Download Content', 'inspect-search', true),
    createSearchButton('Download Subtitle', 'subtitle-search', false),
    ...createLibraryTiles(),
    settingsToggle
  );

  // A second pass over the same page rebuilds the bar, so the old listener goes.
  ipcRenderer.removeAllListeners('download-status');
  ipcRenderer.removeAllListeners('torrent-progress');
  ipcRenderer.removeAllListeners('subtitle-downloaded');
  ipcRenderer.on('download-status', (event, payload) => showStatus(payload.text, payload.failed));
  ipcRenderer.on('subtitle-downloaded', (event, payload) => openSubtitleModal(payload.archive, payload.name));
  ipcRenderer.on('torrent-progress', (event, list) => renderTorrents(list));

  // A page load rebuilds the bar, so downloads already running are asked for
  // rather than waiting for the next tick to reappear.
  ipcRenderer.invoke('get-torrents').then(renderTorrents);

  left.append(actions, torrentPanel);

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
  .lg-head { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
  .lg-path { color: #999; font-size: 12px; word-break: break-all; }
  .lg-up {
    padding: 6px 12px; font: 600 12px/1.4 Arial, Helvetica, sans-serif;
    color: #000; background: #f5c518; border: none; border-radius: 4px; cursor: pointer;
  }
  .lg-up[disabled] { opacity: 0.45; cursor: default; }
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

// Where the gallery is currently pointed, so a folder that appears while it is
// open — a finished torrent, say — can be drawn without a navigation.
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
      const cell = galleryCard(entry, async () => {
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
      }, async () => {
        const result = await ipcRenderer.invoke('delete-library-entry', entry.path);
        if (result.ok) {
          // The listing changed underneath us, so redraw this folder.
          renderGallery(root, listing.path);
        } else if (result.reason !== 'canceled') {
          pathText.className = 'lg-error';
          pathText.textContent = `Could not delete ${entry.name} (${result.message || result.reason}).`;
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
  // A torrent finishing adds a folder the listing has never seen, which
  // needs the whole listing again rather than only its progress bars.
  ipcRenderer.on('library-changed', () => renderGallery(galleryRoot, galleryDir));
  galleryRoot = root;
  renderGallery(root, '');
}

// --- Missing requirements ------------------------------------------------
// ffmpeg, ffprobe and VLC are kept in the project's vendor folder rather than
// installed on the machine. When any of them is absent this page takes over,
// downloads what is missing, and hands the window back to the app. Nothing
// else is rendered, so there is nothing to click while it runs.

const BLOCKED_STYLE = `
  .bl-wrap { max-width: 640px; padding: 64px 32px; margin: 0 auto; }
  .bl-title { margin: 0 0 12px; font-size: 20px; color: #f5c518; }
  .bl-text { margin: 0 0 24px; color: #ccc; }
  .bl-list { margin: 0 0 24px; padding: 0; list-style: none; color: #eee; }
  .bl-item { margin: 0 0 18px; }
  .bl-what { color: #999; font-size: 13px; }
  .bl-status { margin-top: 4px; color: #999; font-size: 13px; }
  .bl-status.is-done { color: #7ec87e; }
  .bl-status.is-failed { color: #e07a7a; }
  .bl-bar {
    height: 4px; margin-top: 8px; border-radius: 2px;
    background: #2f2f2f; overflow: hidden;
  }
  .bl-fill { height: 100%; width: 0; background: #f5c518; transition: width 120ms linear; }
  .bl-cmd {
    display: block; margin-top: 8px; padding: 8px 10px;
    font: 400 13px/1.4 Menlo, Consolas, monospace; color: #f5c518;
    background: #1e1e1e; border: 1px solid #2f2f2f; border-radius: 4px; user-select: all;
  }
  .bl-hint { margin: 0 0 24px; color: #777; font-size: 12px; }
  .bl-button {
    padding: 8px 16px; font: 600 13px/1.4 Arial, Helvetica, sans-serif;
    color: #000; background: #f5c518; border: none; border-radius: 4px; cursor: pointer;
  }
  .bl-button[disabled] { opacity: 0.5; cursor: default; }
`;

// What each tool is for, and the one command that installs it by hand should
// the download keep failing.
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
  }
};

const megabytes = (bytes) => `${(bytes / 1e6).toFixed(0)} MB`;

function startBlocked(root) {
  const style = document.createElement('style');
  style.textContent = BLOCKED_STYLE;
  document.head.append(style);

  const wrap = document.createElement('div');
  wrap.className = 'bl-wrap';

  const title = document.createElement('h1');
  title.className = 'bl-title';
  title.textContent = 'Setting up';

  const text = document.createElement('p');
  text.className = 'bl-text';
  text.textContent = 'These are downloaded into the app\u2019s own vendor folder, not installed '
    + 'on this machine. It runs once and takes a few minutes.';

  const list = document.createElement('ul');
  list.className = 'bl-list';

  const hint = document.createElement('p');
  hint.className = 'bl-hint';
  hint.hidden = true;

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'bl-button';
  retry.textContent = 'Retry';
  retry.hidden = true;

  // One row per missing tool, kept by name so progress can find its own line.
  const rows = new Map();

  const showMissing = (missing) => {
    list.textContent = '';
    rows.clear();

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

      const status = document.createElement('div');
      status.className = 'bl-status';
      status.textContent = 'waiting';

      const bar = document.createElement('div');
      bar.className = 'bl-bar';
      const fill = document.createElement('div');
      fill.className = 'bl-fill';
      bar.append(fill);

      item.append(heading, what, status, bar);
      list.append(item);
      rows.set(name, { status, fill, command: guide.command });
    }
  };

  const setStatus = (name, message, { ratio = null, state = '' } = {}) => {
    const row = rows.get(name);
    if (!row) return;

    row.status.textContent = message;
    row.status.className = `bl-status${state ? ` is-${state}` : ''}`;
    if (ratio !== null) row.fill.style.width = `${Math.round(ratio * 100)}%`;
  };

  // Every phase the vendor download reports, turned into one line of text.
  ipcRenderer.on('dependency-progress', (event, info) => {
    if (info.phase === 'start') setStatus(info.name, 'starting', { ratio: 0 });
    else if (info.phase === 'lookup') setStatus(info.name, 'finding the latest build');
    else if (info.phase === 'download') {
      const label = info.total
        ? `downloading \u00b7 ${megabytes(info.received)} of ${megabytes(info.total)}`
        : `downloading \u00b7 ${megabytes(info.received)}`;
      setStatus(info.name, label, { ratio: info.total ? info.received / info.total : null });
    } else if (info.phase === 'verify') setStatus(info.name, 'checking the download', { ratio: 1 });
    else if (info.phase === 'install') setStatus(info.name, 'unpacking', { ratio: 1 });
    else if (info.phase === 'done') setStatus(info.name, 'ready', { ratio: 1, state: 'done' });
    else if (info.phase === 'failed') setStatus(info.name, `failed \u00b7 ${info.message}`, { ratio: 0, state: 'failed' });
  });

  // Anything that could not be fetched falls back to the manual route, with
  // the commands that install it by hand.
  const showFallback = (failures) => {
    hint.textContent = 'Some of it could not be downloaded. Check the connection and retry, '
      + 'or install by hand: '
      + failures.map((failure) => (INSTALL_GUIDE[failure.name] || {}).command)
        .filter(Boolean).filter((cmd, i, all) => all.indexOf(cmd) === i).join(' and ')
      + '.';
    hint.hidden = false;
    retry.hidden = false;
  };

  // The window is handed back to the app by the main process as soon as
  // nothing is missing, so a clean run ends this page on its own.
  const install = async () => {
    retry.disabled = true;
    hint.hidden = true;

    const result = await ipcRenderer.invoke('install-dependencies');
    if (!result.missing.length) return;

    showMissing(result.missing);
    for (const failure of result.failures) {
      setStatus(failure.name, `failed \u00b7 ${failure.message}`, { state: 'failed' });
    }
    showFallback(result.failures.length ? result.failures : result.missing.map((name) => ({ name })));
    retry.disabled = false;
  };

  retry.addEventListener('click', install);

  showMissing((new URLSearchParams(location.search).get('missing') || '').split(',').filter(Boolean));
  wrap.append(title, text, list, hint, retry);
  root.append(wrap);

  install();
}

function start() {
  const blockedRoot = document.getElementById(BLOCKED_ROOT_ID);
  if (blockedRoot) {
    startBlocked(blockedRoot);
    return;
  }

  createTopBar();
  createBottomBar();
  showLocation(location.href);

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

  const galleryRoot = document.getElementById(GALLERY_ROOT_ID);
  if (galleryRoot) {
    startGallery(galleryRoot);
    return;
  }

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
