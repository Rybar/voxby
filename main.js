// Voxby entry point. Wires the file/transport bar against engine.js plus the
// vendored player.js/jammer.js/presets.js/rle.js/third_party globals (see
// index.html's script order for why those stay classic scripts), and
// initializes the instrument, tracker, keyboard and scope panels.
//
// The directory, the /soundbox/ dev-server route, the window.soundbox test hook
// and the localStorage keys all still say "soundbox": none of them is
// user-visible, and renaming the storage keys would silently discard everyone's
// saved preferences.
//
// Playback renders the whole selection with CPlayer and plays the result through
// one AudioBufferSourceNode; panels/tracker.js's followPlayback() moves the grid
// cursors along with it. Saving is Export JS -- a real file, re-importable --
// rather than the bookmarkable data: URL SoundBox used, and it doubles as save
// by clearing the unsaved-changes flag.

import * as engine from './engine.js';
import * as scales from './scales.js';
import * as sfx from './sfx.js';
import { state, markClean, isDirty, saveAutosave, loadAutosave, clearAutosave,
  loadPresetLibrary, savePresetLibrary, legacyUserPresets } from './state.js';
import { audioContext, masterGain } from './audio.js';
import { svgIcon } from './icons.js';
import { initInstrumentPanel, refreshInstrumentPanel, setPresetPreview, clearPresetPreview, commitPresetPreview, previewInstrI } from './panels/instrument.js';
import { initTrackerPanel, refreshTrackerPanel, followPlayback, stopFollowingPlayback, getPlayRange, setFollowRange, noteKeys } from './panels/tracker.js';
import { followPlaybackPianoRoll, stopFollowingPianoRoll, refreshPianoRoll } from './panels/pianoroll.js';
import { followPlaybackDrums, stopFollowingDrums, rediscoverKit } from './panels/drums.js';
import { initKeyboardPanel, refreshKeyboardPanel, previewNote, previewNoteAbsolute, syncJammer, highlightPlaybackNotes, getJammer, auditionNote } from './panels/keyboard.js';
import { initScopePanel, drawScope, getLastPeak } from './panels/scope.js';
import { initLayout } from './panels/layout.js';
import { initTheme } from './theme.js';
import { keyHandledByFocus } from './focus.js';
import { openMenu } from './menu.js';
import { DEMO_SONGS, SECTIONS } from './songs/index.js';

// console/automation access, mirroring tools/scenetool/main.js's
// `window.scenetool = {...}` hook. getJammer exposed for tests to confirm
// the jammer is actually producing samples without depending on canvas-pixel
// heuristics. getAudioState exposes the shared
// audioContext's .state so tests can confirm the startup gate actually
// resumed it, without importing audio.js themselves. getPlayRange is what Space
// is about to play, which a test can read without waiting on a render.
// refreshPianoRoll repaints the roll after a state write: nothing draws it on a
// timer, so a script that sets a cursor or a selection would otherwise capture
// the frame before its own edit (scripts/help-shots.mjs did exactly that).
// refreshInstrument is exposed for the same reason as refreshPianoRoll: a
// script that writes an instrument byte into state directly needs a way to
// ask the panel to re-derive itself, since nothing repaints it on a timer.
window.soundbox = { state, engine, scales, sfx, loadSong, loadDemoSong, DEMO_SONGS, importSongFile, getJammer, getPlayRange, refreshPianoRoll, refreshInstrument: refreshInstrumentPanel, previewInstrumentI: previewInstrI, buildSfxSong, getAudioState: () => audioContext.state };

const $ = id => document.getElementById(id);

// Native browser download (replaces FileSaver.js)
const downloadFile = (blob, filename) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
};

// The one required user gesture that unlocks audioContext (see audio.js) for
// both the jammer and rendered song playback. A dedicated non-dismissible
// overlay rather than the generic #picker modal: there is nothing to do in here
// until it has been answered.
$('audio-gate-start').onclick = () => {
  audioContext.resume();
  $('audio-gate').classList.add('closed');
};

for (const [id, icon] of Object.entries({
  'new-song': 'newDoc', 'open-song': 'open', 'export-js': 'download',
  'export-wav': 'download', 'share-song': 'link', 'play-song': 'play', 'play-selected': 'playSel',
  'stop-song': 'stop', 'help-btn': 'help', 'about-btn': 'about',
})) $(id).insertAdjacentHTML('afterbegin', svgIcon(icon) + ' ');

// Its own tab, so a song in progress isn't navigated away from.
$('help-btn').onclick = () => window.open('help.html', '_blank', 'noopener');

function refresh() {
  const s = state.song;
  $('status').textContent =
    `${s.numChannels} channels · ${s.patternLen} rows/pattern · ${s.endPattern} sequence steps`;
  // Here, not only at boot: the autosave restore below sets state.viewMode
  // after the select was first populated, and loadSong() can change it too.
  $('view-mode').value = state.viewMode;
  refreshInstrumentPanel();
  refreshTrackerPanel();
  refreshKeyboardPanel();
  syncJammer();
  saveAutosave();
}
// The tracker panel calls this after any cursor move or edit that isn't itself a
// full song load (a state.song reassignment already goes through loadSong() ->
// refresh()). It keeps the instrument panel's FX-cell preview and the status line
// in sync without an import cycle between panels/instrument.js and
// panels/tracker.js.
state.notify = refresh;
// Lets tracker.js live-preview piano-key note entry through keyboard.js's jammer
// without importing keyboard.js (see state.js's comment on this field for why
// that import would close a cycle).
state.previewNote = previewNote;
// Lets panels/drums.js audition a lane's own drum pitch (see state.js).
state.previewAbs = previewNoteAbsolute;
// Lets tracker.js's followPlayback() light up the on-screen keys currently
// sounding during song playback -- a callback rather than a direct import, for
// the same reason.
state.highlightNotes = highlightPlaybackNotes;
// The key -> semitone-offset map in force (scale layout, chord follow, or the
// plain chromatic table), for panels/pianoroll.js. tracker.js already imports
// pianoroll.js, so the piano roll asking for it directly would close a cycle --
// and before this it kept a chromatic copy of its own, which wrote a different
// note than the key the on-screen keyboard was showing whenever a scale was set.
state.noteKeys = noteKeys;
// Lets panels/instrument.js's Presets button open the shared #picker modal
// without importing main.js back (see state.js's comment on this field).
state.openPresets = openPresetsDialog;
state.openSfx = openSfxDialog;
// Lets panels/drums.js ask before a Stamp replaces a beat (see state.js).
state.confirm = confirmModal;

function loadSong(song, skipAutosave = false) {
  state.song = song;
  // The drum kit map describes the song that was open, so it cannot survive
  // one being replaced. rediscoverKit() reads a new one back out of the
  // instruments the incoming song actually uses, which is what lets a library
  // song or a shared link open straight into the drums view (see
  // panels/drums.js's findKit).
  rediscoverKit();
  markClean();
  refresh();
  if (skipAutosave) clearAutosave();
}

// --- generic modal shell, reused for the open-song picker, the about and
// share dialogs, and the confirm/notice prompts below ---
// `onClose` runs whenever the modal goes away by any route the user has --
// its own Cancel button, the backdrop, or Escape. confirmModal() needs that
// to settle its promise on the paths that aren't its own button; without it
// a dismissed prompt would leave the caller awaiting forever.
//
// A dialog opened *over* one that is already up counts as a dismissal of the
// one it replaces, so its onClose runs here too. Without that, any nested
// dialog -- Play's progress bar, an import notice, About -- silently dropped
// the callback of whatever it covered: the presets dialog leaked its staged
// preview that way, leaving the instrument panel showing a phantom
// instrument that snapped its sliders back on the next refresh. A dialog
// that rebuilds itself and means to keep its state across the rebuild
// (openPresetsDialog) has to re-apply it afterwards.
let modalOnClose = null;
function openModal(bodyHTML, onClose = null) {
  const prev = modalOnClose;
  modalOnClose = onClose;
  prev && prev();
  $('picker-body').innerHTML = bodyHTML;
  $('picker').classList.add('open');
}
function closeModal() {
  $('picker').classList.remove('open');
  // The body is emptied, not just hidden: markup left behind means
  // #ask-ok/#picker-cancel/#gen-bar still resolve, with live handlers, long after
  // the dialog they belong to is gone.
  $('picker-body').innerHTML = '';
  const cb = modalOnClose;
  modalOnClose = null;
  cb && cb();
}

// The editor's own confirm/notice prompts. A native confirm()/alert() renders in
// the browser's light chrome, prefixed with the origin ("localhost:8787 says"),
// and blocks the renderer outright -- in a dark full-screen tool it reads as
// something having gone wrong. These are the same #picker panel as every other
// dialog: themed, dismissible the same three ways, and they don't freeze
// playback. The cost is that they're asynchronous, hence the awaits at the call
// sites.
function confirmModal(heading, message, okLabel) {
  return new Promise(resolve => {
    // Guarded because closeModal() fires onClose on *every* dismissal route,
    // including the one the OK button itself takes.
    let settled = false;
    const settle = v => { if (!settled) { settled = true; resolve(v); } };
    openModal(`<h3>${heading}</h3><p class="hint">${message}</p>
      <div class="row">
        <button id="ask-ok" title="${okLabel} — the current song is discarded">${okLabel}</button>
        <button id="picker-cancel" title="Keep the current song and close">Cancel</button>
      </div>`, () => settle(false));
    $('ask-ok').onclick = () => { settle(true); closeModal(); };
    $('picker-cancel').onclick = closeModal;
  });
}

// The render-progress dialog. Rendering a long song is genuinely slow -- the
// library's biggest tune is 6 channels over 2.5 minutes, and the worker
// allocates and walks a 50 MB Int32Array per channel -- so Play without one goes
// quiet for several seconds and reads as a broken button. The bar is driven by
// player-worker.js's own per-row progress messages.
//
// Nothing appears for the first PROGRESS_DELAY ms: an SFX or a short pattern
// renders in well under a frame, and a dialog that flashes up and vanishes on
// every Play would be worse than none.
const PROGRESS_DELAY = 200;
function progressModal(heading, hint, onCancel) {
  let opened = false, finished = false, pct = 0;
  const paint = () => {
    if (!opened) return;
    $('gen-bar').style.width = pct * 100 + '%';
    $('gen-pct').textContent = Math.round(pct * 100) + '%';
    $('gen-track').setAttribute('aria-valuenow', Math.round(pct * 100));
  };
  const timer = setTimeout(() => {
    // Another dialog opened inside the delay window (the top bar is still live
    // for those first few frames) -- leave it alone and render silently.
    if (finished || $('picker').classList.contains('open')) return;
    opened = true;
    openModal(`<h3>${heading}…</h3><p class="hint">${hint}</p>
      <div class="gen-row">
        <div class="gen-track" id="gen-track" role="progressbar"
             aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div id="gen-bar"></div></div>
        <span class="mono" id="gen-pct">0%</span>
      </div>
      <div class="row"><button id="picker-cancel" title="Stop rendering and go back to the song">Cancel</button></div>`,
      onCancel);
    $('picker-cancel').onclick = closeModal;
    paint();
  }, PROGRESS_DELAY);
  return {
    set(p) { pct = p; paint(); },
    // Closes without running onCancel -- this is the success path, and
    // closeModal() fires onClose on every route including this one.
    done() {
      finished = true;
      clearTimeout(timer);
      if (opened) { modalOnClose = null; closeModal(); opened = false; }
    },
  };
}

function noticeModal(heading, message) {
  openModal(`<h3>${heading}</h3><p class="hint">${message}</p>
    <div class="row"><button id="picker-cancel" title="Close">Close</button></div>`);
  $('picker-cancel').onclick = closeModal;
}

// Resolves true if it's safe to throw the current song away -- either nothing
// has changed since the last load/export, or the user said so.
function confirmDiscard(message) {
  return !isDirty() ? Promise.resolve(true)
    : confirmModal('Unsaved changes', message, 'Discard');
}
$('picker').onclick = e => { if (e.target.id === 'picker') closeModal(); };
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('picker').classList.contains('open')) closeModal();
});

// --- new / open ---
$('new-song').onclick = async () => {
  if (!await confirmDiscard('Starting a new song discards the one you have open. Export JS first if you want to keep it.')) return;
  loadSong(engine.makeNewSong(), true);
};

// Each library entry is fetched on click (a dynamic import — see songs/index.js
// for why) and run through normalizeSong, since those files are sparse exports
// exactly like anything else the importer takes.
async function loadDemoSong(entry) {
  const mod = await import(`./songs/${entry.file}`);
  return engine.normalizeSong(mod.default);
}

// Named so a discard prompt raised from inside it can put it back afterwards: the
// prompt reuses the same #picker panel, so without this, cancelling leaves you
// with no dialog at all rather than the song list you were choosing from.
function openSongDialog() {
  const columns = SECTIONS.map(section =>
    `<div class="pick-col">
       <div class="pick-section">${section}</div>` +
    DEMO_SONGS.filter(demo => demo.section === section).map(demo => {
      const idx = DEMO_SONGS.indexOf(demo);
      return `<div class="pick-card" data-i="${idx}" title="Load ${demo.name}">
         <div class="name">${demo.name}</div><div class="desc">${demo.desc}</div></div>`;
    }).join('') + '</div>'
  ).join('');
  openModal(`<h3>Open song</h3><div id="picker-grid">${columns}</div>
    <p class="hint">Or open a song you exported earlier (.js), an old sonant-x export,
      or a legacy binary song (.snd) — you can also just drag the file onto this page.
      <b>Imports run as code — only open files you trust.</b></p>
    <div class="row">
      <button id="import-file-btn" title="Open a .js song exported from Voxby or the old sonant-x editor (or a legacy binary .snd song)">Import file…</button>
      <button id="picker-cancel" title="Close without loading anything">Cancel</button>
    </div>
    <input id="import-file" type="file" accept=".js,.snd,text/javascript" hidden>`);
  $('picker-cancel').onclick = closeModal;
  $('import-file-btn').onclick = () => $('import-file').click();
  $('import-file').onchange = () => {
    const file = $('import-file').files[0];
    if (file) importSongFile(file);
  };
  for (const card of $('picker-grid').querySelectorAll('.pick-card')) {
    card.onclick = async () => {
      const entry = DEMO_SONGS[+card.dataset.i];
      if (!await confirmDiscard(`Loading ${entry.name} discards the song you have open.`)) {
        openSongDialog();
        return;
      }
      const song = await loadDemoSong(entry).catch(() => undefined);
      if (!song) { noticeModal('Could not open', `${entry.name} failed to load.`); return; }
      stopSong();
      loadSong(song, true);
      closeModal();
    };
  }
}
$('open-song').onclick = openSongDialog;

// --- import a song file ---
// Two routes, picked by extension/MIME: a .js file exported by this editor
// goes through engine.songFromJS() (which evaluates it as a real ES module
// -- hence the trust warning in the open dialog and on the drop overlay),
// anything else is tried as one of the legacy binary formats binToSong()
// understands.
// Either way the load follows the same sequence as the demo-song picker
// above: unsaved-changes confirm, stop playback, swap the song in, refresh,
// re-snapshot (loadSong -> markClean).
async function readBinaryString(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

async function importSongFile(file) {
  if (!await confirmDiscard(`Loading ${file.name} discards the song you have open.`)) return;
  let song;
  try {
    song = /\.js$/i.test(file.name) || /javascript/.test(file.type)
      ? await engine.songFromJS(await file.text())
      : engine.binToSong(await readBinaryString(file));
  } catch {
    song = undefined;  // a truncated/garbage binary can throw its way out of the parser
  }
  if (!song) {
    noticeModal('Could not open', `${file.name} isn't a song file this editor recognizes — it takes
      a .js export from Voxby or the old sonant-x editor, or a legacy binary .snd song.`);
    return;
  }
  stopSong();
  loadSong(song, true);
  closeModal();
}

// Drag-and-drop, with a full-page overlay while a file is over the window --
// nothing else in the UI advertises that the page takes drops. dragenter/
// dragleave fire per element as the pointer crosses child boundaries, so the
// overlay is refcounted rather than toggled.
let dragDepth = 0;
const setDragging = on => document.getElementById('drop-hint').classList.toggle('open', on);
document.addEventListener('dragenter', e => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  if (++dragDepth === 1) setDragging(true);
});
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; setDragging(false); } });
document.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
document.addEventListener('drop', e => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  dragDepth = 0;
  setDragging(false);
  const file = e.dataTransfer.files[0];
  if (file) importSongFile(file);
});

// --- instrument presets ---
// One editable library, held in localStorage (state.js's
// loadPresetLibrary/savePresetLibrary): a flat list of {name, i, set,
// category} presets plus a list of {set, name} categories kept separately so
// an empty category can exist to drag presets into.
//
// Every preset is editable, the SoundBox built-ins included -- presets.js's
// window.gInstrumentPresets (a classic script global, see index.html's script
// order) is only ever *read*, to seed the library on first open and to re-seed
// it from the Restore button. That flat array marks a category with an entry
// carrying only `name` and no `i` (its own "====[LEADS]===="-style headings).
//
// The dialog lays out as two columns: the SoundBox set on the left, every
// other set on the right, which is where new presets and categories get added.
// Export/Import carry the set/category tags, so an exported library rebuilds
// its own organization -- this dialog's own files, unrelated to the song-level
// Export JS/WAV buttons above, which never touch instrument presets.
const BUILTIN_SET = 'SoundBox';
const DEFAULT_SET = 'Custom', DEFAULT_CATEGORY = 'General';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// presets.js flattened into this dialog's own shape. The `i` arrays are copied
// rather than referenced: they land in localStorage and become editable, and
// the originals have to stay pristine for Restore to mean anything.
function builtinPresets() {
  const out = [];
  let category = DEFAULT_CATEGORY;
  for (const p of window.gInstrumentPresets) {
    if (!p.i) category = p.name.replace(/^=+\[|\]=+$/g, '') || DEFAULT_CATEGORY;
    else out.push({ name: p.name, i: p.i.slice(), set: BUILTIN_SET, category });
  }
  return out;
}

// The library, seeded on first ever open. Presets saved under the older
// storage shape (user presets only, before built-ins became editable) are
// carried across into the Custom set rather than dropped.
function ensureLibrary() {
  let lib = loadPresetLibrary();
  if (!lib) {
    const carried = legacyUserPresets().map(normalizeImportedPreset).filter(Boolean);
    lib = { presets: builtinPresets().concat(carried), categories: [] };
    savePresetLibrary(lib);
  }
  return lib;
}

const setOf = p => p.set || DEFAULT_SET;
const categoryOf = p => p.category || DEFAULT_CATEGORY;

// Sets and categories in insertion order rather than sorted: the built-ins
// arrive in presets.js's own deliberate order (leads, pads, drums, F/X), and a
// preset dragged somewhere should stay where it was put.
function groupPresets(lib) {
  const sets = new Map();
  const set = name => {
    if (!sets.has(name)) sets.set(name, new Map());
    return sets.get(name);
  };
  // Explicit categories first, so an empty one still renders (and renders
  // in the order it was created, above whatever a later drag adds).
  for (const c of lib.categories) set(c.set).set(c.name, []);
  lib.presets.forEach((p, idx) => {
    const cats = set(setOf(p)), name = categoryOf(p);
    if (!cats.has(name)) cats.set(name, []);
    cats.get(name).push({ p, idx });
  });
  return [...sets.entries()].map(([name, cats]) => ({
    name,
    categories: [...cats.entries()].map(([name, entries]) => ({ name, entries })),
  }));
}

// Validates a preset against engine.js's fixed instrument shape -- a preset is
// plain data, never evaluated, but a wrong-length or out-of-range `i` array
// would still corrupt whatever channel it gets loaded into. Values clamp to a
// byte: every instrument property is stored as one (see engine.js's
// binToInstrument/instrumentToBin), even where a param's own UI range is
// narrower (e.g. LFO_FREQ's slider tops out at 16). A missing set/category
// defaults the same way saving does, so a file from an older export -- or the
// legacy storage key ensureLibrary carries across -- still lands somewhere.
function normalizeImportedPreset(p) {
  if (!p || typeof p.name !== 'string' || !Array.isArray(p.i) || p.i.length !== engine.NUM_INSTR_PARAMS) return null;
  return {
    name: p.name.slice(0, 60) || 'Untitled',
    i: p.i.map(v => Math.max(0, Math.min(255, +v | 0))),
    set: (typeof p.set === 'string' && p.set.trim().slice(0, 40)) || DEFAULT_SET,
    category: (typeof p.category === 'string' && p.category.trim().slice(0, 40)) || DEFAULT_CATEGORY,
  };
}

// Take the library, change it, write it back. The SFX dialog files a rolled
// sound through this one: it is not the presets dialog, and must not be
// replaced by it mid-session.
function saveIntoLibrary(fn) {
  const lib = ensureLibrary();
  fn(lib);
  savePresetLibrary(lib);
}

// Every mutation *from the presets dialog* goes through here: the same write,
// then a rebuild. Rebuilding wholesale rather than patching the DOM keeps one
// code path for "what the picker shows" -- the dialog is cheap, and a
// drag/rename/delete each otherwise needs its own incremental update.
function editLibrary(fn) {
  saveIntoLibrary(fn);
  openPresetsDialog();
}

function renameCategory(setName, oldName, newName) {
  newName = newName.trim().slice(0, 40);
  if (!newName || newName === oldName) { openPresetsDialog(); return; }
  editLibrary(lib => {
    for (const p of lib.presets) if (setOf(p) === setName && categoryOf(p) === oldName) p.category = newName;
    for (const c of lib.categories) if (c.set === setName && c.name === oldName) c.name = newName;
  });
}

function renameSet(oldName, newName) {
  newName = newName.trim().slice(0, 40);
  if (!newName || newName === oldName) { openPresetsDialog(); return; }
  editLibrary(lib => {
    for (const p of lib.presets) if (setOf(p) === oldName) p.set = newName;
    for (const c of lib.categories) if (c.set === oldName) c.set = newName;
  });
}

function renamePreset(idx, newName) {
  newName = newName.trim().slice(0, 60);
  if (!newName) { openPresetsDialog(); return; }
  editLibrary(lib => { lib.presets[idx].name = newName; });
}

// Names the thing to inline-rename as soon as the rebuilt dialog is on screen
// -- '.preset-row[data-idx="3"]', a category header, a set header. Adding
// either a preset or a category is really "make it, then name it", and the
// rebuild in between is what would otherwise lose the cursor.
let renameOnOpen = null;

// Turns a name span into an inline text field, committing on Enter/blur and
// discarding on Escape -- renaming one string doesn't need a dialog of its
// own. `commit` re-invokes openPresetsDialog() by way of editLibrary (even on
// a no-op rename), so this never has to.
function startRename(label, commit) {
  if (!label) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename-input';
  input.maxLength = 60;
  input.value = label.textContent;
  input.onclick = e => e.stopPropagation();
  input.ondblclick = e => e.stopPropagation();
  input.onkeydown = e => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); input.dataset.cancel = '1'; input.blur(); }
  };
  input.onblur = () => { input.dataset.cancel ? openPresetsDialog() : commit(input.value); };
  label.replaceWith(input);
  input.focus();
  input.select();
}

// Collapse state (native <details>'s own `open` attribute) survives a
// same-session rebuild -- every edit re-invokes openPresetsDialog(), and
// re-expanding a set you had tucked away on each one would be exhausting.
// Keyed by set name, module-level rather than in state.js: purely this
// dialog's own view preference, not worth persisting past a reload.
const collapsedSets = new Set();

// Which preset is staged (previewed + highlighted), as its index into
// lib.presets, or -1. Module-level for the same reason, and reset only on a
// real dialog dismissal -- see openPresetsDialog's onClose.
let stagedIdx = -1;

function presetRowHTML(name, idx, staged) {
  return `<div class="preset-row${staged ? ' active' : ''}" data-idx="${idx}" draggable="true"
    title="Click to preview — plays at C5 through this channel. Drag it onto another category to file it there; double-click its name to rename it.">
    <span class="name">${escapeHtml(name)}</span>
    <button class="preset-del" type="button" title="Delete this preset">×</button>
  </div>`;
}

function categoryHTML(setName, cat) {
  return `<div class="preset-cat" data-set="${escapeHtml(setName)}" data-cat="${escapeHtml(cat.name)}">
    <div class="pick-section" title="Category — double-click to rename it. Drop a preset here to file it under this category.">
      <span class="cat-name">${escapeHtml(cat.name)}</span>
    </div>
    <div class="preset-list">${cat.entries.map(({ p, idx }) => presetRowHTML(p.name, idx, idx === stagedIdx)).join('')}</div>
    ${setName === BUILTIN_SET ? '' :
      `<button class="add-preset-btn" type="button"
         title="Save this channel's current instrument as a new preset in this category">+ Add preset</button>`}
  </div>`;
}

function setHTML(set) {
  const key = set.name;
  return `<details class="preset-set" data-set="${escapeHtml(key)}" ${collapsedSets.has(key) ? '' : 'open'}>
    <summary title="${key === BUILTIN_SET
      ? 'The SoundBox built-in instruments. Editable like any other set — Restore below puts them back.'
      : 'A set of your own presets — double-click its name to rename it.'}">
      <span class="set-name">${escapeHtml(key)}</span>
      <button class="export-set-btn" type="button" title="Export just this set as a .json file">Export</button>
    </summary>
    <div class="preset-set-body">${set.categories.map(cat => categoryHTML(key, cat)).join('')}</div>
  </details>`;
}

function openPresetsDialog() {
  const lib = ensureLibrary();
  const sets = groupPresets(lib);
  const builtinSets = sets.filter(s => s.name === BUILTIN_SET);
  const customSets = sets.filter(s => s.name !== BUILTIN_SET);

  // The custom column always renders something to add into, even with an
  // empty library: an "Add preset" button needs a category to land in, and
  // there is no way to make the first one without one already on screen.
  const customHTML = customSets.length ? customSets.map(setHTML).join('')
    : setHTML({ name: DEFAULT_SET, categories: [{ name: DEFAULT_CATEGORY, entries: [] }] });

  // openModal below treats being replaced as a dismissal and runs the onClose
  // this function installed last time, which clears the staged preview. That
  // is right for any *other* dialog opening over this one, and wrong for this
  // dialog rebuilding itself after an edit -- so the staged preset is carried
  // across the rebuild by hand, and dropped if whatever it pointed at is gone.
  const keepStaged = stagedIdx;

  openModal(`<h3>Instrument presets</h3>
    <div id="picker-grid" class="preset-grid">
      <div class="preset-col" data-col="builtin">${builtinSets.map(setHTML).join('')}</div>
      <div class="preset-col" data-col="custom">${customHTML}</div>
    </div>
    <p class="hint">Click a preset to preview it — it plays at C5 through this channel, and your keyboard
      still plays it too. Drag presets between categories; right-click for Add category.</p>
    <div class="row">
      <button id="preset-use" disabled title="Load the previewed preset into this channel, overwriting every instrument setting">Use this preset</button>
      <button id="preset-import-btn" title="Add presets from a .json file exported below, or shared by someone else — their set/category tags come along with them">Import…</button>
      <button id="preset-export" title="Download the whole library as one .json file, with every set/category tag intact">Export all</button>
      <button id="preset-restore" title="Put the SoundBox built-in presets back the way they shipped. Your own sets are left alone.">Restore Voxby presets</button>
    </div>
    <input id="preset-import-file" type="file" accept=".json,application/json" hidden>`,
    () => { stagedIdx = -1; clearPresetPreview(); });

  stagedIdx = keepStaged >= 0 && lib.presets[keepStaged] ? keepStaged : -1;
  if (stagedIdx >= 0) setPresetPreview(lib.presets[stagedIdx].i, lib.presets[stagedIdx].name);
  else clearPresetPreview();

  const grid = $('picker-grid');
  const presetAt = el => +el.closest('.preset-row').dataset.idx;

  for (const details of grid.querySelectorAll('.preset-set')) {
    details.addEventListener('toggle', () => {
      details.open ? collapsedSets.delete(details.dataset.set) : collapsedSets.add(details.dataset.set);
    });
  }

  $('preset-use').disabled = stagedIdx < 0;

  // --- click: preview/stage, delete, per-set export, add preset ---
  grid.onclick = e => {
    if (e.target.closest('.rename-input')) return;

    if (e.target.closest('.preset-del')) {
      const idx = presetAt(e.target);
      // Staging survives a rebuild by index, so deleting anything above the
      // staged preset would otherwise leave the highlight on its neighbour.
      stagedIdx = -1;
      clearPresetPreview();
      editLibrary(lib => { lib.presets.splice(idx, 1); });
      return;
    }

    const addBtn = e.target.closest('.add-preset-btn');
    if (addBtn) {
      const cat = addBtn.closest('.preset-cat');
      const setName = cat.dataset.set, catName = cat.dataset.cat;
      editLibrary(lib => {
        lib.presets.push({
          name: 'New preset',
          i: state.song.songData[state.selInstrument].i.slice(),
          set: setName, category: catName,
        });
        renameOnOpen = `.preset-row[data-idx="${lib.presets.length - 1}"] .name`;
      });
      return;
    }

    const exportBtn = e.target.closest('.export-set-btn');
    if (exportBtn) {
      const setName = exportBtn.closest('.preset-set').dataset.set;
      const list = ensureLibrary().presets.filter(p => setOf(p) === setName);
      downloadFile(new Blob([JSON.stringify(list, null, 2)], { type: 'application/json' }),
        `voxby-presets-${setName}.json`);
      return;
    }

    const row = e.target.closest('.preset-row');
    if (row) {
      stagedIdx = +row.dataset.idx;
      for (const el of grid.querySelectorAll('.preset-row.active')) el.classList.remove('active');
      row.classList.add('active');
      const staged = ensureLibrary().presets[stagedIdx];
      setPresetPreview(staged.i, staged.name);
      auditionNote();
      $('preset-use').disabled = false;
    }
  };

  // --- double-click a name to rename it ---
  grid.ondblclick = e => {
    const catName = e.target.closest('.cat-name');
    if (catName) {
      const cat = catName.closest('.preset-cat');
      const setName = cat.dataset.set, current = cat.dataset.cat;
      startRename(catName, value => renameCategory(setName, current, value));
      return;
    }
    const setName = e.target.closest('.set-name');
    if (setName) {
      // Inside a <summary>, where a double-click would also toggle the
      // disclosure open and shut under the field being typed into.
      e.preventDefault();
      startRename(setName, value => renameSet(setName.textContent, value));
      return;
    }
    const presetName = e.target.closest('.preset-row .name');
    if (presetName) {
      const idx = presetAt(presetName);
      startRename(presetName, value => renamePreset(idx, value));
    }
  };

  // --- right-click: add a category to the set clicked in ---
  grid.oncontextmenu = e => {
    const set = e.target.closest('.preset-set');
    if (!set) return;
    e.preventDefault();
    const setName = set.dataset.set;
    openMenu(e.clientX, e.clientY, [{
      label: 'Add category',
      run: () => editLibrary(lib => {
        let name = 'New category', n = 2;
        const taken = new Set(lib.presets.filter(p => setOf(p) === setName).map(categoryOf)
          .concat(lib.categories.filter(c => c.set === setName).map(c => c.name)));
        while (taken.has(name)) name = `New category ${n++}`;
        lib.categories.push({ set: setName, name });
        renameOnOpen = `.preset-cat[data-cat="${name}"] .cat-name`;
      }),
    }]);
  };

  // --- drag a preset onto a category to file it there ---
  let dragIdx = -1;
  grid.ondragstart = e => {
    const row = e.target.closest('.preset-row');
    if (!row) return;
    dragIdx = +row.dataset.idx;
    row.classList.add('dragging');
    // Required for Firefox to start a drag at all; the payload itself is
    // unused, since dragIdx above is what the drop reads.
    e.dataTransfer.setData('text/plain', String(dragIdx));
    e.dataTransfer.effectAllowed = 'move';
  };
  grid.ondragend = () => {
    dragIdx = -1;
    for (const el of grid.querySelectorAll('.dragging, .drop-target')) el.classList.remove('dragging', 'drop-target');
  };
  grid.ondragover = e => {
    const cat = e.target.closest('.preset-cat');
    if (dragIdx < 0 || !cat) return;
    // preventDefault is what makes an element a valid drop target at all.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    for (const el of grid.querySelectorAll('.drop-target')) el.classList.remove('drop-target');
    cat.classList.add('drop-target');
  };
  grid.ondrop = e => {
    const cat = e.target.closest('.preset-cat');
    if (dragIdx < 0 || !cat) return;
    e.preventDefault();
    const idx = dragIdx, setName = cat.dataset.set, catName = cat.dataset.cat;
    dragIdx = -1;
    editLibrary(lib => {
      const p = lib.presets[idx];
      if (!p) return;
      p.set = setName;
      p.category = catName;
    });
  };

  // --- footer ---
  $('preset-use').onclick = () => {
    // The name goes with it, for the instrument panel's provenance readout.
    const staged = ensureLibrary().presets[stagedIdx];
    commitPresetPreview(staged && staged.name);
    stagedIdx = -1;
    closeModal();
  };

  $('preset-export').onclick = () => {
    const list = ensureLibrary().presets;
    if (!list.length) return;
    downloadFile(new Blob([JSON.stringify(list, null, 2)], { type: 'application/json' }), 'voxby-presets.json');
  };

  $('preset-restore').onclick = () => {
    stagedIdx = -1;
    clearPresetPreview();
    editLibrary(lib => {
      lib.presets = lib.presets.filter(p => setOf(p) !== BUILTIN_SET).concat(builtinPresets());
      lib.categories = lib.categories.filter(c => c.set !== BUILTIN_SET);
    });
  };

  $('preset-import-btn').onclick = () => $('preset-import-file').click();
  $('preset-import-file').onchange = async () => {
    const file = $('preset-import-file').files[0];
    if (!file) return;
    let data;
    try { data = JSON.parse(await file.text()); } catch { data = null; }
    const imported = (Array.isArray(data) ? data : [data]).map(normalizeImportedPreset).filter(Boolean);
    if (!imported.length) {
      noticeModal('Could not import', `${file.name} isn't a preset file this editor recognizes — it takes a
        .json file exported from this dialog, holding either one preset or a list of them.`);
      return;
    }
    editLibrary(lib => { lib.presets = lib.presets.concat(imported); });
  };

  // Something just added (a preset, a category) opens straight into its
  // rename field -- see renameOnOpen.
  if (renameOnOpen) {
    const target = grid.querySelector(renameOnOpen);
    const selector = renameOnOpen;
    renameOnOpen = null;
    if (target) {
      if (selector.includes('.cat-name')) {
        const cat = target.closest('.preset-cat');
        startRename(target, value => renameCategory(cat.dataset.set, cat.dataset.cat, value));
      } else {
        const idx = presetAt(target);
        startRename(target, value => renamePreset(idx, value));
      }
    }
  }
}

// --- SFX helper ---
// A workshop for single sounds rather than music: pick an archetype, roll it,
// listen, roll again, and leave with either a preset or a one-note .js file.
//
// It writes nothing into the open song. Each roll is auditioned through the
// same staged preview the presets dialog uses (panels/instrument.js's
// setPresetPreview) -- the sliders show what you are hearing and the keyboard
// plays it, but the channel's real instrument is untouched and comes back when
// the dialog closes. That is what makes rolling forty times cost nothing.
//
// The recipes and the rolling live in sfx.js; read the comment at the top of
// that file for why a uniform roll of all 29 parameters is not worth building.
const SFX_CATEGORY = 'SFX';
const SFX_HISTORY_MAX = 8;

// The lowest and highest octaves the note picker offers, matching the
// on-screen keyboard's own range in panels/keyboard.js.
const SFX_OCT_MIN = 1, SFX_OCT_MAX = 8;
const SFX_NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// The dialog's own state, module-level for the same reason stagedIdx above is:
// a roll has to survive the dialog rebuilding itself around it.
let sfxRecipe = 0, sfxNote = 5 * 12 + engine.NOTE_OFFSET; // C-5, the audition pitch
let sfxLocked = new Set(), sfxCurrent = null, sfxHistory = [];

// A filename, not a display name: the same shape every other tool in this repo
// writes into src/js/, so the download drops straight in beside tada.js.
function sfxFileName(name) {
  const clean = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (clean || 'sfx') + '.js';
}

// The exported song: one channel, one pattern, one note at row 0.
//
// patternLen is computed rather than left at 32 because it is the one thing
// that can make the file sound different from the tool. Too short and the
// render cuts the tail off (sfx.js's soundLengthSamples explains the delay
// half); too long and every consumer of the file pays for silence, since
// core/utils.js renders the whole thing to a buffer at load.
function buildSfxSong(instrument, note) {
  const rowLen = state.song.rowLen;
  const rows = Math.ceil(sfx.soundLengthSamples(instrument, rowLen) / rowLen);
  const song = engine.makeNewSong();
  song.rowLen = rowLen;
  song.patternLen = Math.max(1, Math.min(32, rows));
  song.numChannels = 1;
  song.endPattern = 0;
  const ch = engine.makeEmptyChannel(song.patternLen);
  ch.i = instrument.slice();
  ch.p[0] = 1;
  ch.c[0].n[0] = note;
  song.songData = [ch];
  return song;
}

function sfxNoteOptions() {
  let html = '';
  for (let oct = SFX_OCT_MIN; oct <= SFX_OCT_MAX; oct++) {
    for (let s = 0; s < 12; s++) {
      const note = oct * 12 + s + engine.NOTE_OFFSET;
      html += `<option value="${note}"${note === sfxNote ? ' selected' : ''}>${SFX_NOTE_NAMES[s]}${oct}</option>`;
    }
  }
  return html;
}

// Show a rolled instrument: preview it on the selected channel and play it.
// Every route into a new sound goes through here, so none of them can forget
// to make a noise -- the whole point of the dialog is the listening.
function sfxShow(i, { remember = true } = {}) {
  sfxCurrent = i;
  if (remember) {
    sfxHistory.unshift(i.slice());
    sfxHistory = sfxHistory.slice(0, SFX_HISTORY_MAX);
    sfxRenderHistory();
  }
  setPresetPreview(i, sfx.RECIPES[sfxRecipe].name);
  auditionNote(sfxNote);
  const save = $('sfx-save'), exp = $('sfx-export');
  if (save) save.disabled = false;
  if (exp) exp.disabled = false;
}

// A line of feedback inside the dialog, cleared after a moment. Same idea as
// panels/tracker.js's flashFeedback, and here for the same reason: what it has
// to say is smaller than a dialog of its own.
let sfxSayTimer = null;
function sfxSay(message) {
  const el = $('sfx-status');
  if (!el) return;
  el.textContent = message;
  clearTimeout(sfxSayTimer);
  sfxSayTimer = setTimeout(() => { if ($('sfx-status')) $('sfx-status').textContent = ''; }, 4000);
}

function sfxRenderHistory() {
  const el = $('sfx-history');
  if (!el) return;
  el.innerHTML = sfxHistory.length
    ? sfxHistory.map((_, n) => `<button class="sfx-chip${n === 0 ? ' active' : ''}" type="button"
        data-n="${n}" title="Go back to this roll">${sfxHistory.length - n}</button>`).join('')
    : '<span class="hint">Rolls you make appear here — click one to go back to it.</span>';
}

function openSfxDialog() {
  const recipe = sfx.RECIPES[sfxRecipe];
  openModal(`<h3>Sound effects</h3>
    <p class="hint">Pick the kind of sound you want, then roll until one of them is right.
      Each roll plays on this channel without changing it — close this dialog and the
      channel is exactly as you left it.</p>
    <div class="sfx-row">
      <label title="What kind of sound to roll. Each one fixes the parameters that decide whether it is that sound at all, and varies the rest.">Kind
        <select id="sfx-recipe">${sfx.RECIPES.map((r, n) =>
          `<option value="${n}"${n === sfxRecipe ? ' selected' : ''}>${escapeHtml(r.name)}</option>`).join('')}</select></label>
      <button id="sfx-roll" type="button" title="Roll every unlocked group again from scratch">Roll</button>
      <button id="sfx-mutate" type="button" disabled title="Nudge the current sound instead of replacing it — same sound, slightly different">Mutate</button>
      <span class="hint" id="sfx-hint">${escapeHtml(recipe.hint)}</span>
    </div>
    <div class="sfx-row" title="A locked group keeps what it has through the next roll. Lock what already works and roll the rest.">
      <span>Keep:</span>
      ${sfx.GROUPS.map(([label]) =>
        `<label class="sfx-lock"><input type="checkbox" class="sfx-lock-box" data-group="${escapeHtml(label)}"
          ${sfxLocked.has(label) ? 'checked' : ''}> ${escapeHtml(label)}</label>`).join('')}
    </div>
    <div class="sfx-row" id="sfx-history"></div>
    <div class="sfx-row">
      <label title="The pitch the effect plays at. It is auditioned at this note and exported at it too.">Note
        <select id="sfx-note">${sfxNoteOptions()}</select></label>
      <label title="Names the preset and the exported file.">Name
        <input id="sfx-name" type="text" maxlength="40" value="${escapeHtml(recipe.name)}"></label>
    </div>
    <div class="row">
      <button id="sfx-save" disabled title="Save this sound into the preset library, under an SFX category, so the Presets dialog can load it into any channel later">Save to presets</button>
      <button id="sfx-export" disabled title="Download this sound as a one-note, one-pattern song — the same shape as src/js/sounds/tada.js, ready to import into a game">Export .js</button>
      <button id="picker-cancel" title="Close. The channel goes back to the instrument it had.">Close</button>
      <span class="hint" id="sfx-status"></span>
    </div>`,
    () => { sfxCurrent = null; clearPresetPreview(); });

  sfxRenderHistory();
  // A dialog reopened in the same session keeps its last roll, so the sound is
  // still there to save or export after a trip through the presets dialog.
  if (sfxCurrent) sfxShow(sfxCurrent, { remember: false });

  $('sfx-recipe').onchange = () => {
    sfxRecipe = +$('sfx-recipe').value;
    const r = sfx.RECIPES[sfxRecipe];
    $('sfx-hint').textContent = r.hint;
    // The name follows the recipe only while it is still the recipe's own --
    // a name someone typed is theirs, and switching kind must not eat it.
    const nameEl = $('sfx-name');
    if (sfx.RECIPES.some(x => x.name === nameEl.value)) nameEl.value = r.name;
  };

  for (const box of $('picker-body').querySelectorAll('.sfx-lock-box')) {
    box.onchange = () => {
      box.checked ? sfxLocked.add(box.dataset.group) : sfxLocked.delete(box.dataset.group);
    };
  }

  $('sfx-roll').onclick = () => {
    // Rolled over the *current* sound, not over the channel's instrument, so a
    // locked group keeps what the last roll gave it rather than snapping back
    // to whatever the channel happened to be playing.
    const base = sfxCurrent || state.song.songData[state.selInstrument].i;
    sfxShow(sfx.rollInstrument(sfx.RECIPES[sfxRecipe], base, sfxLocked));
    $('sfx-mutate').disabled = false;
  };
  $('sfx-mutate').onclick = () => {
    if (!sfxCurrent) return;
    sfxShow(sfx.mutateInstrument(sfx.RECIPES[sfxRecipe], sfxCurrent, sfxLocked));
  };
  $('sfx-mutate').disabled = !sfxCurrent;

  $('sfx-history').onclick = e => {
    const chip = e.target.closest('.sfx-chip');
    if (!chip) return;
    for (const el of $('sfx-history').querySelectorAll('.sfx-chip.active')) el.classList.remove('active');
    chip.classList.add('active');
    sfxShow(sfxHistory[+chip.dataset.n], { remember: false });
    $('sfx-mutate').disabled = false;
  };

  $('sfx-note').onchange = () => {
    sfxNote = +$('sfx-note').value;
    if (sfxCurrent) auditionNote(sfxNote);
  };

  $('sfx-save').onclick = () => {
    if (!sfxCurrent) return;
    const name = $('sfx-name').value.trim().slice(0, 40) || sfx.RECIPES[sfxRecipe].name;
    saveIntoLibrary(lib => {
      lib.presets.push({ name, i: sfxCurrent.slice(), set: DEFAULT_SET, category: SFX_CATEGORY });
    });
    // Said in the dialog, not in a notice modal: openModal treats a dialog
    // opened over another as a dismissal of it, so a notice here would run this
    // dialog's onClose, drop the preview, and leave the sound you just saved
    // unreachable for the export button beside it.
    sfxSay(`Saved "${name}" under ${DEFAULT_SET} → ${SFX_CATEGORY}.`);
  };

  $('sfx-export').onclick = () => {
    if (!sfxCurrent) return;
    const name = $('sfx-name').value.trim() || sfx.RECIPES[sfxRecipe].name;
    const song = buildSfxSong(sfxCurrent, sfxNote);
    downloadFile(new Blob([engine.songToJS(song)], { type: 'text/plain' }), sfxFileName(name));
    sfxSay(`Exported ${sfxFileName(name)} — one note over ${song.patternLen} rows.`);
  };

  $('picker-cancel').onclick = closeModal;
}

// --- about ---
// The synth, the song format, the instrument presets and both players are Marcus
// Geelnard's, and the GPL comes with them -- so the credit is spelled out here
// rather than left a footnote. A shorter version sits on the startup gate
// (index.html), which is the first thing anyone opening the editor sees.
$('about-btn').onclick = () => {
  openModal(`<h3>About Voxby</h3>
    <p><b>Voxby</b> is a synth music tracker for writing js13k-sized music: a
    rewritten editor around the audio engine of
    <a href="https://gitlab.com/mbitsnbites/soundbox" target="_blank" rel="noopener noreferrer">Marcus Geelnard's SoundBox</a>,
    whose synth, players, instrument presets and song format it keeps intact.</p>
    <p>Voxby inherits that licence, the
    <a href="gpl.txt" target="_blank" rel="noopener noreferrer">GPL v3</a>; the minimal
    player routine stays under zlib/libpng, as it does in SoundBox.</p>
    <p>The <a href="help.html" target="_blank">manual</a> covers the panels, note entry, the FX
    track and how to use a song in a game. Every control in here also has a hover tip.</p>
    <div class="row"><button id="picker-cancel" title="Close">Close</button></div>`);
  $('picker-cancel').onclick = closeModal;
};

// --- share ---
// A whole song packed into a URL, for posting a tune in chat without attaching a
// file. The payload lives in the *hash*, so it never reaches the server and needs
// no route of its own -- the page reads it at boot below. SHARE_BASE is where the
// app is deployed rather than the local dev server: a link is only worth sending
// if it opens somewhere public. https, not http: the payload never reaches the
// server, but the page's own clipboard/keyboard-layout calls need a secure
// context, and Pages doesn't enforce the upgrade itself.
const SHARE_BASE = 'https://ryanbmalm.com/voxby/';
// Past roughly this length a URL stops being pasteable -- chat clients and
// some browsers truncate or refuse to linkify it. Not a hard limit (the link
// is still handed over), just the point where it's worth saying so.
const SHARE_LIMIT = 8000;

function shareURL() {
  return SHARE_BASE + '#s=' + engine.songToURLData(state.song);
}

$('share-song').onclick = () => {
  const url = shareURL();
  openModal(`<h3>Share link</h3>
    <textarea id="share-url" class="mono" readonly rows="18">${url}</textarea>
    <p class="hint">Anyone opening this loads the song straight into their own
      editor — the whole song travels in the link, nothing is uploaded anywhere.
      ${url.length > SHARE_LIMIT
        ? `<b>This one is ${url.length} characters</b>, which is long enough that
           some chat clients will break it. Export JS and send the file instead.`
        : `${url.length} characters.`}</p>
    <div class="row">
      <button id="share-copy" title="Copy the link to the clipboard">Copy</button>
      <button id="picker-cancel" title="Close">Close</button>
    </div>`);
  $('picker-cancel').onclick = closeModal;
  $('share-url').onfocus = () => $('share-url').select();
  $('share-copy').onclick = () => {
    // Selecting it as well as writing the clipboard: navigator.clipboard needs
    // a secure context, which http://localhost is, but a real domain over plain
    // http later would not be -- the selection is the fallback that keeps
    // Ctrl+C working either way.
    $('share-url').select();
    navigator.clipboard && navigator.clipboard.writeText(url).catch(() => {});
    $('share-copy').textContent = 'Copied';
  };
};

// A song arriving in the URL is treated exactly like any other load (same
// stop/swap/markClean sequence), with no unsaved-changes prompt: this only ever
// runs at boot, against the empty song makeNewSong() just made. The hash is
// deliberately left in place so reloading the tab reloads the shared song.
function loadSharedSong() {
  const m = /[#&]s=([\w-]+)/.exec(location.hash);
  if (!m) return;
  let song;
  try { song = engine.urlDataToSong(m[1]); } catch { song = undefined; }
  if (!song) {
    noticeModal('Broken share link', `The song data in this link could not be decoded — it was
      probably truncated on its way here. Ask whoever sent it for the exported .js file instead.`);
    return;
  }
  loadSong(song, true);
}

// --- export ---
$('export-js').onclick = () => {
  const code = engine.songToJS(state.song);
  openModal(`<h3>Export JS</h3>
    <p class="hint">Choose how to export the song as JavaScript.</p>
    <div class="row">
      <button id="export-save-file" title="Download song.js to disk">Save .js file</button>
      <button id="export-open-tab" title="View the exported JavaScript code">Open code in new tab</button>
      <button id="picker-cancel" title="Close without exporting">Cancel</button>
    </div>`);
  $('export-save-file').onclick = () => {
    downloadFile(new Blob([code], { type: 'text/plain' }), 'song.js');
    markClean();
    closeModal();
  };
  $('export-open-tab').onclick = () => {
    const win = window.open('about:blank', '_blank');
    if (win) {
      win.document.write('<html><head><title>Exported Song</title></head><body><pre style="white-space:pre-wrap;word-wrap:break-word;font-family:monospace;"></pre></body></html>');
      win.document.querySelector('pre').textContent = code;
      win.document.close();
    }
    markClean();
    closeModal();
  };
  $('picker-cancel').onclick = closeModal;
};

// doneFn receives (wave, player, live): the CPlayer instance, because the scope
// panel reads already-rendered samples back out of it (player.getData(t, n)) to
// draw a waveform against playback's elapsed time; and `live`, a predicate that
// goes false if the user cancelled or started another render, for callers that
// keep working asynchronously after the samples land. `opts` is
// player-worker.js's own {firstRow,lastRow,firstCol,lastCol} shape (undefined
// renders the whole song) -- see panels/tracker.js's getPlayRange().
//
// Two long-lived CPlayers, one per purpose, instead of a fresh one
// per render. Each `new CPlayer()` spawns a Worker that nothing ever
// terminates, and that worker holds its finished mix buffer (tens of MB on a
// real song) alive for the rest of the session -- so every Play used to leak
// one. Reusing an instance costs nothing: player-worker.js's init() rebuilds
// all of its state per generate. They are kept separate so an Export WAV can't
// overwrite the buffer the scope is reading out of the playing song.
const players = {};
function playerFor(kind) {
  return players[kind] || (players[kind] = new CPlayer());
}

// Bumped by every render request. A callback whose ticket is stale belongs to a
// render that was cancelled or superseded, and is ignored -- the worker itself
// can't be interrupted without editing vendored code, so a cancelled render
// runs to completion in the background and its result is dropped.
let renderTicket = 0;
function generateWave(song, doneFn, opts, kind = 'play', heading = 'Rendering audio') {
  const player = playerFor(kind);
  const ticket = ++renderTicket;
  const live = () => ticket === renderTicket;
  const bar = progressModal(heading,
    `Voxby renders the whole thing to samples before playing a note of it. Long songs, many
     channels and the delay effect are what make this take a moment.`,
    () => { if (live()) renderTicket++; });
  player.generate(song, opts, progress => {
    if (!live()) return;
    bar.set(progress);
    if (progress >= 1) {
      bar.done();
      doneFn(player.createWave(), player, live);
    }
  });
}

$('export-wav').onclick = () => {
  generateWave(state.song, wave => {
    downloadFile(new Blob([wave], { type: 'application/octet-stream' }), 'voxby-music.wav');
  }, undefined, 'wav', 'Rendering WAV');
};

// --- transport ---
// Playback runs through an AudioBufferSourceNode on the shared audioContext
// (audio.js), the same context the jammer plays through: one audio graph and one
// autoplay-policy unlock (the startup gate above) rather than two independently
// unlocked pipelines.
let currentSource = null, currentPlayer = null, playStartTime = 0, playDuration = 0;
function stopSong() {
  if (currentSource) {
    currentSource.onended = null;
    try { currentSource.stop(); } catch {}
    currentSource = null;
  }
  currentPlayer = null;
  stopFollowingPlayback();
  stopFollowingPianoRoll();
  stopFollowingDrums();
  state.playing = false;
}
// `range` is undefined for a full-song Play, or a
// {firstRow,lastRow,firstCol,lastCol} from getPlayRange() for Play
// selected/Space -- passed straight through to player-worker.js's opts and,
// separately, to setFollowRange() so row-following/note-highlighting read
// against the right offset (see tracker.js's comment on followRow0).
function startPlayback(range) {
  stopSong();
  generateWave(state.song, (wave, player, live) => {
    audioContext.decodeAudioData(wave.buffer).then(buffer => {
      // Decoding is quick next to the render, but it is still async: a Stop or
      // another Play in that window must win, or the song starts anyway.
      if (!live()) return;
      const source = audioContext.createBufferSource();
      source.buffer = buffer;
      source.loop = $('loop-playback').checked;
      source.connect(masterGain);
      // Fires on natural end (non-looping) as well as an explicit stop() --
      // stopSong() clears onended before calling stop() itself, so this
      // only ever runs for a song that actually played out on its own.
      source.onended = () => { if (currentSource === source) stopSong(); };
      playStartTime = audioContext.currentTime;
      playDuration = buffer.duration;
      source.start();
      currentSource = source;
      currentPlayer = player;
      setFollowRange(range);
      state.playing = true;
    });
  }, range);
}
$('play-song').onclick = () => { startPlayback(); $('play-song').blur(); };
$('play-selected').onclick = () => { startPlayback(getPlayRange()); $('play-selected').blur(); };
$('stop-song').onclick = () => { stopSong(); $('stop-song').blur(); };
state.requestStop = stopSong;

// Space plays the sequence row on screen across every unmuted channel, or a
// dragged sequencer selection if there is one; getPlayRange()
// (panels/tracker.js) picks between them, so this is #play-selected's behaviour
// on a different trigger. Ignored while the startup audio gate is still up.
document.addEventListener('keydown', e => {
  if (e.code !== 'Space') return;
  // A held key auto-repeats keydown. startPlayback() is async (render, then
  // decodeAudioData) so state.playing stays false until it resolves -- a
  // held Space/Ctrl+Space would otherwise retrigger startPlayback on every
  // repeat before the first render finishes, queuing an endless pile of
  // renders that each restart the song when they land.
  if (e.repeat) return;
  // focus.js rather than a tag-name test, so Space still plays with an instrument
  // slider focused -- but not with the loop checkbox or a button focused, where
  // the browser's own Space press already means something.
  // Ctrl+Space plays the whole song and bypasses focus checks.
  if (!e.ctrlKey && keyHandledByFocus(e)) return;
  if (!$('audio-gate').classList.contains('closed')) return;
  // ...and not while a dialog is up: the generation progress modal in
  // particular, whose whole point is that a render is already running.
  if ($('picker').classList.contains('open')) return;
  e.preventDefault();
  // Stop if anything is playing, regardless of which Space variant was pressed
  if (state.playing) {
    stopSong();
    return;
  }
  // Not playing: start playback
  // Ctrl+Space plays whole song, plain Space plays selection/current pattern
  startPlayback(e.ctrlKey ? undefined : getPlayRange());
});

// One persistent requestAnimationFrame loop, started once and never stopped,
// drives both playback row-following and the scope. Running continuously rather
// than only during playback is what lets the scope pick up jamming with no
// start/stop bookkeeping of its own. `t` is elapsed real seconds since
// playStart, wrapped modulo the rendered buffer's duration when looping --
// audioContext.currentTime only counts up, and nothing resets it on loop.
//
// The scope gets *both* sources every frame rather than whichever one this loop
// guesses is more interesting: both nodes really are connected to the shared
// context's destination at once, so panels/scope.js sums them and what you see
// is what you hear. getJammer() returns null until the first note is previewed
// Level meter: reads the peak from scope.js's getLastPeak() every frame and
// updates the meter fill width. The meter decays smoothly (falls gradually
// rather than instantly dropping to zero) so brief peaks stay visible.
let meterPeak = 0;
const METER_DECAY = 0.92; // per-frame multiplier when no new peak arrives
function updateLevelMeter() {
  const currentPeak = getLastPeak();
  // Rise instantly to new peaks, decay gradually when quiet
  meterPeak = Math.max(currentPeak, meterPeak * METER_DECAY);
  // Convert linear peak (0.0-1.0+) to percentage for the meter fill.
  // The gradient's zones are at 50% (green/yellow) and 83.33% (yellow/red),
  // which correspond to -6dB and 0dB respectively (roughly 0.5 and 1.0 linear).
  // Scale so 0dB (1.0 peak) hits 83.33%, and clipping (>1.0) goes beyond.
  const percent = Math.min(100, meterPeak * 83.33);
  $('level-meter-fill').style.width = percent + '%';
}

// and currentPlayer is null when nothing plays; scope.js filters those out.
(function tick() {
  const t = state.playing ? (audioContext.currentTime - playStartTime) % playDuration : 0;
  if (state.playing) {
    followPlayback(t);
    // Extract current row for piano roll playback cursor
    const rowLen = state.song.rowLen;
    const patternLen = state.song.patternLen;
    const totalRows = Math.floor(t * 44100 / rowLen);
    const currentRow = totalRows % patternLen;
    followPlaybackPianoRoll(currentRow);
    followPlaybackDrums(currentRow);
  }
  drawScope([state.playing ? currentPlayer : null, getJammer()], t);
  updateLevelMeter();
  requestAnimationFrame(tick);
})();

// Master volume control
masterGain.gain.value = state.masterVolume;
$('master-volume').value = Math.round(state.masterVolume * 100);
$('master-volume').oninput = () => {
  const v = +$('master-volume').value / 100;
  state.masterVolume = v;
  masterGain.gain.value = v;
  savePrefs();
};

initTheme();
initInstrumentPanel();
initTrackerPanel();
initKeyboardPanel();
initScopePanel();
initLayout();

// View mode toggle (tracker vs piano roll)
$('view-mode').value = state.viewMode;
$('view-mode').onchange = () => {
  state.viewMode = $('view-mode').value;
  $('view-mode').blur(); // return focus to document
  refresh(); // re-render the view
};

refresh();

// Check for both shared song URL and auto-saved state
const sharedMatch = /[#&]s=([\w-]+)/.exec(location.hash);
const autosaved = loadAutosave();
const hasValidAutosave = autosaved && (Date.now() - (autosaved.timestamp || 0)) < 7 * 24 * 60 * 60 * 1000;

// If both exist, prompt user to choose
if (sharedMatch && hasValidAutosave) {
  (async () => {
    const useShared = await confirmModal(
      'Load shared song or restore work in progress?',
      `You have unsaved work from ${new Date(autosaved.timestamp).toLocaleString()}, but this URL contains a shared song. Which would you like to load?`,
      'Load shared song'
    );
    if (useShared) {
      loadSharedSong();
    } else {
      // Load auto-saved state
      state.song = autosaved.song;
      state.undoStack = autosaved.undoStack || [];
      state.redoStack = autosaved.redoStack || [];
      if (autosaved.selInstrument !== undefined) state.selInstrument = autosaved.selInstrument;
      if (autosaved.selRow !== undefined) state.selRow = autosaved.selRow;
      if (autosaved.octave !== undefined) state.octave = autosaved.octave;
      if (autosaved.viewMode !== undefined) state.viewMode = autosaved.viewMode;
      // Saved with the song rather than rediscovered, so a kit whose sounds
      // have been edited since is still a kit after a reload.
      state.drumKit = autosaved.drumKit || null;
      markClean();
      refresh();
      // Clear the hash so reloading doesn't re-prompt
      history.replaceState(null, '', location.pathname + location.search);
    }
  })();
} else if (sharedMatch) {
  // Only shared song, load it
  loadSharedSong();
} else if (hasValidAutosave) {
  // Only auto-save, restore it
  state.song = autosaved.song;
  state.undoStack = autosaved.undoStack || [];
  state.redoStack = autosaved.redoStack || [];
  if (autosaved.selInstrument !== undefined) state.selInstrument = autosaved.selInstrument;
  if (autosaved.selRow !== undefined) state.selRow = autosaved.selRow;
  if (autosaved.octave !== undefined) state.octave = autosaved.octave;
  if (autosaved.viewMode !== undefined) state.viewMode = autosaved.viewMode;
  state.drumKit = autosaved.drumKit || null;
  markClean();
  refresh();
}
