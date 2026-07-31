// UI-only state for the editor. The song/instrument data itself is a plain, JSON-serializable
// object produced by engine.js — not duplicated here, just referenced by
// `state.song`. Mirrors tools/scenetool/state.js's shape (one `state`
// object, exported by reference so every module sees live edits).
//
// `songUnmodified` is a snapshot taken at load/export time, compared
// against `song` to ask "does the user have unsaved changes?" before a
// destructive New/Open. structuredClone/JSON.stringify are enough for this
// (song is plain data: nested arrays/objects/numbers, no cycles) — no need
// for common.js's deepCopy/deepEquals, so that classic script isn't loaded
// here at all.

import { makeNewSong } from './engine.js';

export const state = {
  song: makeNewSong(),
  songUnmodified: null,
  selInstrument: 0,
  selRow: 0,
  selCol: 0,
  octave: 5,
  clipboard: null,
  editMode: 'pattern',
  playing: false,
  // Callbacks main.js installs at boot so panels/tracker.js can
  // trigger a full UI refresh or stop playback without importing main.js
  // back (main.js already imports the panel modules to initialize them --
  // a reverse import would be circular).
  notify: null,
  requestStop: null,
  // Set to panels/keyboard.js's previewNote at boot. Lets
  // tracker.js's piano-key note entry live-preview through the jammer
  // without importing keyboard.js (which itself imports panels/
  // instrument.js -- a real import from tracker.js to keyboard.js would
  // close a cycle: instrument -> tracker, keyboard -> instrument,
  // keyboard -> tracker). Takes a raw key offset, returns the actual note
  // number (offset + octave*12 + engine.NOTE_OFFSET) so callers can reuse
  // that exact value for a pattern-grid write instead of recomputing it.
  previewNote: null,
  // Set to panels/keyboard.js's highlightPlaybackNotes at boot.
  // Lets tracker.js's followPlayback() light up the on-screen keys currently
  // sounding during song playback without importing keyboard.js -- same
  // cycle concern/fix as previewNote above, just in the opposite direction
  // (tracker calling out to keyboard instead of keyboard calling into
  // tracker). Takes an array of SoundBox note numbers.
  highlightNotes: null,

  // --- note-input preferences. Deliberately *not* song data: which scale you play in and how many rows
  // a beat is are per-musician settings, so they persist to localStorage
  // (below) instead of being exported, and changing one is not an unsaved
  // change to the music (isDirty() only ever compares `song`). ---
  beatRows: 4,          // highlight every Nth grid row (was a hardcoded 4)
  // Rows the pattern cursor advances after an entry -- a tracker's classic
  // edit step: 1 = the next row, 0 = stay put, 4 = a beat at a time. Applies to
  // every note entry path -- typed and on-screen piano alike -- so they can't
  // drift apart.
  editStep: 1,
  // Which characters the physical keyboard prints, for the on-screen piano's
  // key hints only -- note entry stays positional (see layouts.js).
  // 'auto' asks the browser; the rest are layouts.js's static tables.
  kbLayout: 'auto',
  scaleMode: 0,         // index into scales.js's SCALES; 0 = Chromatic = off
  scaleRoot: 0,         // scale transpose in half steps, 0-11, and the key the
                        // chord pads are in
  flavor: 0,            // index into chords.js's FLAVORS; 0 = None = no pads
  // Channel whose chords the melody keys follow, or -1 for off. Deliberately
  // not persisted, unlike the settings below it: a channel number means
  // something only within one song's arrangement, where a scale or a flavor is
  // a musical preference that travels.
  followChannel: -1,
  voicing: 'close',     // pad chord shape: 'close' (thirds) or 'quartal' (fourths)
  smoothVoicing: true,  // voice-lead each pad chord to the one before it
  chordOn: false,       // one keypress writes a chord (see panels/tracker.js)
  chordTones: [true, true, true, true, false, false, false],   // which of R/3/5/7/9/11/13 to write (max 4)
  // Name of the chord last entered, for the keyboard panel's readout. Purely
  // transient UI feedback -- not persisted.
  chordName: '',

  // --- view mode: tracker (traditional columns) or pianoroll (horizontal grid) ---
  viewMode: 'tracker',  // 'tracker' | 'pianoroll'
  channelsEnabled: Array(16).fill(true), // which channels are editable in piano roll

  // Undo/redo stacks (shared between tracker and piano roll)
  undoStack: [],
  redoStack: [],

  pianoRoll: {
    scrollY: 0,        // vertical scroll position (semitones from bottom)
    cursorRow: 0,      // time position (pattern row)
    cursorPitch: 60,   // note number (C4 = 60)
    dragNote: null,    // {channel, col, row, originalPitch, originalRow} when dragging
    selectedNotes: [], // array of {row, pitch, col, channel} - actual notes selected (multi-channel)
    dragSelection: null, // {startX, startY, offsetRow, offsetPitch} when dragging selection
  },

  // --- row layout (panels/layout.js). Heights are px, null meaning "use the
  // row's natural/CSS default size" -- so a user who never touches a handle
  // gets exactly today's layout. The tracks row (sequencer + patterns) is
  // deliberately not represented here: it always fills whatever space these
  // two leave it, floored at TRACKS_MIN, and is never collapsible. ---
  kbRowH: null,
  kbRowCollapsed: false,
  bottomRowH: null,
  bottomRowCollapsed: false,

  // Master volume (0-1, persisted). Applied via audio.js's masterGain.gain.value.
  masterVolume: 0.7,
};

// Same convention as theme.js's accent color, one key for the lot since
// these are always read and written together. Unknown or corrupt storage is
// ignored rather than thrown on, and only known fields are copied across --
// this object also holds `song`, which must never come from localStorage.
const PREFS_KEY = 'soundbox-prefs';
const PREF_FIELDS = ['beatRows', 'editStep', 'kbLayout', 'scaleRoot', 'voicing', 'smoothVoicing', 'chordOn', 'chordTones',
  'kbRowH', 'kbRowCollapsed', 'bottomRowH', 'bottomRowCollapsed', 'masterVolume'];

export function loadPrefs() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(PREFS_KEY)); } catch {}
  if (!saved) return;
  for (const k of PREF_FIELDS) if (saved[k] !== undefined) state[k] = saved[k];
}

export function savePrefs() {
  const out = {};
  for (const k of PREF_FIELDS) out[k] = state[k];
  localStorage.setItem(PREFS_KEY, JSON.stringify(out));
}

// Auto-save song WIP + undo stacks to localStorage
const AUTOSAVE_KEY = 'soundbox-autosave';
const AUTOSAVE_DEBOUNCE_MS = 500;
let autosaveTimer = null;

export function saveAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    try {
      const data = {
        song: state.song,
        undoStack: state.undoStack,
        redoStack: state.redoStack,
        selInstrument: state.selInstrument,
        selRow: state.selRow,
        octave: state.octave,
        viewMode: state.viewMode,
        timestamp: Date.now(),
      };
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(data));
    } catch (e) {
      // Quota exceeded or serialization error - fail silently
      console.warn('Auto-save failed:', e);
    }
  }, AUTOSAVE_DEBOUNCE_MS);
}

export function loadAutosave() {
  try {
    const saved = JSON.parse(localStorage.getItem(AUTOSAVE_KEY));
    if (!saved || !saved.song) return null;
    // Return the saved data for main.js to decide whether to restore
    return saved;
  } catch {
    return null;
  }
}

export function clearAutosave() {
  localStorage.removeItem(AUTOSAVE_KEY);
}

loadPrefs();

export function markClean() {
  state.songUnmodified = JSON.parse(JSON.stringify(state.song));
}
markClean();

export function isDirty() {
  return JSON.stringify(state.song) !== JSON.stringify(state.songUnmodified);
}
