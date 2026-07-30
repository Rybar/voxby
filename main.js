// Voxby entry point (plans/soundbox-revamp.md Phase 3 Stage B; the editor was
// called soundbox until Stage E.17 renamed it. The directory, the /soundbox/
// dev-server route, the window.soundbox test hook and the localStorage keys
// deliberately keep the old name -- none of them are user-visible, and renaming
// the storage keys would silently discard everyone's saved preferences). Wires
// the file/transport shell against engine.js plus the vendored
// player.js/jammer.js/presets.js/rle.js/third_party globals —
// see index.html's script-loading comment for why those stay classic
// scripts. This file wires New/Open/Export JS/Export WAV/Play/Stop/About
// plus initializing the instrument (Stage C), tracker (Stage D), keyboard
// (Stage E), and scope (Stage E.2, now also fed by the jammer as of
// Stage E.4) panels.
//
// Playback here is deliberately simple (render the whole song with
// CPlayer, play it through a plain <audio> element) — the old VU-meter
// canvas was left behind in gui.js by Stage A (tracker/DOM-entangled) and
// is dropped rather than ported (nothing in the new UI reads it). Playback
// row-following *is* ported, as of Stage E.1's re-scope: panels/tracker.js's
// followPlayback(), polled here against audioEl.currentTime, moves the
// sequencer/pattern/fx cursors along with the song the same way gui.js's
// updateFollower did.
//
// The legacy "Save" dialog (a bookmarkable data: URL for the binary song
// format) is dropped rather than ported: Phase 4 gives this tool a real
// save/load loop — export a .js file, re-import it later — which is a
// better fit for a repo-local dev tool than a giant URL. Export JS now
// doubles as "save" (it clears the dirty flag New/Open check against).

import * as engine from './engine.js';
import { state, markClean, isDirty } from './state.js';
import { audioContext } from './audio.js';
import { svgIcon } from './icons.js';
import { initInstrumentPanel, refreshInstrumentPanel } from './panels/instrument.js';
import { initTrackerPanel, refreshTrackerPanel, followPlayback, stopFollowingPlayback, getPlayRange, setFollowRange } from './panels/tracker.js';
import { initKeyboardPanel, refreshKeyboardPanel, previewNote, syncJammer, highlightPlaybackNotes, shadowNotes, getJammer } from './panels/keyboard.js';
import { initScopePanel, drawScope } from './panels/scope.js';
import { initTheme } from './theme.js';
import { DEMO_SONGS, SECTIONS } from './songs/index.js';

// console/automation access, mirroring tools/scenetool/main.js's
// `window.scenetool = {...}` hook. getJammer exposed for tests to confirm
// the jammer is actually producing samples (Stage E.4) without depending on
// canvas-pixel heuristics. getAudioState (Stage E.5) exposes the shared
// audioContext's .state so tests can confirm the startup gate actually
// resumed it, without importing audio.js themselves.
window.soundbox = { state, engine, loadSong, loadDemoSong, DEMO_SONGS, importSongFile, getJammer, getAudioState: () => audioContext.state };

const $ = id => document.getElementById(id);

// Stage E.5: the one required user gesture that unlocks audioContext (see
// audio.js) for both the jammer and rendered song playback -- see
// index.html's #audio-gate comment for why it's a dedicated non-dismissible
// overlay rather than the generic #picker modal.
$('audio-gate-start').onclick = () => {
  audioContext.resume();
  $('audio-gate').classList.add('closed');
};

for (const [id, icon] of Object.entries({
  'new-song': 'newDoc', 'open-song': 'open', 'export-js': 'download',
  'export-wav': 'download', 'share-song': 'link', 'play-song': 'play', 'play-selected': 'playSel',
  'stop-song': 'stop', 'about-btn': 'about',
})) $(id).insertAdjacentHTML('afterbegin', svgIcon(icon) + ' ');

function refresh() {
  const s = state.song;
  $('status').textContent =
    `${s.numChannels} channels · ${s.patternLen} rows/pattern · ${s.endPattern} sequence steps`;
  refreshInstrumentPanel();
  refreshTrackerPanel();
  refreshKeyboardPanel();
  syncJammer();
}
// Stage D's tracker panel calls this after any cursor move or edit that
// isn't itself a full song load (state.song reassignment already goes
// through loadSong() -> refresh()) -- keeps the instrument panel's FX-cell
// preview and the status line in sync without an import cycle between
// panels/instrument.js and panels/tracker.js.
state.notify = refresh;
// Stage E: lets tracker.js live-preview piano-key note entry through
// keyboard.js's jammer without importing keyboard.js (see state.js's
// comment on this field for why that import would close a cycle).
state.previewNote = previewNote;
// Stage E.2: lets tracker.js's followPlayback() light up the on-screen keys
// currently sounding during song playback (see state.js's comment on this
// field for why it's a callback rather than a direct import).
state.highlightNotes = highlightPlaybackNotes;
// Stage E.14: lets the entry pie (panels/pie.js, opened from tracker.js) outline
// the notes it's about to write on the on-screen piano -- same callback-field
// reasoning as the two above.
state.shadowNotes = shadowNotes;

function confirmDiscard(msg) {
  return !isDirty() || confirm(msg);
}

function loadSong(song) {
  state.song = song;
  markClean();
  refresh();
}

// --- generic modal shell, reused for the open-song picker and the about
// dialog (Stage F adds new/save dialogs the same way) ---
function openModal(bodyHTML) {
  $('picker-body').innerHTML = bodyHTML;
  $('picker').classList.add('open');
}
function closeModal() {
  $('picker').classList.remove('open');
}
$('picker').onclick = e => { if (e.target.id === 'picker') closeModal(); };
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('picker').classList.contains('open')) closeModal();
});

// --- new / open ---
$('new-song').onclick = () => {
  if (!confirmDiscard('Start a new song? Unsaved changes will be lost.')) return;
  loadSong(engine.makeNewSong());
};

// Stage E.12: the list this dialog opens onto used to be SoundBox's own
// vendored demo-songs.js (a handful of upstream tunes as compressed binary
// blobs, decoded with binToSong). It's now songs/index.js — Ryan's own
// converted back catalogue as plain `export default {...}` modules, split
// into Songs and SFX sections. index.html no longer loads demo-songs.js at
// all; binToSong() is still reached by importSongFile()'s .snd route below.
//
// Each entry is fetched on click (dynamic import — see songs/index.js on
// why) and run through normalizeSong, since these files are sparse exports
// exactly like anything else the importer takes.
async function loadDemoSong(entry) {
  const mod = await import(`./songs/${entry.file}`);
  return engine.normalizeSong(mod.default);
}

$('open-song').onclick = () => {
  const cards = SECTIONS.map(section =>
    `<div class="pick-section">${section}</div>` +
    DEMO_SONGS.map((demo, i) => [demo, i]).filter(([demo]) => demo.section === section).map(([demo, i]) =>
      `<div class="pick-card" data-i="${i}" title="Load ${demo.name}">
         <div class="name">${demo.name}</div><div class="desc">${demo.desc}</div></div>`
    ).join('')
  ).join('');
  openModal(`<h3>Open song</h3><div id="picker-grid">${cards}</div>
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
      if (!confirmDiscard(`Load ${entry.name}? Unsaved changes will be lost.`)) return;
      const song = await loadDemoSong(entry).catch(() => undefined);
      if (!song) { alert(`Could not load ${entry.name}.`); return; }
      stopSong();
      loadSong(song);
      closeModal();
    };
  }
};

// --- import a song file (Phase 4) ---
// Two routes, picked by extension/MIME: a .js file exported by this editor
// goes through engine.songFromJS() (which evaluates it as a real ES module
// -- hence the trust warning in the open dialog and on the drop overlay),
// anything else is tried as one of the legacy binary formats binToSong()
// understands, the same bytes the old gui.js drag-and-drop path accepted.
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
  if (!confirmDiscard(`Load ${file.name}? Unsaved changes will be lost.`)) return;
  let song;
  try {
    song = /\.js$/i.test(file.name) || /javascript/.test(file.type)
      ? await engine.songFromJS(await file.text())
      : engine.binToSong(await readBinaryString(file));
  } catch {
    song = undefined;  // a truncated/garbage binary can throw its way out of the parser
  }
  if (!song) { alert(`Could not load ${file.name} (format not recognized).`); return; }
  stopSong();
  loadSong(song);
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
// Stage E.16 spelled the credit out properly rather than leaving it a footnote:
// the synth, the song format, the instrument presets and both players are still
// Marcus Geelnard's, and the GPL comes with them. A shorter version of the same
// thing sits on the startup gate (index.html), which is the first thing anyone
// opening the editor sees.
$('about-btn').onclick = () => {
  openModal(`<h3>About Voxby</h3>
    <p><b>Voxby</b> is a synth music tracker for writing js13k-sized music: a
    rewritten editor around the audio engine of
    <a href="https://gitlab.com/mbitsnbites/soundbox" target="_blank" rel="noopener noreferrer">Marcus Geelnard's SoundBox</a>,
    whose synth, players, instrument presets and song format it keeps intact.</p>
    <p>Voxby inherits that licence, the
    <a href="gpl.txt" target="_blank" rel="noopener noreferrer">GPL v3</a>; the minimal
    player routine stays under zlib/libpng, as upstream.</p>
    <p><a href="help.html" target="_blank">SoundBox's original help</a> still documents
    the instrument parameters and the song format — its screenshots show the old UI.</p>
    <div class="row"><button id="picker-cancel">Close</button></div>`);
  $('picker-cancel').onclick = closeModal;
};

// --- share (Stage E.14) ---
// Restores the URL-encoded song the original SoundBox had (gui.js's
// makeURLSongData, dropped by Stage B along with the rest of its dialogs) for
// posting a tune in chat without attaching a file. The payload lives in the
// *hash*, so it never reaches the server and needs no route of its own -- the
// page reads it at boot below. SHARE_BASE is where the app is actually deployed
// (Stage E.17 -- GitHub Pages off the voxby repo's master branch, under Ryan's
// own domain) rather than the local dev server: a link is only worth sending if
// it opens somewhere public. https, not http: the payload never reaches the
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
    <input id="share-url" class="mono" readonly value="${url}">
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
  if (!song) { alert('That share link could not be decoded.'); return; }
  loadSong(song);
}

// --- export ---
$('export-js').onclick = () => {
  saveAs(new Blob([engine.songToJS(state.song)], { type: 'text/plain' }), 'song.js');
  markClean();
};

// doneFn also receives the CPlayer instance -- Stage E.2's scope panel
// reads already-rendered samples back out of it (player.getData(t, n)) to
// draw a waveform against the currently-playing <audio> element's
// currentTime, the same call gui.js's VU-meter used. `opts`, added in Stage
// E.7, is player-worker.js's own {firstRow,lastRow,firstCol,lastCol} shape
// (undefined renders the whole song, same as before) -- see
// panels/tracker.js's getPlayRange().
function generateWave(song, doneFn, opts) {
  const player = new CPlayer();
  player.generate(song, opts, progress => {
    if (progress >= 1) doneFn(player.createWave(), player);
  });
}

$('export-wav').onclick = () => {
  generateWave(state.song, wave => {
    saveAs(new Blob([wave], { type: 'application/octet-stream' }), 'voxby-music.wav');
  });
};

// --- transport ---
// Stage E.5 re-scope: playback moved off a plain <audio> element (its own
// decode/output pipeline, entirely outside Web Audio) onto an
// AudioBufferSourceNode on the shared audioContext (tools/soundbox/
// audio.js) -- the same context the jammer now plays through -- so there's
// one audio graph and one autoplay-policy unlock (the startup gate below)
// instead of two independently-unlocked pipelines.
let currentSource = null, currentPlayer = null, playStartTime = 0, playDuration = 0;
function stopSong() {
  if (currentSource) {
    currentSource.onended = null;
    try { currentSource.stop(); } catch {}
    currentSource = null;
  }
  currentPlayer = null;
  stopFollowingPlayback();
  state.playing = false;
}
// Stage E.7: `range` is undefined for a full-song Play, or a
// {firstRow,lastRow,firstCol,lastCol} from getPlayRange() for Play
// selected/Space -- passed straight through to player-worker.js's opts and,
// separately, to setFollowRange() so row-following/note-highlighting read
// against the right offset (see tracker.js's comment on followRow0).
function startPlayback(range) {
  stopSong();
  generateWave(state.song, (wave, player) => {
    audioContext.decodeAudioData(wave.buffer).then(buffer => {
      const source = audioContext.createBufferSource();
      source.buffer = buffer;
      source.loop = $('loop-playback').checked;
      source.connect(audioContext.destination);
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
$('play-song').onclick = () => startPlayback();
$('play-selected').onclick = () => startPlayback(getPlayRange());
$('stop-song').onclick = stopSong;
state.requestStop = stopSong;

// Stage E.7: "hitting space should play either the selection from the
// sequence editor if a selection has been made or the sequence editor is in
// focus, or solo-play the current pattern being edited" -- getPlayRange()
// (panels/tracker.js) picks which of those two per state.editMode, matching
// #play-selected exactly (same handler, different trigger). Ignored while a
// text input/select has focus (typing a space in the BPM/rows fields
// shouldn't trigger playback) and while the startup audio gate is still up.
document.addEventListener('keydown', e => {
  if (e.code !== 'Space') return;
  const ae = document.activeElement;
  if (ae && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) return;
  if (!$('audio-gate').classList.contains('closed')) return;
  e.preventDefault();
  if (state.playing) stopSong();
  else startPlayback(getPlayRange());
});

// Stage E.1/E.2/E.3/E.4/E.5: a single persistent requestAnimationFrame loop
// (started once below, never stopped) drives both playback row-following
// and the scope. Running continuously rather than only while a song plays is
// what lets the scope pick up jamming with no separate start/stop
// bookkeeping for it. `t` is elapsed real seconds since playStart, wrapped
// modulo the rendered buffer's duration when looping
// (audioContext.currentTime only ever counts up -- unlike the old <audio>
// element, nothing resets it for us on loop).
//
// Stage E.6: the scope gets *both* sources every frame, not whichever one
// this loop guesses is more interesting. It used to pass
// `state.playing && currentPlayer ? currentPlayer : getJammer()`, which
// silently dropped the jammer for the whole duration of a playing song --
// and a rendered song is mostly silence when it's one note in a long
// sequence, so jamming over it drew a flat line (the reported bug). Both
// nodes really are connected to the shared context's destination at once,
// so panels/scope.js sums them: what you see is what you hear. getJammer()
// returns null until the first note is ever previewed, and currentPlayer is
// null when nothing is playing -- scope.js filters those out.
(function tick() {
  const t = state.playing ? (audioContext.currentTime - playStartTime) % playDuration : 0;
  if (state.playing) followPlayback(t);
  drawScope([state.playing ? currentPlayer : null, getJammer()], t);
  requestAnimationFrame(tick);
})();

initTheme();
initInstrumentPanel();
initTrackerPanel();
initKeyboardPanel();
initScopePanel();
refresh();
loadSharedSong();
