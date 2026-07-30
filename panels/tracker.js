// Tracker panel: the sequencer and the multi-column pattern/fx grids.
//
// Every channel's pattern gets its own column, shown side by side in
// #patterns-panel, each with its own narrow inline FX column rather than one
// shared FX panel. Which pattern a column shows is driven by state.selRow (the
// sequencer's current song row): songData[channel].p[state.selRow] is "the
// pattern this channel plays at the selected row" for every channel at once, so
// moving the sequencer cursor repaints every pattern column together.
//
// All MAX_CHANNELS=16 sequencer/pattern columns are always rendered, not just
// song.numChannels: a channel only activates (bumping numChannels via
// engine.recalcSongRanges) once it has a non-zero sequence entry, so the extra
// columns are exactly how a song grows past its current channel count. The
// instrument panel's channel <select> lists all 16 for the same reason.
//
// One channel is focused at a time (state.selInstrument, shared with the
// instrument panel); clicking any cell in any grid moves focus to that cell's
// channel. Only the focused channel's pattern/fx column draws a cursor and
// selection, but the others stay clickable -- that is how focus moves.
//
// FX cells take no typed values. A selected FX cell captures whatever instrument
// slider or icon you touch next (panels/instrument.js's
// setInstrProp/bindIconGroup/bindArpNotes check activeFxCell() and route there
// as well as to the live instrument), and selecting a cell that already holds a
// value previews it in the sliders (instrument.js's previewInstrI()).
//
// Note entry -- physical keyboard or panels/keyboard.js's on-screen piano --
// live-previews through the jammer (state.previewNote) in either mode, and in
// pattern mode writes through enterNoteAtCursor() below. Playback row-following
// (curRow highlighting that tracks the playing row in both views) is
// followPlayback(); getPlayRange()/setFollowRange() restrict it to a
// sequence-row/channel range for "play selected" and solo-pattern playback (see
// main.js).

import * as engine from '../engine.js';
import { state, savePrefs } from '../state.js';
import { SCALES, PITCH_NAMES, CHORD_QUALITIES, scaleKeys, harmonyOf, diatonicChord, nameChord } from '../scales.js';
import { openPie } from './pie.js';
import { openMenu } from '../menu.js';
import { keyHandledByFocus } from '../focus.js';

const $ = id => document.getElementById(id);
const NOTE_NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];
const EDIT_MODES = ['sequence', 'pattern', 'fx'];

// Physical piano-key layout, keyed by KeyboardEvent.code (locale-independent,
// and not deprecated the way keyCode is). Bottom row = first octave, QWERTY row
// = second octave, with a few keys extending each row a couple of notes into the
// next octave.
export const NOTE_KEYS = {
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6, KeyB: 7,
  KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11,
  Comma: 12, KeyL: 13, Period: 14, Semicolon: 15, Slash: 16,
  KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17, Digit5: 18,
  KeyT: 19, Digit6: 20, KeyY: 21, Digit7: 22, KeyU: 23,
  KeyI: 24, Digit9: 25, KeyO: 26, Digit0: 27, KeyP: 28,
};

// The note mapping actually in force: the chromatic table above, or two
// straight rows of in-scale notes when a scale is selected (scales.js). Both
// speak the same "semitone offset relative to state.octave" contract, so
// every consumer -- this file's onKeyDown, keyboard.js's physical-key
// highlighting and its on-screen key labels -- works either way with no
// branching of its own. Rebuilt per call rather than cached: it's 20 entries
// and the alternative is an invalidation hook on every control that can
// change the scale or its root.
export function noteKeys() {
  const intervals = SCALES[state.scaleMode][1];
  return intervals ? scaleKeys(intervals, state.scaleRoot) : NOTE_KEYS;
}

function toHex(n, count) {
  return n.toString(16).toUpperCase().padStart(count, '0');
}

// --- cursor/selection: one plain object per grid (sequencer/pattern/fx).
// col/row is the single active cell, which typing and paste target; col1/row1
// and col2/row2 are the two corners of the selection rectangle. Both corners
// collapse onto col/row on a plain click; dragging or shift+arrow moves
// col1/row1 while col2/row2 stays pinned at the click/paste anchor. ---
function makeCursor() {
  return { col: 0, row: 0, col1: 0, row1: 0, col2: 0, row2: 0, copyBuf: null };
}
const seq = makeCursor(), pat = makeCursor(), fx = makeCursor();

const selLeft = c => Math.min(c.col1, c.col2);
const selRight = c => Math.max(c.col1, c.col2);
const selTop = c => Math.min(c.row1, c.row2);
const selBottom = c => Math.max(c.row1, c.row2);
const isSelected = (c, col, row) => col >= selLeft(c) && col <= selRight(c) && row >= selTop(c) && row <= selBottom(c);
function setCursor(c, col, row, keepSelection) {
  c.col = col; c.row = row;
  if (!keepSelection) { c.col1 = c.col2 = col; c.row1 = c.row2 = row; }
}
function extendSelection(c, col, row) { c.col1 = col; c.row1 = row; }
// Ctrl+A. "All" is the whole active grid -- for the pattern that's
// every row of all 4 note columns, i.e. every note in the pattern. The active
// cell deliberately stays where it is: it's the paste anchor (pasteSelection
// writes from c.row/c.col down), so dragging it to a corner would move where a
// following Ctrl+V lands.
function selectAll(c, grid) {
  c.col1 = 0; c.row1 = 0;
  c.col2 = grid.numcols() - 1; c.row2 = grid.numrows() - 1;
}
function forSelection(c, cb) {
  for (let row = selTop(c); row <= selBottom(c); row++)
    for (let col = selLeft(c); col <= selRight(c); col++) cb(col, row);
}

function cursorFor(mode) { return mode === 'sequence' ? seq : mode === 'pattern' ? pat : fx; }
function gridFor(mode) { return mode === 'sequence' ? seqGrid : mode === 'pattern' ? patGrid : fxGrid; }

// --- data access per grid, over engine.js's plain song-object shape. Each grid
// exposes the same tiny interface (numcols/numrows/get/set/clear), which is what
// lets the navigation, selection and clipboard code below be written once. ---
function focusedPatternNum() {
  return patternNumFor(state.selInstrument);
}

const seqGrid = {
  numcols: () => engine.MAX_CHANNELS,
  numrows: () => Math.min(engine.MAX_SONG_ROWS, Math.max(64, state.song.endPattern + 32)),
  get: (col, row) => state.song.songData[col].p[row] || 0,
  set: (col, row, v) => { state.song.songData[col].p[row] = v; engine.recalcSongRanges(state.song); },
  clear: (col, row) => { state.song.songData[col].p[row] = 0; engine.recalcSongRanges(state.song); },
  toHTML: v => v > 0 ? (v <= 10 ? '' + (v - 1) : String.fromCharCode(64 + v - 10)) : '',
};
const patGrid = {
  numcols: () => 4,
  numrows: () => state.song.patternLen,
  get: (col, row) => {
    const pn = focusedPatternNum();
    return pn ? state.song.songData[state.selInstrument].c[pn - 1].n[row + col * state.song.patternLen] : 0;
  },
  set: (col, row, v) => {
    const pn = focusedPatternNum();
    if (pn) state.song.songData[state.selInstrument].c[pn - 1].n[row + col * state.song.patternLen] = v;
  },
  clear(col, row) { this.set(col, row, 0); },
  toHTML: v => { const n = v - engine.NOTE_OFFSET; return n > 0 ? NOTE_NAMES[n % 12] + Math.floor(n / 12) : ''; },
};
const fxGrid = {
  numcols: () => 1,
  numrows: () => state.song.patternLen,
  get: (col, row) => {
    const pn = focusedPatternNum();
    if (!pn) return [0, 0];
    const f = state.song.songData[state.selInstrument].c[pn - 1].f;
    return [f[row], f[row + state.song.patternLen]];
  },
  set: (col, row, v) => {
    const pn = focusedPatternNum();
    if (!pn) return;
    const f = state.song.songData[state.selInstrument].c[pn - 1].f;
    f[row] = v[0]; f[row + state.song.patternLen] = v[1];
  },
  clear(col, row) { this.set(col, row, [0, 0]); },
  toHTML: ([cmd, val]) => cmd ? toHex(cmd, 2) + ':' + toHex(val, 2) : String.fromCharCode(183),
};

// Read by panels/instrument.js: when an FX cell is selected, instrument
// sliders/icons preview and write that cell's stored value as well as the live
// instrument property. A small pull-based API on purpose, so instrument.js needs
// to know nothing about this module's cursor shape.
export function activeFxCell() {
  if (state.editMode !== 'fx') return null;
  const pn = focusedPatternNum();
  if (!pn) return null;
  const [cmd, val] = fxGrid.get(0, fx.row);
  return {
    cmd, val,
    set(prop, value) { fxGrid.set(0, fx.row, [prop + 1, value]); render(); },
  };
}

// Writes an already-computed SoundBox note number at the pattern cursor and
// advances it. Both entry paths come through here -- this file's physical-keyboard
// handling below and panels/keyboard.js's on-screen piano -- so they can't drift
// apart. A no-op outside pattern edit mode or with no pattern focused; in fx mode
// the note still sounds (the caller triggered the jammer before calling) but is
// stored nowhere.
export function enterNoteAtCursor(note) {
  if (state.editMode !== 'pattern' || !focusedPatternNum()) return;
  const row = pat.row;
  if (state.chordOn) {
    // A chord is a row-level unit (the same way insertRowAtCursor already
    // treats a row), so it fills from column 0 rightward rather than from
    // wherever the cursor happens to sit.
    const { notes, name } = chordAt(note);
    writeChordRow(row, notes);
    // The root already sounded -- whichever caller got us here played it
    // before writing (tracker's own onKeyDown via state.previewNote,
    // keyboard.js's on-screen click via its jammer directly). Only the
    // added tones need previewing. A voicing with the root switched off
    // still leaves that first note ringing; not worth a second code path to
    // silence a note that's already decaying.
    previewNotes(notes.filter(n => n !== note));
    state.chordName = name;
    lastEntry = { row, note };
  } else {
    patGrid.set(pat.col, row, note);
    lastEntry = null;
  }
  advanceCursor(row);
  render(); notify();
}

// How far an entry moves the cursor is state.editStep, a tracker's edit step
// (see state.js). 0 leaves the cursor put; the modulo still has to wrap a step
// that lands exactly on numrows.
function advanceCursor(row) {
  setCursor(pat, pat.col, (row + Math.max(0, state.editStep | 0)) % patGrid.numrows());
}

// --- chord entry. The data model holds 4 notes per row (n[row + col*patternLen],
// columns 0-3), so a chord is always root/3rd/5th/7th: at most 4 tones, exactly
// the 4 columns available. Only where those intervals come from differs between
// the two modes.
//
// `lastEntry` is what makes the two-keypress flow work without a mode
// switch: a note key writes and advances as always, and a digit pressed
// straight afterwards rewrites *that same row* with the named quality
// instead of advancing again. Any other key, click or nav clears it, so a
// digit outside that window keeps its normal meaning (a sharp, in the
// chromatic layout).
let lastEntry = null;

const pitchOf = note => (((note - engine.NOTE_OFFSET) % 12) + 12) % 12;

// Drops the chord tones whose R/3/5/7 toggle is off and packs what's left to
// the left, so a rootless voicing lands in columns 0-2 rather than leaving a
// hole where the root would have been. Never returns empty -- with every
// toggle off, the played note itself still goes in.
function voiced(notes) {
  const keep = notes.filter((n, i) => state.chordTones[i]);
  return keep.length ? keep : [notes[0]];
}

const bareNote = note => ({ notes: [note], name: PITCH_NAMES[pitchOf(note)] });

// The chord the scale itself puts on `note`: stack every other degree of the
// *harmony* scale -- harmonyOf(), not the input scale, so a 5-note pentatonic
// still spells real 7th chords (see scales.js). With no scale, or a note the
// harmony scale doesn't contain (the blues b5, an out-of-key click), there's
// no quality to infer, so this is just the note -- a digit, or the pie's
// quality ring, can still turn it into a chord.
// The name is taken from the full chord, before voicing drops anything.
function diatonicAt(note) {
  const intervals = harmonyOf(state.scaleMode);
  const deltas = intervals && diatonicChord(intervals, state.scaleRoot, pitchOf(note));
  return deltas
    ? { notes: voiced(deltas.map(d => note + d)), name: nameChord(pitchOf(note), deltas) }
    : bareNote(note);
}

// What one keypress on `note` writes: the diatonic chord if chord mode is on,
// the bare note otherwise. The pie menu deliberately calls diatonicAt/chordFor
// directly instead -- opening it *is* the request for a chord, so it doesn't
// also need the checkbox on.
function chordAt(note) {
  return state.chordOn ? diatonicAt(note) : bareNote(note);
}

// The one place a (note, quality) pair becomes actual notes plus a name, shared by the digit row and the pie's quality ring so the two can't
// spell the same chord differently. `quality` is 'auto' for whatever the scale
// harmonizes the note to, a CHORD_QUALITIES key ('Digit1'...) for a named one,
// or anything else (null) for the bare note.
export function chordFor(note, quality) {
  if (quality === 'auto') return diatonicAt(note);
  const q = CHORD_QUALITIES[quality];
  if (!q) return bareNote(note);
  return { notes: voiced(q[1].map(semi => note + semi)), name: PITCH_NAMES[pitchOf(note)] + q[0] };
}

// What one keypress on `note` would write right now -- read by
// panels/keyboard.js to shadow the chord's keys on the on-screen piano while
// the mouse hovers its root. Just the notes: the caller doesn't need the
// name, and going through the same chordAt() the real entry uses is the
// point (a preview that can disagree with what actually gets written is
// worse than no preview).
export function chordNotesFor(note) {
  return chordAt(note).notes;
}

function writeChordRow(row, notes) {
  const pn = focusedPatternNum();
  if (!pn) return;
  const patternLen = state.song.patternLen;
  const col = state.song.songData[state.selInstrument].c[pn - 1];
  for (let c = 0; c < 4; c++) col.n[row + c * patternLen] = notes[c] || 0;
}

// state.previewNote takes a *relative* key offset and does the
// offset + octave*12 + NOTE_OFFSET math itself (see state.js); feeding it the
// exact inverse gets an absolute note previewed through the jammer without a
// second callback field just for this.
function previewNotes(notes) {
  if (!state.previewNote) return;
  for (const note of notes) state.previewNote(note - state.octave * 12 - engine.NOTE_OFFSET);
}

// The digit half of the two-keypress flow. Rewrites the row the last note
// went into and leaves the cursor where it is (it already advanced past that
// row), so pressing another digit re-picks the quality on the same row
// rather than walking down the pattern.
function applyChordQuality(code) {
  if (!CHORD_QUALITIES[code] || !lastEntry) return false;
  const { notes, name } = chordFor(lastEntry.note, code);
  writeChordRow(lastEntry.row, notes);
  previewNotes(notes);
  state.chordName = name;
  render(); notify();
  return true;
}

// --- entry pie menu (see panels/pie.js). Everything musical the
// pie asks for is answered from the functions above, so a pie pick and a
// keypress cannot write different things. The voicing toggles apply here even
// with chord mode off: opening the pie and choosing a quality is an explicit
// request for that chord, and R/3/5/7 is how you say which of its tones you
// want. ---
function openEntryPie(x, y) {
  const row = pat.row;
  openPie(x, y, {
    noteFor: pitch => pitch + state.octave * 12 + engine.NOTE_OFFSET,
    chordFor,
    // Auditions the hovered wedge and outlines it on the on-screen piano at
    // the same time (state.shadowNotes -- keyboard.js's own chord shadow,
    // reached through a callback field since tracker.js can't import it).
    preview(notes) {
      previewNotes(notes);
      state.shadowNotes && state.shadowNotes(notes);
    },
    commit(notes, name, root) {
      writeChordRow(row, notes);
      state.chordName = name;
      // Leaves the two-keypress window open on the row the pie just wrote, so
      // a digit straight after re-picks the quality exactly as it would after
      // a typed note.
      lastEntry = { row, note: root };
      advanceCursor(row);
      render(); notify();
    },
    octaveChanged() { render(); notify(); },
  });
}

// Enter in a note/fx column inserts an empty row at the cursor,
// pushing that row and everything below it down one -- the whole pattern
// row across all 4 note columns and the fx column together (not just the
// column the cursor happens to be in), since a "row" is the musical unit
// here. patternLen is fixed, so the last row's content falls off the end
// (same tradeoff any fixed-length insert makes -- there's nowhere else for
// it to go).
function insertRowAtCursor(row) {
  const pn = focusedPatternNum();
  if (!pn) return;
  const patternLen = state.song.patternLen;
  const col = state.song.songData[state.selInstrument].c[pn - 1];
  for (let c = 0; c < 4; c++) {
    for (let r = patternLen - 1; r > row; r--) col.n[r + c * patternLen] = col.n[r - 1 + c * patternLen];
    col.n[row + c * patternLen] = 0;
  }
  for (let c = 0; c < 2; c++) {
    for (let r = patternLen - 1; r > row; r--) col.f[r + c * patternLen] = col.f[r - 1 + c * patternLen];
    col.f[row + c * patternLen] = 0;
  }
}

// --- transpose. Acts on the pattern selection exactly as drawn:
// one cell, a column, or a block dragged across all 4 note columns. Empty cells
// stay empty -- transposing a rest would invent a note.
//
// Refuses the whole operation rather than clamping if any note would leave the
// storable range (notes are a single byte in the song format, so 1-255, with 0
// meaning "no note"). Clamping would silently collapse the intervals of a chord
// against the ceiling, which is worse than nothing happening.
const NOTE_MIN = 1, NOTE_MAX = 255;

function transposeSelection(delta) {
  const pn = focusedPatternNum();
  if (!pn) return;
  const patternLen = state.song.patternLen;
  const col = state.song.songData[state.selInstrument].c[pn - 1];
  const moves = [];
  forSelection(pat, (c, row) => {
    const i = row + c * patternLen;
    if (col.n[i]) moves.push([i, col.n[i] + delta]);
  });
  if (!moves.length || moves.some(([, v]) => v < NOTE_MIN || v > NOTE_MAX)) return;
  for (const [i, v] of moves) col.n[i] = v;
  lastEntry = null;   // the row's contents are no longer what a digit would requalify
  render(); notify();
}

// Right-clicking the grid. The menu acts on the selection, so a click outside
// the current one moves the cursor there first (and into that cell's channel) --
// otherwise the menu would silently act somewhere the user isn't pointing.
// Inside it, the selection is left alone, which is the whole point of having
// dragged one -- primary() below keeps the right-click's own mousedown from
// wiping it on the way here.
function patternsContextMenu(e) {
  const t = cellTarget(e);
  // fx cells hold command/value pairs, not notes -- nothing here applies, so
  // the browser's own menu is left to it.
  if (!t || e.target.closest('.trk-fx')) return;
  e.preventDefault();
  dragMode = null;
  if (state.editMode !== 'pattern' || t.channel !== state.selInstrument || !isSelected(pat, t.col, t.row)) {
    state.selInstrument = t.channel;
    state.editMode = 'pattern';
    setCursor(pat, t.col, t.row);
    lastEntry = null;
    render(); notify();
  }
  openMenu(e.clientX, e.clientY, [
    { label: 'Select all', hint: 'Ctrl+A', run: () => { selectAll(pat, patGrid); render(); } },
    { label: 'Copy', hint: 'Ctrl+C', run: () => copySelection('pattern') },
    { label: 'Paste', hint: 'Ctrl+V', run: () => doPaste('pattern') },
    null,
    { label: 'Transpose +1 semitone', hint: 'Alt+↑', run: () => transposeSelection(1) },
    { label: 'Transpose −1 semitone', hint: 'Alt+↓', run: () => transposeSelection(-1) },
    null,
    { label: 'Transpose +1 octave', hint: 'Alt+Shift+↑', run: () => transposeSelection(12) },
    { label: 'Transpose −1 octave', hint: 'Alt+Shift+↓', run: () => transposeSelection(-12) },
  ]);
}

// What Space and "Play selected" play: the sequencer's selection when that is
// the grid being worked in, otherwise the one pattern being edited. The shape is
// player-worker.js's own opts -- firstRow/lastRow are sequence steps,
// firstCol/lastCol are channels. Solo-play passes a single sequence row
// (state.selRow) so player-worker.js's numSamples works out to exactly one
// pattern's length.
export function getPlayRange() {
  if (state.editMode === 'sequence') {
    return { firstRow: selTop(seq), lastRow: selBottom(seq), firstCol: selLeft(seq), lastCol: selRight(seq) };
  }
  return { firstRow: state.selRow, lastRow: state.selRow, firstCol: state.selInstrument, lastCol: state.selInstrument };
}

// --- copy/paste, generic across all three grids ---
function copySelection(mode) {
  const grid = gridFor(mode), c = cursorFor(mode);
  c.copyBuf = [];
  for (let row = selTop(c); row <= selBottom(c); row++) {
    const line = [];
    for (let col = selLeft(c); col <= selRight(c); col++) line.push(grid.get(col, row));
    c.copyBuf.push(line);
  }
}
function pasteSelection(mode) {
  const grid = gridFor(mode), c = cursorFor(mode);
  if (!c.copyBuf) return;
  for (let row = c.row, i = 0; row < grid.numrows() && i < c.copyBuf.length; row++, i++)
    for (let col = c.col, j = 0; col < grid.numcols() && j < c.copyBuf[i].length; col++, j++)
      grid.set(col, row, c.copyBuf[i][j]);
}
// The whole paste, shared by Ctrl+V and the right-click menu so the two can't
// drift. lastEntry goes because the row a digit would requalify
// has just been overwritten by something else.
function doPaste(mode) {
  pasteSelection(mode);
  if (mode === 'sequence') syncSeqIntoState();
  lastEntry = null;
  render(); notify();
}

// --- keyboard navigation (arrows/home/end/backspace/delete), generic across the
// three grids. Returns true if it handled the key. ---
function handleNav(e, mode) {
  const grid = gridFor(mode), c = cursorFor(mode);
  let col = e.shiftKey ? c.col1 : c.col, row = e.shiftKey ? c.row1 : c.row;
  const oldCol = col, oldRow = row;
  const numcols = grid.numcols(), numrows = grid.numrows();
  switch (e.code) {
    case 'ArrowRight': col = e.ctrlKey ? numcols - 1 : col + 1; break;
    case 'ArrowLeft': col = e.ctrlKey ? 0 : col - 1; break;
    case 'ArrowDown': row = e.ctrlKey ? numrows - 1 : row + 1; break;
    case 'ArrowUp': row = e.ctrlKey ? 0 : row - 1; break;
    case 'Home': row = 0; break;
    case 'End': row = numrows - 1; break;
    case 'Backspace': case 'Delete':
      forSelection(c, (col, row) => grid.clear(col, row));
      // Single cell: advance the cursor past it. A range stays selected --
      // freshly-cleared cells, still highlighted -- rather than collapsing onto
      // one corner.
      if (c.col1 === c.col2 && c.row1 === c.row2) row = row + 1;
      break;
    default: return false;
  }
  if (oldRow !== row || oldCol !== col) {
    col = (col + numcols) % numcols;
    row = (row + numrows) % numrows;
    if (e.shiftKey) extendSelection(c, col, row);
    else setCursor(c, col, row);
  }
  lastEntry = null;   // moving off the row ends the chord-quality window
  return true;
}

// Shared by the octave keys below, the keyboard panel's own +/- buttons (via
// state.notify) and the pie's wheel/octave keys, so all three clamp the same
// way. 1-8 is the engine's playable range (see panels/keyboard.js).
export function shiftOctave(d) {
  state.octave = Math.min(8, Math.max(1, state.octave + d));
  render(); notify();
}

function onKeyDown(e) {
  // Only the keys the focused control genuinely uses are given up (see
  // focus.js): a focused slider keeps its arrows, and everything else -- notes,
  // octave, clipboard -- still reaches the grids.
  if (keyHandledByFocus(e)) return;

  // Octave: < and >, plus - and = -- the unshifted keys in the same place, which
  // is what a hand reaching for the octave actually finds. Matched on e.key
  // rather than e.code so the printed character is what counts, unlike note
  // entry, which is positional (see layouts.js).
  if (e.key === '<' || e.key === '-') { shiftOctave(-1); return; }
  if (e.key === '>' || e.key === '=') { shiftOctave(1); return; }

  if (e.code === 'Tab') {
    e.preventDefault();
    lastEntry = null;
    const i = EDIT_MODES.indexOf(state.editMode);
    state.editMode = EDIT_MODES[(i + (e.shiftKey ? -1 : 1) + 3) % 3];
    render(); notify();
    return;
  }

  // KeyA is never a note key in either layout (the chromatic table above and
  // scales.js's two straight rows both start at KeyZ/KeyQ), so this needs no
  // window or mode guard of its own.
  if (e.ctrlKey && e.code === 'KeyA') {
    selectAll(cursorFor(state.editMode), gridFor(state.editMode));
    render();
    e.preventDefault();
    return;
  }
  if (e.ctrlKey && e.code === 'KeyC') { copySelection(state.editMode); e.preventDefault(); return; }
  if (e.ctrlKey && e.code === 'KeyV') { doPaste(state.editMode); e.preventDefault(); return; }

  if (state.editMode === 'sequence') {
    let code = null;
    if (/^Digit[0-9]$/.test(e.code)) code = +e.code.slice(5) + 1;
    else if (/^Key[A-Z]$/.test(e.code)) code = 11 + (e.code.charCodeAt(3) - 65);
    if (code) {
      seqGrid.set(seq.col, seq.row, code);
      if (e.shiftKey) setCursor(seq, seq.col, (seq.row + 1) % seqGrid.numrows());
      syncSeqIntoState();
      render(); notify();
      e.preventDefault();
      return;
    }
  } else if (state.editMode === 'pattern' || state.editMode === 'fx') {
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      lastEntry = null;
      insertRowAtCursor(state.editMode === 'pattern' ? pat.row : fx.row);
      render(); notify();
      e.preventDefault();
      return;
    }
    // Shift+Delete/Backspace clears the whole row -- all 4 note
    // columns at once, since a chord is entered as a row and wants deleting as
    // one too (plain Delete still clears just the cell/selection below). Notes
    // only, not the row's fx cell: this is a note-column gesture, and fx
    // values are entered by an entirely different mechanism. Checked before
    // handleNav, whose Delete case would otherwise read the shift key as
    // "extend the selection".
    if (state.editMode === 'pattern' && e.shiftKey && (e.code === 'Delete' || e.code === 'Backspace')) {
      lastEntry = null;
      writeChordRow(pat.row, []);
      setCursor(pat, pat.col, (pat.row + 1) % patGrid.numrows());
      render(); notify();
      e.preventDefault();
      return;
    }
    // Transpose shortcuts, matching the right-click menu. Alt is
    // the one free modifier here: ctrl+arrows already jump to the end of a grid
    // and shift+arrows extend the selection (both in handleNav), and this has
    // to be checked before it for the shift+alt pair to mean an octave rather
    // than a selection.
    if (state.editMode === 'pattern' && e.altKey && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) {
      transposeSelection((e.code === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1));
      e.preventDefault();
      return;
    }
    // The second keypress of a chord entry, checked before the note lookup
    // below because the digit row doubles as sharps in the chromatic layout.
    // The collision is scoped to exactly this window -- chord mode on, and a
    // note entered with nothing since -- so outside it a digit is still a
    // note, and with chord mode off it always is.
    if (state.chordOn && lastEntry && applyChordQuality(e.code)) {
      e.preventDefault();
      return;
    }
    // Piano-key emulation: live-plays through panels/keyboard.js in either mode
    // (state.previewNote, a callback field like state.notify/state.requestStop,
    // so this module needn't import keyboard.js), but only *writes* into the
    // pattern grid when a pattern is actually focused. previewNote does the raw-
    // key-offset -> note-number math (octave + NOTE_OFFSET) and hands the result
    // back, so both sides agree on the exact value.
    const n = noteKeys()[e.code];
    if (n !== undefined) {
      const note = state.previewNote ? state.previewNote(n) : n + state.octave * 12 + engine.NOTE_OFFSET;
      enterNoteAtCursor(note);
      e.preventDefault();
      return;
    }
  }

  if (handleNav(e, state.editMode)) {
    if (state.editMode === 'sequence') syncSeqIntoState();
    render(); notify();
    e.preventDefault();
  }
}

function syncSeqIntoState() {
  state.selInstrument = seq.col;
  state.selRow = seq.row;
}

function notify() { state.notify && state.notify(); }

// --- mouse: click-to-place-cursor + drag-to-select, delegated per panel ---
let dragMode = null;

function cellTarget(e) {
  const el = e.target.closest('[data-row]');
  return el && { channel: el.dataset.channel !== undefined ? +el.dataset.channel : null, col: +el.dataset.col, row: +el.dataset.row };
}

// Only the left button places the cursor. mousedown fires for a right-click too,
// and collapsing the selection an instant before `contextmenu` opens a menu on
// it would make right-clicking a dragged range act on a single cell.
const primary = e => e.button === 0;

function seqMouseDown(e) {
  const t = cellTarget(e);
  if (!t || !primary(e)) return;
  lastEntry = null;
  state.editMode = 'sequence';
  if (e.shiftKey) extendSelection(seq, t.col, t.row);
  else setCursor(seq, t.col, t.row);
  syncSeqIntoState();
  dragMode = 'sequence';
  render(); notify();
}
function patternsMouseDown(e) {
  const t = cellTarget(e);
  if (!t || !primary(e)) return;
  lastEntry = null;
  // Shift+click extends the selection from its anchor to the clicked
  // cell -- the mouse equivalent of shift+arrow, which likewise moves only the
  // col1/row1 corner and leaves the active cell where it is. Restricted to the
  // focused channel: one pattern cursor is shared by all of them, so an anchor in
  // one channel and a corner in another describes no real rectangle. Shift+click
  // on an unfocused channel therefore just focuses it, like a plain click.
  const extend = e.shiftKey && t.channel === state.selInstrument;
  if (!extend) state.selInstrument = t.channel;
  if (e.target.closest('.trk-fx')) {
    state.editMode = 'fx';
    if (extend) extendSelection(fx, 0, t.row);
    else setCursor(fx, 0, t.row);
    dragMode = 'fx';
  } else {
    state.editMode = 'pattern';
    if (extend) extendSelection(pat, t.col, t.row);
    else setCursor(pat, t.col, t.row);
    dragMode = 'pattern';
  }
  render(); notify();
  // The second press of a double-click on a note cell opens the
  // entry pie. Bound to mousedown rather than dblclick deliberately -- dblclick
  // only fires after the second release, by which point a drag-out-and-release
  // pick is impossible; here the button is still down, so the whole pick can be
  // one gesture (releasing without moving leaves the pie up to click at
  // instead). dragMode is cleared because this press already armed a
  // drag-select that the pie is taking over from.
  if (e.detail >= 2 && !e.shiftKey && dragMode === 'pattern' && focusedPatternNum()) {
    dragMode = null;
    openEntryPie(e.clientX, e.clientY);
  }
}
function onMouseOver(e) {
  if (!dragMode) return;
  // A drag is only live while the button is genuinely still down.
  // Releasing outside the window never fires our mouseup, and without this the
  // selection would go on following the pointer with nothing held -- as would a
  // mouseover fired merely because render() replaced the element under a
  // stationary pointer.
  if (!(e.buttons & 1)) { dragMode = null; return; }
  const t = cellTarget(e);
  if (!t) return;
  if (dragMode === 'sequence') extendSelection(seq, t.col, t.row);
  else if (dragMode === 'pattern' && t.channel === state.selInstrument) extendSelection(pat, t.col, t.row);
  else if (dragMode === 'fx' && t.channel === state.selInstrument) extendSelection(fx, 0, t.row);
  else return;
  render();
}
function onMouseUp() { dragMode = null; }

// --- rendering: full innerHTML rebuild on every change. Simpler and safer than
// surgical per-cell diffing at this grid size (a few thousand cells at most).
// The BPM/rows inputs live outside the rebuilt containers, so typing in them
// doesn't lose focus. ---
function seqCellHTML(col, row) {
  const cls = state.editMode !== 'sequence' ? ''
    : col === seq.col && row === seq.row ? 'cursor'
    : isSelected(seq, col, row) ? 'selected' : '';
  return `<td class="${cls}" data-col="${col}" data-row="${row}">${seqGrid.toHTML(seqGrid.get(col, row))}</td>`;
}

// Which rows get the beat highlight. A control rather than a fixed 4
// (state.beatRows, persisted): a 3/4 or 6/8 loop wants 3 or 6, a 32nd-note
// pattern wants 8. Guarded against 0 since the input is typed into.
const isBeatRow = row => row % Math.max(1, state.beatRows | 0) === 0;

function renderSequencer() {
  const rows = seqGrid.numrows();
  let thead = '<tr><th></th>';
  for (let col = 0; col < engine.MAX_CHANNELS; col++) {
    thead += `<th class="${col === state.selInstrument ? 'focused' : ''}"`
      + ` title="Channel ${col + 1}. Click a cell in this column to edit this channel's patterns and instrument.">${col + 1}</th>`;
  }
  thead += '</tr>';
  let tbody = '';
  for (let row = 0; row < rows; row++) {
    tbody += `<tr class="${isBeatRow(row) ? 'beat' : ''}${row === state.selRow ? ' curRow' : ''}"><th>${row}</th>`;
    for (let col = 0; col < engine.MAX_CHANNELS; col++) tbody += seqCellHTML(col, row);
    tbody += '</tr>';
  }
  $('seq-thead').innerHTML = thead;
  $('seq-tbody').innerHTML = tbody;
}

function patternNumFor(channel) {
  return state.song.songData[channel].p[state.selRow] || 0;
}
function patCellHTML(channel, pn, col, row) {
  const focused = channel === state.selInstrument;
  const cls = focused && state.editMode === 'pattern' && col === pat.col && row === pat.row ? 'cursor'
    : focused && state.editMode === 'pattern' && isSelected(pat, col, row) ? 'selected' : '';
  const v = pn ? patGrid.toHTML(state.song.songData[channel].c[pn - 1].n[row + col * state.song.patternLen]) : '';
  return `<td class="${cls}" data-channel="${channel}" data-col="${col}" data-row="${row}">${v}</td>`;
}
function fxCellHTML(channel, pn, row) {
  const focused = channel === state.selInstrument;
  const cls = focused && state.editMode === 'fx' && row === fx.row ? 'cursor'
    : focused && state.editMode === 'fx' && isSelected(fx, 0, row) ? 'selected' : '';
  let text = String.fromCharCode(183);
  if (pn) {
    const f = state.song.songData[channel].c[pn - 1].f;
    text = fxGrid.toHTML([f[row], f[row + state.song.patternLen]]);
  }
  return `<td class="trk-fx ${cls}" data-channel="${channel}" data-col="0" data-row="${row}"`
    + ` title="FX track: click a row here, then move any instrument control to record that change at this row. A command stays in effect until something else changes it, even into later patterns.">${text}</td>`;
}

function renderPatterns() {
  const patternLen = state.song.patternLen;
  let html = '';
  for (let channel = 0; channel < engine.MAX_CHANNELS; channel++) {
    const pn = patternNumFor(channel);
    html += `<div class="pat-col ${channel === state.selInstrument ? 'focused' : ''}">`
      + `<div class="pat-col-head" data-channel="${channel}" title="${pn
          ? `Channel ${channel + 1} plays pattern ${pn} at this sequence row. Click to edit it.`
          : `Channel ${channel + 1} has no pattern at this sequence row — type a pattern number into the sequencer above before you can write notes here.`
        }">Ch ${channel + 1} · ${pn ? 'Pat ' + pn : String.fromCharCode(8212)}</div>`
      + '<table class="trk-table"><tbody>';
    for (let row = 0; row < patternLen; row++) {
      html += `<tr class="${isBeatRow(row) ? 'beat' : ''}${row === pat.row ? ' curRow' : ''}">`;
      for (let col = 0; col < 4; col++) html += patCellHTML(channel, pn, col, row);
      html += fxCellHTML(channel, pn, row);
      html += '</tr>';
    }
    html += '</tbody></table></div>';
  }
  $('pat-scroll').innerHTML = html;
  // Cached per-channel row <tr> lists, indexed to match `row` exactly (rendered
  // 0..patternLen-1 in order above). This is what lets followPlayback's per-row
  // fast path move the curRow/cursor classes with plain classList calls instead
  // of rebuilding the whole grid on every playback row -- that rebuild is the
  // real framerate cost during playback.
  patRowEls = [...$('pat-scroll').querySelectorAll('.pat-col')].map(col => [...col.querySelectorAll('tbody tr')]);
}

function refreshSongControls() {
  const bpmEl = $('song-bpm'), rppEl = $('song-rpp'), beatEl = $('song-beat');
  if (document.activeElement !== bpmEl) bpmEl.value = Math.round((60 * 44100 / 4) / state.song.rowLen);
  if (document.activeElement !== rppEl) rppEl.value = state.song.patternLen;
  if (document.activeElement !== beatEl) beatEl.value = state.beatRows;
}

// render() replaces each grid's innerHTML wholesale, which resets its scroller to
// the top, so the cursor has to be put back in view afterwards or arrowing below
// the fold does nothing visible. block/inline 'nearest' restores the position
// after that rebuild and follows the cursor off-screen, while staying a no-op
// whenever the cursor is already visible.
function scrollCursorIntoView() {
  const el = state.editMode === 'sequence'
    ? $('seq-tbody').querySelector('td.cursor')
    : $('pat-scroll').querySelector('.pat-col.focused td.cursor');
  if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function render() {
  refreshSongControls();
  renderSequencer();
  renderPatterns();
  scrollCursorIntoView();
}

// --- playback row-following: main.js calls this every frame with the elapsed
// time of the playing buffer. It moves the real editing cursors rather than
// drawing a separate marker, so the pattern view switches to whatever pattern the
// playing row is on and the existing cursor/curRow highlighting doubles as the
// follow indicator with no new CSS. The grid re-renders only on an actual row
// change; the per-channel note highlight below runs every tick, since a note's
// envelope can end mid-row. ---
let followSeq = -1, followPat = -1;
// Populated by renderPatterns(), see its comment.
let patRowEls = [];

// Moves the curRow highlight (and, in pattern/fx edit mode, the live
// cursor cell -- the same one the "selected" range doesn't move, since
// followPlayback's setCursor calls always pass keepSelection=true) from
// `oldRow` to `newRow` in every channel's pattern column, without
// rebuilding any of the grid's markup. This is the fast path a mid-song
// row tick takes; a full render() only happens when the *set* of patterns
// shown actually changes (crossing a sequence step), not on every row.
function moveFollowRow(oldRow, newRow) {
  const mode = state.editMode, cursorCol = mode === 'pattern' ? pat.col : mode === 'fx' ? 4 : -1;
  for (let ch = 0; ch < patRowEls.length; ch++) {
    const rows = patRowEls[ch], focused = ch === state.selInstrument;
    if (oldRow >= 0 && rows[oldRow]) {
      rows[oldRow].classList.remove('curRow');
      if (focused && cursorCol >= 0) rows[oldRow].children[cursorCol].classList.remove('cursor');
    }
    if (newRow >= 0 && rows[newRow]) {
      rows[newRow].classList.add('curRow');
      if (focused && cursorCol >= 0) rows[newRow].children[cursorCol].classList.add('cursor');
      // Keep a playing song's row in view as it runs past the bottom of the
      // panel. Focused channel only, and 'nearest' is a no-op while the row is
      // already visible, so this stays cheap on a path that runs dozens of times
      // a second.
      if (focused) rows[newRow].scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }
}

// The sequence-row/channel range currently playing, set by setFollowRange()
// whenever main.js starts a render -- the full song by default, or a restricted
// range for "play selected"/solo-pattern (see getPlayRange() above).
// player-worker.js's buffer only contains samples from `firstRow`/`firstCol` on,
// so row 0 of *that* buffer is sequence row followRow0, not row 0; everything
// below that reads `t` against the buffer needs this offset to land on the right
// sequence/pattern position.
let followRow0 = 0, followCol0 = 0, followCol1 = engine.MAX_CHANNELS - 1;
export function setFollowRange(range) {
  followSeq = followPat = -1;
  followRow0 = range ? range.firstRow : 0;
  followCol0 = range ? range.firstCol : 0;
  followCol1 = range ? range.lastCol : engine.MAX_CHANNELS - 1;
}

// Which note, if any, channel `chan` is sounding at time t -- what decides
// whether panels/keyboard.js still shows a key lit. Scans backward through the
// pattern for the most recent note trigger, then checks whether we are still
// inside that note's total attack+release time.
function samplesSinceNote(t, chan) {
  const patternLen = state.song.patternLen;
  const nFloat = t * 44100 / state.song.rowLen;
  const n = Math.floor(nFloat);
  const seqPos0 = followRow0 + Math.floor(n / patternLen), patPos0 = n % patternLen;
  for (let k = 0; k < patternLen; k++) {
    let seqPos = seqPos0, patPos = patPos0 - k;
    while (patPos < 0) {
      seqPos--;
      if (seqPos < followRow0) return null;
      patPos += patternLen;
    }
    const pn = (state.song.songData[chan].p[seqPos] || 0) - 1;
    if (pn >= 0) {
      for (let col = 0; col < 4; col++) {
        const note = state.song.songData[chan].c[pn].n[patPos + col * patternLen];
        if (note > 0) return { note, samplesSince: (k + (nFloat - n)) * state.song.rowLen };
      }
    }
  }
  return null;
}
function channelActiveNote(t, chan) {
  const hit = samplesSinceNote(t, chan);
  if (!hit) return null;
  const i = state.song.songData[chan].i;
  const attack = i[engine.ENV_ATTACK] ** 2 * 4;
  const s = i[engine.ENV_SUSTAIN], r = i[engine.ENV_RELEASE];
  let total = attack + s * s * 4 + r * r * 4;
  if (total < 10000) total = 10000;
  return hit.samplesSince < total ? hit.note : null;
}

export function followPlayback(t) {
  const patternLen = state.song.patternLen;
  const n = Math.floor(t * 44100 / state.song.rowLen);
  const patPos = n % patternLen;
  const seqPos = followRow0 + Math.floor(n / patternLen);
  if (seqPos !== followSeq) {
    // Crossing a sequence step: which pattern each channel shows can
    // actually change, so this does need the full rebuild.
    followSeq = seqPos; followPat = patPos;
    state.selRow = seqPos;
    setCursor(seq, seq.col, seqPos, true);
    setCursor(pat, pat.col, patPos, true);
    setCursor(fx, 0, patPos, true);
    render(); notify();
  } else if (patPos !== followPat) {
    // Same pattern set, just a later row within it -- the common case, hit on
    // every playback row, up to dozens of times a second at high BPM. A full
    // render() here would rebuild all MAX_CHANNELS pattern columns' innerHTML
    // every tick, and that DOM rebuild plus layout contends with the scope's
    // canvas draw on the same thread. Moving the two affected classes is
    // enough.
    const oldPat = followPat;
    followPat = patPos;
    setCursor(pat, pat.col, patPos, true);
    setCursor(fx, 0, patPos, true);
    moveFollowRow(oldPat, patPos);
  }
  if (state.highlightNotes) {
    const notes = [];
    // Restricted to the range that's actually sounding (all channels for a
    // normal full-song play, since setFollowRange's default spans
    // 0..MAX_CHANNELS-1) -- a channel outside a "play selected" range wasn't
    // rendered by player-worker.js at all, so it has nothing to highlight.
    for (let ch = followCol0; ch <= followCol1 && ch < state.song.numChannels; ch++) {
      const note = channelActiveNote(t, ch);
      if (note !== null) notes.push(note);
    }
    state.highlightNotes(notes);
  }
}
export function stopFollowingPlayback() {
  followSeq = followPat = -1;
  state.highlightNotes && state.highlightNotes([]);
}

export function initTrackerPanel() {
  $('sequencer-panel').classList.remove('wip');
  $('sequencer-panel').innerHTML = `
    <h3 title="The song's running order. One row per step of the song, one column per channel; each cell says which of that channel's 36 patterns plays at that step.">Sequencer</h3>
    <div class="row trk-controls">
      <label title="Tempo, in beats per minute. Four rows make a beat, so this sets how fast the pattern rows run.">BPM <input id="song-bpm" type="number" min="10" max="1000"></label>
      <label title="How many rows every pattern in the song has. Shortening this throws away the notes past the new end.">Rows <input id="song-rpp" type="number" min="1" max="256"></label>
      <label title="Highlight every Nth row in both grids, so you can see where the beat is. 4 for 4/4, 3 for a waltz, 8 for 32nd-note patterns. A view setting — it changes nothing about the song.">Beat <input id="song-beat" type="number" min="1" max="32"></label>
    </div>
    <div class="trk-scroll" title="Click a cell, then type a pattern number (0-9, A-Z) to place a pattern; 0 or Backspace clears it. Arrow keys move, shift+arrows or click+drag select, Ctrl+C/Ctrl+V copy and paste a block. Clicking a column also picks that channel for the instrument panel.">
      <table class="trk-table"><thead id="seq-thead"></thead><tbody id="seq-tbody"></tbody></table></div>`;

  $('patterns-panel').classList.remove('wip');
  $('patterns-panel').innerHTML =
    `<h3 title="The notes in the patterns playing at the sequencer's current row — every channel side by side. The highlighted column is the one you are editing.">Patterns</h3>
     <div class="pat-scroll" id="pat-scroll" title="Four note columns per channel (four notes can sound at once) plus the narrow FX column. Play notes in with the piano, the computer keys, or double-click a cell for the note/chord pie. Alt+arrows transpose the selection; right-click for the rest."></div>`;

  $('song-bpm').oninput = () => {
    const bpm = +$('song-bpm').value;
    if (bpm >= 10 && bpm <= 1000) state.song.rowLen = engine.calcSamplesPerRow(bpm);
  };
  $('song-rpp').onchange = () => {
    const len = +$('song-rpp').value;
    if (len >= 1 && len <= 256 && len !== state.song.patternLen) {
      state.requestStop && state.requestStop();
      engine.setPatternLength(state.song, len);
      // Reset (not just clamp) both cursors -- a stale selection corner
      // beyond the new, possibly-shorter patternLen would silently read
      // past the resized n[]/f[] arrays on the next copy/delete.
      setCursor(pat, 0, 0);
      setCursor(fx, 0, 0);
      render(); notify();
    }
  };

  // A UI preference, not song data (see state.js) -- persisted, and it
  // deliberately doesn't mark the song dirty.
  $('song-beat').oninput = () => {
    const n = +$('song-beat').value;
    if (n >= 1 && n <= 32) {
      state.beatRows = n;
      savePrefs();
      render();
    }
  };

  $('seq-tbody').closest('table').addEventListener('mousedown', seqMouseDown);
  $('pat-scroll').addEventListener('mousedown', patternsMouseDown);
  $('pat-scroll').addEventListener('contextmenu', patternsContextMenu);
  document.addEventListener('mouseover', onMouseOver);
  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('keydown', onKeyDown);

  render();
}

export function refreshTrackerPanel() {
  render();
}
