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
import { state, markClean, isDirty, saveAutosave, loadAutosave, clearAutosave } from './state.js';
import { audioContext, masterGain } from './audio.js';
import { svgIcon } from './icons.js';
import { initInstrumentPanel, refreshInstrumentPanel } from './panels/instrument.js';
import { initTrackerPanel, refreshTrackerPanel, followPlayback, stopFollowingPlayback, getPlayRange, setFollowRange } from './panels/tracker.js';
import { followPlaybackPianoRoll, stopFollowingPianoRoll } from './panels/pianoroll.js';
import { initKeyboardPanel, refreshKeyboardPanel, previewNote, syncJammer, highlightPlaybackNotes, getJammer } from './panels/keyboard.js';
import { initScopePanel, drawScope, getLastPeak } from './panels/scope.js';
import { initLayout } from './panels/layout.js';
import { initTheme } from './theme.js';
import { keyHandledByFocus } from './focus.js';
import { DEMO_SONGS, SECTIONS } from './songs/index.js';

// console/automation access, mirroring tools/scenetool/main.js's
// `window.scenetool = {...}` hook. getJammer exposed for tests to confirm
// the jammer is actually producing samples without depending on canvas-pixel
// heuristics. getAudioState exposes the shared
// audioContext's .state so tests can confirm the startup gate actually
// resumed it, without importing audio.js themselves.
window.soundbox = { state, engine, scales, loadSong, loadDemoSong, DEMO_SONGS, importSongFile, getJammer, getAudioState: () => audioContext.state };

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
// Lets tracker.js's followPlayback() light up the on-screen keys currently
// sounding during song playback -- a callback rather than a direct import, for
// the same reason.
state.highlightNotes = highlightPlaybackNotes;

function loadSong(song, skipAutosave = false) {
  state.song = song;
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
let modalOnClose = null;
function openModal(bodyHTML, onClose = null) {
  modalOnClose = onClose;
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

// Space plays the sequencer's selection when that grid is being worked in, or
// solo-plays the pattern being edited otherwise; getPlayRange()
// (panels/tracker.js) picks between them, so this is #play-selected's behaviour
// on a different trigger. Ignored while the startup audio gate is still up.
document.addEventListener('keydown', e => {
  if (e.code !== 'Space') return;
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

console.log('Boot check:', { hasSharedURL: !!sharedMatch, hasAutosave: !!autosaved, isValid: hasValidAutosave, age: autosaved ? Date.now() - autosaved.timestamp : null });

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
  markClean();
  refresh();
}
