// Tracker panel: the sequencer and the multi-column pattern grids.
//
// Every channel's pattern gets its own column, shown side by side in
// #patterns-panel. Which pattern a column shows is driven by state.selRow (the
// sequencer's current song row): channels[c].seq[state.selRow] is "the pattern
// this channel plays at the selected row" for every channel at once, so moving
// the sequencer cursor repaints every pattern column together.
//
// All MAX_CHANNELS=16 sequencer/pattern columns are always rendered, not just
// song.numChannels: a channel only activates (bumping numChannels via
// engine.recalcSongRanges) once it has a non-zero sequence entry, so the extra
// columns are exactly how a song grows past its current channel count.
//
// SUB-COLUMNS (v2)
// ----------------
// A channel has four voice columns, and each of those now has five fields:
//
//   Note   the pitch, or === for a note-off
//   Ins    which instrument from the song's pool, blank for "unchanged"
//   Vol    velocity 1-127, blank for "unchanged"
//   Cmd    an effect command
//   Val    its value
//
// So the pattern cursor addresses one of 4*5 = 20 cells per row, and every one
// of them is a plain number -- which is what lets the selection, clipboard and
// delete code below stay generic across all of them.
//
// Only the *focused* channel draws its Ins/Vol/Cmd/Val fields; the rest show
// their notes alone. Sixteen channels times twenty cells is far too wide to
// read, and the fields you can edit are the ones on the channel you are
// editing. Cells carrying a hidden field are marked instead (see patCellHTML),
// so nothing is ever invisible.
//
// There is no separate FX edit mode any more. In v1 the fx column was one
// per-channel track, so it needed its own cursor; in v2 an effect belongs to a
// voice column, so it is part of the pattern grid like every other field.
// panels/instrument.js's "select a cell, then touch a control to record it"
// flow still works -- activeFxCell() below reports a Cmd/Val cell instead.
//
// Note entry -- physical keyboard or panels/keyboard.js's on-screen piano --
// live-previews through the jammer (state.previewNote) and writes through
// enterNoteAtCursor(). Playback row-following is followPlayback();
// getPlayRange()/setFollowRange() restrict it to a sequence-row/channel range
// for "play selected" and solo-pattern playback (see main.js).

import * as engine from '../engine2.js';
import { state, savePrefs } from '../state.js';
import { SCALES, PITCH_NAMES, QUALITIES, slotOf, pitchName, scaleKeys, harmonyOf,
  diatonicChord, nameChord, qualityOf, quartalVoicing, wideVoicing, splitKeys, CHROMATIC } from '../scales.js';
import { padOf, rankNext } from '../chords.js';
import { openMenu } from '../menu.js';
import { keyHandledByFocus } from '../focus.js';
import { initPianoRoll, render as renderPianoRoll } from './pianoroll.js';

const $ = id => document.getElementById(id);
const NOTE_NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];
const EDIT_MODES = ['sequence', 'pattern'];

// The five fields of one voice column, and how many cells a voice occupies.
const F_NOTE = 0, F_INS = 1, F_VOL = 2, F_CMD = 3, F_VAL = 4, FIELDS = 5;
const voiceOf = col => (col / FIELDS) | 0;
const fieldOf = col => col % FIELDS;
// Which CSS class each field's cell carries, for widths and dimming.
const FIELD_CLASS = ['trk-note', 'trk-ins', 'trk-vol', 'trk-cmd', 'trk-val'];

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
  // Chord following splits the rows: the chord under your resting hand, the
  // key a row up (see followedChord below). It overrides the scale layout
  // rather than combining with it, since both want the same twenty keys.
  const chord = followedChord();
  if (chord) {
    return splitKeys(chord.intervals, chord.root, intervals || CHROMATIC, state.scaleRoot);
  }
  return intervals ? scaleKeys(intervals, state.scaleRoot) : NOTE_KEYS;
}

// --- song access, over engine2.js's shape ---------------------------------
const channelAt = c => state.song.channels[c];
function patternNumFor(channel) {
  return channelAt(channel).seq[state.selRow] || 0;
}
function patternOf(channel) {
  const pn = patternNumFor(channel);
  return pn ? channelAt(channel).pat[pn - 1] : null;
}
function focusedPatternNum() {
  return patternNumFor(state.selInstrument);
}
function focusedPattern() {
  return patternOf(state.selInstrument);
}

// --- chord following: what the melody keys play is decided by whatever chord
// is sounding underneath them, read live out of another channel's pattern.
//
// This needs nothing added to the song. A chord is already four notes on one
// row, patternLen is global so every channel's rows line up one to one, and
// patternOf() gives any channel's pattern at the current sequence row -- so
// "the chord playing right now" is a scan up the followed channel's own note
// columns from the row the cursor is on. Nothing is stored, nothing is
// exported, and a song written with this on is byte-identical to one written
// without it. It is a keyboard mapping, exactly like the scale presets.
//
// Which of a chord's notes is its root, and the intervals from it. The bass
// note cannot simply be assumed to be the root: voice leading inverts chords
// freely, so a wide or smoothed F7 can perfectly well sit with its fifth at the
// bottom -- read that way it comes out as an unnamable pile of intervals, and
// the key rows would start on a note the chord isn't built on.
//
// So each rotation is tried in turn, bass note first, and the first one the
// chord vocabulary can name wins. Bass first because a chord's bass usually
// *is* its root, and because it settles the genuinely ambiguous sets in the
// conventional way -- D F A C is a Dm7 when D is in the bass and an F6 when F
// is. Nothing nameable (an accidental cluster, hand-typed notes) falls back to
// reading the bass as the root, which is no worse than not looking.
//
// Returns the chord's root pitch class and its intervals from that root, ready
// for degreeOffset -- or null for "no chord here", which every caller reads as
// "carry on as normal": following switched off, the followed channel silent at
// this point in the song, the cursor above the first chord of the pattern, or a
// single note, which is not a chord to follow.
function rootOf(pitches, bass) {
  const from = cand => pitches.map(pc => (((pc - cand) % 12) + 12) % 12).sort((a, b) => a - b);
  for (const cand of [bass, ...pitches.filter(pc => pc !== bass)]) {
    const intervals = from(cand);
    if (qualityOf(intervals) !== null) return { root: cand, intervals };
  }
  return { root: bass, intervals: from(bass) };
}

export function followedChord() {
  const ch = state.followChannel;
  if (ch < 0 || ch >= engine.MAX_CHANNELS) return null;
  const p = patternOf(ch);
  if (!p) return null;
  const patternLen = state.song.patternLen;
  for (let row = Math.min(pat.row, patternLen - 1); row >= 0; row--) {
    const notes = [];
    for (let c = 0; c < 4; c++) {
      // A note-off is not a note to harmonize against.
      const v = engine.pitchOf(p.n[row + c * patternLen]);
      if (v > engine.NOTE_OFF) notes.push(v);
    }
    if (!notes.length) continue;
    notes.sort((a, b) => a - b);
    const pitches = [...new Set(notes.map(pitchOf))];
    if (pitches.length < 2) return null;   // one pitch class is a note, not a chord
    const { root, intervals } = rootOf(pitches, pitchOf(notes[0]));
    return { row, root, intervals, name: nameChord(root, intervals) };
  }
  return null;
}

function toHex(n, count) {
  return n.toString(16).toUpperCase().padStart(count, '0');
}

// --- cursor/selection: one plain object per grid (sequencer/pattern).
// col/row is the single active cell, which typing and paste target; col1/row1
// and col2/row2 are the two corners of the selection rectangle. Both corners
// collapse onto col/row on a plain click; dragging or shift+arrow moves
// col1/row1 while col2/row2 stays pinned at the click/paste anchor. ---
function makeCursor() {
  return { col: 0, row: 0, col1: 0, row1: 0, col2: 0, row2: 0, copyBuf: null };
}
const seq = makeCursor(), pat = makeCursor();

const selLeft = c => Math.min(c.col1, c.col2);
const selRight = c => Math.max(c.col1, c.col2);
const selTop = c => Math.min(c.row1, c.row2);
const selBottom = c => Math.max(c.row1, c.row2);
const isSelected = (c, col, row) => col >= selLeft(c) && col <= selRight(c) && row >= selTop(c) && row <= selBottom(c);
// The half-typed value in a Val cell lives only while the cursor stays on that
// cell, so both of these drop it. Without that, arrowing away from a half-typed
// "-1." and back would carry on appending to it.
function setCursor(c, col, row, keepSelection) {
  if (c === pat && (col !== c.col || row !== c.row)) valBuf = '';
  c.col = col; c.row = row;
  if (!keepSelection) { c.col1 = c.col2 = col; c.row1 = c.row2 = row; }
}
function extendSelection(c, col, row) { valBuf = ''; c.col1 = col; c.row1 = row; }
// Ctrl+A. "All" is the whole active grid -- for the pattern that's every row
// of all 20 cells, i.e. every note, field and effect in the pattern. The active
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

function cursorFor(mode) { return mode === 'sequence' ? seq : pat; }
function gridFor(mode) { return mode === 'sequence' ? seqGrid : patGrid; }

// Format pattern number as 0-9,A-Z for display
function formatPatternNum(v) {
  return v > 0 ? (v <= 10 ? '' + (v - 1) : String.fromCharCode(64 + v - 10)) : '';
}

const seqGrid = {
  numcols: () => engine.MAX_CHANNELS,
  numrows: () => Math.min(engine.MAX_SONG_ROWS, Math.max(64, state.song.endPattern + 32)),
  get: (col, row) => channelAt(col).seq[row] || 0,
  set: (col, row, v) => { channelAt(col).seq[row] = v; engine.recalcSongRanges(state.song); },
  clear: (col, row) => { channelAt(col).seq[row] = 0; engine.recalcSongRanges(state.song); },
  toHTML: formatPatternNum,
};

// --- the pattern grid, one cell per (voice, field) pair -------------------
//
// Every field reads and writes a single number, so the generic selection,
// clipboard and delete code above needs no special case for any of them. The
// packing of note/instrument/velocity into one stored value is entirely inside
// these two functions.
function fieldGet(p, row, col) {
  const patternLen = state.song.patternLen;
  const s = row + voiceOf(col) * patternLen;
  const n = p.n[s];
  switch (fieldOf(col)) {
    case F_NOTE: return engine.pitchOf(n);
    // Stored as instrument + 1 so that 0 can mean "unchanged"; shown that way
    // too, rather than being unpacked here and repacked on the way back in.
    case F_INS: return n >> 15;
    case F_VOL: return engine.velOf(n);
    case F_CMD: return p.e[s * 2] || 0;
    default: return p.e[s * 2 + 1] || 0;
  }
}

function fieldSet(p, row, col, v) {
  const patternLen = state.song.patternLen;
  const s = row + voiceOf(col) * patternLen;
  switch (fieldOf(col)) {
    case F_NOTE: p.n[s] = engine.withPitch(p.n[s], v); break;
    case F_INS: p.n[s] = engine.withIns(p.n[s], v - 1); break;
    case F_VOL: p.n[s] = engine.withVel(p.n[s], v); break;
    case F_CMD: p.e[s * 2] = v; break;
    default: p.e[s * 2 + 1] = v;
  }
}

const patGrid = {
  numcols: () => 4 * FIELDS,
  numrows: () => state.song.patternLen,
  get(col, row) {
    const p = focusedPattern();
    return p ? fieldGet(p, row, col) : 0;
  },
  set(col, row, v) {
    const p = focusedPattern();
    if (p) fieldSet(p, row, col, v);
  },
  clear(col, row) { this.set(col, row, 0); },
};

// What one cell prints. `cmd` is the command stored beside it, which the value
// field needs in order to show a tempo as BPM.
function fieldHTML(v, col, p, row) {
  switch (fieldOf(col)) {
    case F_NOTE:
      if (!v) return '';
      // The classic tracker note-off glyph. It has to be visibly not a pitch,
      // because a note-off is the one event that ends a sound rather than
      // making one.
      if (v === engine.NOTE_OFF) return '===';
      // Floor division and a positive modulo, so a pitch below NOTE_OFFSET
      // still names itself instead of indexing NOTE_NAMES with a negative
      // number and printing "undefined". Transposing down can reach one.
      const n = v - engine.NOTE_OFFSET;
      return NOTE_NAMES[((n % 12) + 12) % 12] + Math.floor(n / 12);
    case F_INS: return v ? toHex(v - 1, 2) : '';
    case F_VOL: return v ? toHex(v, 2) : '';
    case F_CMD: return engine.cmdLabel(v);
    default: {
      const cmd = p ? p.e[(row + voiceOf(col) * state.song.patternLen) * 2] : 0;
      if (!cmd) return v ? valText(v) : '';
      // A tempo is stored as a row length in samples, which is a five-digit
      // number nobody can read as a speed. Shown as the BPM it produces.
      if (cmd === engine.TEMPO) return v > 0 ? engine.bpmOf(v) + '' : '';
      return valText(v);
    }
  }
}

// Effect values are plain numbers, not bytes: they can be negative and they
// can be fractional. Trailing zeros are trimmed so an ordinary whole number
// still reads as one.
function valText(v) {
  if (!v) return '';
  return Number.isInteger(v) ? '' + v : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

// Read by panels/instrument.js: when a Cmd or Val cell is selected, the
// instrument sliders and icons write that cell's command as well as the live
// value. A small pull-based API on purpose, so instrument.js needs to know
// nothing about this module's cursor shape.
//
// Only the channel-strip half of the panel can be recorded. A voice parameter
// is snapshotted at note-on, so writing one part-way through a note would
// change nothing -- see the PARAM comment in src/js/core/voxby.js.
export function activeFxCell() {
  if (state.editMode !== 'pattern') return null;
  const f = fieldOf(pat.col);
  if (f !== F_CMD && f !== F_VAL) return null;
  const p = focusedPattern();
  if (!p) return null;
  const s = pat.row + voiceOf(pat.col) * state.song.patternLen;
  return {
    cmd: p.e[s * 2] || 0,
    val: p.e[s * 2 + 1] || 0,
    // `fxIndex` is an index into the channel strip, which is what the panel
    // has; the stored command is that plus PARAM.
    set(fxIndex, value) {
      p.e[s * 2] = engine.PARAM + fxIndex;
      p.e[s * 2 + 1] = value;
      updatePatternCell(state.selInstrument, voiceOf(pat.col) * FIELDS + F_CMD, pat.row);
      updatePatternCell(state.selInstrument, voiceOf(pat.col) * FIELDS + F_VAL, pat.row);
    },
  };
}

// Writes an already-computed note number at the pattern cursor and advances it.
// Both entry paths come through here -- this file's physical-keyboard handling
// below and panels/keyboard.js's on-screen piano -- so they can't drift apart.
//
// The cursor is snapped onto the voice's Note field first. The on-screen piano
// can be clicked while the cursor sits on a Vol or Cmd cell, and a note has
// only one place it can go.
export function enterNoteAtCursor(note) {
  if (state.editMode !== 'pattern') return;
  if (!focusedPatternNum()) {
    flashFeedback('No pattern at this sequence row — assign one in the sequencer');
    return;
  }
  pushUndo();
  const row = pat.row, col = voiceOf(pat.col) * FIELDS + F_NOTE;
  const channel = state.selInstrument;
  if (state.chordOn) {
    // A chord is a row-level unit (the same way insertRowAtCursor already
    // treats a row), so it fills from voice 0 rightward rather than from
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
    // Chord writes all 4 voices, so the fast path doesn't apply - full render
    setCursor(pat, col, advancedRow(row));
    render(); notify();
  } else {
    const oldCol = pat.col, oldRow = row;
    patGrid.set(col, row, note);
    setCursor(pat, col, advancedRow(row));
    updatePatternCell(channel, col, row);
    moveCursor(oldCol, oldRow, pat.col, pat.row);
    notify();
  }
}

// Where an entry moves the cursor to: state.editStep rows on, a tracker's edit
// step (see state.js). 0 leaves the cursor put; the modulo still has to wrap a
// step that lands exactly on numrows.
function advancedRow(row) {
  return (row + Math.max(0, state.editStep | 0)) % patGrid.numrows();
}

// --- chord entry. The data model holds 4 notes per row (n[row + col*patternLen],
// voices 0-3), so a chord is at most 4 tones, exactly the 4 voices available.
// Only where those intervals come from differs between the two modes.

const pitchOf = note => (((note - engine.NOTE_OFFSET) % 12) + 12) % 12;

// Turns `root` plus a chord's intervals into absolute notes, dropping the tones
// whose R/3/5/7/9/11/13 toggle is off and packing what's left to the left, so a
// rootless voicing lands in voices 0-2 rather than leaving a hole where the
// root would have been. Never returns empty -- with every toggle off, the
// played note itself still goes in -- and never returns more than the 4 notes a
// row can hold.
//
// Which toggle a tone answers to is scales.js's slotOf(), the interval's
// function in the stack, rather than its index in this particular chord: those
// agree for a plain R/3/5/7 stack but not for anything with a gap in it (add9
// is [0,4,7,14], whose 9th used to consult the "7" toggle).
function voiced(root, intervals) {
  const keep = intervals.filter(iv => state.chordTones[slotOf(iv)]);
  return (keep.length ? keep : [intervals[0]]).slice(0, 4).map(iv => root + iv);
}

const bareNote = note => ({ notes: [note], name: PITCH_NAMES[pitchOf(note)] });

// The chord the scale itself puts on `note`: stack every other degree of the
// *harmony* scale -- harmonyOf(), not the input scale, so a 5-note pentatonic
// still spells real 7th chords (see scales.js). With no scale, or a note the
// harmony scale doesn't contain (the blues b5, an out-of-key click), there's
// no quality to infer, so this is just the note.
// The name is taken from the full chord, before voicing drops anything.
function diatonicAt(note) {
  const intervals = harmonyOf(state.scaleMode);
  const deltas = intervals && diatonicChord(intervals, state.scaleRoot, pitchOf(note));
  return deltas
    ? { notes: voiced(note, deltas), name: nameChord(pitchOf(note), deltas) }
    : bareNote(note);
}

// What one keypress on `note` writes: the diatonic chord if chord mode is on,
// the bare note otherwise.
function chordAt(note) {
  return state.chordOn ? diatonicAt(note) : bareNote(note);
}

// The one place a (note, quality) pair becomes actual notes plus a name, so no
// two callers can spell the same chord differently. `quality` is 'auto' for
// whatever the scale harmonizes the note to, a QUALITIES key ('maj7', 'm7',
// ...) for a named one, or anything else (null) for the bare note. `flat`
// spells the root downwards (B♭ rather than A#) for a caller that knows the
// chord is a flat degree of its key -- the chord pads, and nothing else.
export function chordFor(note, quality, flat) {
  if (quality === 'auto') return diatonicAt(note);
  const q = QUALITIES[quality];
  if (!q) return bareNote(note);
  return { notes: voiced(note, q[1]), name: pitchName(pitchOf(note), flat) + q[0] };
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
  const p = focusedPattern();
  if (!p) return;
  const patternLen = state.song.patternLen;
  // A chord replaces the row outright, velocity and instrument fields
  // included: those describe the note that was there, not the one going in.
  for (let c = 0; c < 4; c++) p.n[row + c * patternLen] = notes[c] || 0;
}

// state.previewNote takes a *relative* key offset and does the
// offset + octave*12 + NOTE_OFFSET math itself (see state.js); feeding it the
// exact inverse gets an absolute note previewed through the jammer without a
// second callback field just for this.
function previewNotes(notes) {
  if (!state.previewNote) return;
  for (const note of notes) state.previewNote(note - state.octave * 12 - engine.NOTE_OFFSET);
}

// --- chord pads (chords.js). A pad is a degree plus a quality, so which actual
// chord it is depends on the key (state.scaleRoot) and the register
// (state.octave) at the moment it is pressed -- resolved here rather than
// baked into the pad, which is what lets a root transpose move the whole set
// at once. It goes through chordFor() like everything else, so a pad and a
// scale-harmonized keypress that land on the same chord spell it identically.
export function padChord(i) {
  const pad = padOf(state.flavor, i);
  if (!pad) return null;
  const note = pad[0] + state.scaleRoot + state.octave * 12 + engine.NOTE_OFFSET;
  // A pad whose roman numeral is flat is a flat degree, so its root is spelled
  // flat: the ♭VII pad in C reads B♭, not A#.
  const c = chordFor(note, pad[1], pad[2][0] === '♭');
  // How the chord is spread out, which is a separate question from which chord
  // it is -- the name is the same whichever of these wrote the notes.
  //
  // Wide re-arranges the tones the R/3/5/7 toggles already chose, so it stacks
  // on top of them. Quartal doesn't: it is built from a mode rather than from
  // the chord's own notes, so there is nothing for those toggles to pick from
  // and the keyboard panel dims them while it is on.
  const quartal = state.voicing === 'quartal';
  const notes = quartal ? quartalVoicing(QUALITIES[pad[1]][1]).map(iv => note + iv)
    : state.voicing === 'wide' ? wideVoicing(c.notes)
    : c.notes;
  // Only a close voicing gets inverted by the voice leading: wide and quartal
  // are shapes, and rotating a tone out of one takes it apart.
  return { ...c, notes: smoothed(notes, state.voicing !== 'close'), roman: pad[2], note };
}

// --- voice leading. Root position for every chord is the loudest tell of
// beginner chord writing: each one leaps to wherever its root happens to be,
// and the progression lurches rather than moves. Real playing keeps the notes
// that two chords share where they are and moves the rest as little as
// possible, which is what this searches for.
//
// The candidates are the chord's own inversions (rotating tones up an octave
// one at a time) at three registers, scored by how far each tone sits from the
// nearest tone of the chord before it. Searching around the chord's *own* root
// position rather than around the previous chord is what stops a long
// progression drifting off the end of the keyboard: every chord lands within
// an octave of where it would have been anyway.
//
// `keepShape` drops the inversions and leaves only the octave shifts, for the
// voicings whose shape is the entire point of asking for them.
function smoothed(notes, keepShape) {
  const prev = lastChordNotes;
  if (!state.smoothVoicing || !prev || notes.length < 2) return notes;
  let best = notes, bestCost = Infinity;
  const inversions = keepShape ? 1 : notes.length;
  for (let inv = 0; inv < inversions; inv++) {
    const rotated = notes.map((n, i) => (i < inv ? n + 12 : n)).sort((a, b) => a - b);
    for (let oct = -1; oct <= 1; oct++) {
      const cand = rotated.map(n => n + oct * 12);
      if (cand[0] < NOTE_MIN || cand[cand.length - 1] > NOTE_MAX) continue;
      const cost = cand.reduce((sum, n) => sum + Math.min(...prev.map(p => Math.abs(p - n))), 0);
      if (cost < bestCost) { bestCost = cost; best = cand; }
    }
  }
  return best;
}

// What the chord pads know about each other: which pad was played last, and
// how it was voiced. Both are entry context rather than song data -- nothing
// here is saved, and reloading a song starts the next chord from scratch.
let lastPad = -1, lastChordNotes = null;

// The pads worth trying next, for the strip's suggestion highlight. Empty
// until a pad has been played, which is also what makes the highlight legible:
// it appears in response to something, rather than being on from the start.
export function suggestedPads() {
  return rankNext(state.flavor, lastPad);
}

// Called when the flavor changes: pad 3 of Pop says nothing about pad 3 of
// Jazz, and voice-leading the first chord of a new set to the last chord of
// the old one is leading from somewhere the user has left.
export function resetChordContext() {
  lastPad = -1;
  lastChordNotes = null;
}

// Sounds the pad and, in pattern edit mode, writes it across the row's 4 voice
// columns and advances by the edit step. Sounding it either way is deliberate:
// pressing a pad in sequence mode is still someone asking to hear that chord,
// and going silent there would read as the pad being broken.
export function enterPadAtCursor(i) {
  const c = padChord(i);
  if (!c) return false;
  previewNotes(c.notes);
  state.chordName = c.name;
  lastPad = i;
  lastChordNotes = c.notes;
  if (state.editMode === 'pattern' && focusedPatternNum()) {
    const row = pat.row;
    writeChordRow(row, c.notes);
    setCursor(pat, voiceOf(pat.col) * FIELDS + F_NOTE, advancedRow(row));
  }
  render(); notify();
  return true;
}

// The digit row, when a flavor is set. Digits 1-9 then 0 are pads 0-9; a digit
// with no pad behind it (every flavor is 8 long, so 9 and 0) falls through and
// keeps its chromatic meaning as a sharp, rather than being silently eaten.
const PAD_KEYS = {
  Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3, Digit5: 4,
  Digit6: 5, Digit7: 6, Digit8: 7, Digit9: 8, Digit0: 9,
};

// Enter inserts an empty row at the cursor, pushing that row and everything
// below it down one -- the whole pattern row, all four voices and both their
// note and effect data, since a "row" is the musical unit here. patternLen is
// fixed, so the last row's content falls off the end (same tradeoff any
// fixed-length insert makes -- there's nowhere else for it to go).
function insertRowAtCursor(row) {
  const p = focusedPattern();
  if (!p) return;
  pushUndo();
  const patternLen = state.song.patternLen;
  for (let c = 0; c < 4; c++) {
    for (let r = patternLen - 1; r > row; r--) {
      p.n[r + c * patternLen] = p.n[r - 1 + c * patternLen];
      p.e[(r + c * patternLen) * 2] = p.e[(r - 1 + c * patternLen) * 2];
      p.e[(r + c * patternLen) * 2 + 1] = p.e[(r - 1 + c * patternLen) * 2 + 1];
    }
    p.n[row + c * patternLen] = 0;
    p.e[(row + c * patternLen) * 2] = 0;
    p.e[(row + c * patternLen) * 2 + 1] = 0;
  }
}

// --- transpose. Acts on the pattern selection exactly as drawn: one cell, a
// column, or a block dragged across several voices. Only Note fields move --
// a selection that happens to include a velocity or an effect value leaves
// those alone, because transposing a number that isn't a pitch is meaningless.
// Empty cells and note-offs stay as they are: transposing a rest would invent
// a note, and a note-off has no pitch to move.
//
// Refuses the whole operation rather than clamping if any note would leave the
// storable range (a pitch is a single byte, so 2-255 for a real note, with 0
// meaning "no note" and 1 meaning note-off). Clamping would silently collapse
// the intervals of a chord against the ceiling, which is worse than nothing
// happening.
const NOTE_MIN = 2, NOTE_MAX = 255;

function transposeSelection(delta) {
  const p = focusedPattern();
  if (!p) return;
  const patternLen = state.song.patternLen;
  const moves = [];
  forSelection(pat, (col, row) => {
    if (fieldOf(col) !== F_NOTE) return;
    const i = row + voiceOf(col) * patternLen;
    const pitch = engine.pitchOf(p.n[i]);
    if (pitch > engine.NOTE_OFF) moves.push([i, pitch + delta]);
  });
  if (!moves.length || moves.some(([, v]) => v < NOTE_MIN || v > NOTE_MAX)) return;
  pushUndo();
  for (const [i, v] of moves) p.n[i] = engine.withPitch(p.n[i], v);
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
  if (!t) return;
  e.preventDefault();
  dragMode = null;
  if (state.editMode !== 'pattern' || t.channel !== state.selInstrument || !isSelected(pat, t.col, t.row)) {
    const oldChannel = state.selInstrument, oldMode = state.editMode;
    const oldCol = pat.col, oldRow = pat.row;
    state.selInstrument = t.channel;
    state.editMode = 'pattern';
    setCursor(pat, t.col, t.row);
    if (oldMode === 'pattern' && oldChannel === t.channel) {
      moveCursor(oldCol, oldRow, t.col, t.row);
      notify();
    } else {
      render(); notify();
    }
  }
  openMenu(e.clientX, e.clientY, [
    { label: 'Select all', hint: 'Ctrl+A', run: () => { selectAll(pat, patGrid); render(); } },
    { label: 'Copy', hint: 'Ctrl+C', run: () => copySelection('pattern') },
    { label: 'Paste', hint: 'Ctrl+V', run: () => doPaste('pattern') },
    null,
    { label: 'Note off', hint: '`', run: () => { writeNoteOff(); render(); notify(); } },
    null,
    { label: 'Transpose +1 semitone', hint: 'Alt+↑', run: () => transposeSelection(1) },
    { label: 'Transpose −1 semitone', hint: 'Alt+↓', run: () => transposeSelection(-1) },
    null,
    { label: 'Transpose +1 octave', hint: 'Alt+Shift+↑', run: () => transposeSelection(12) },
    { label: 'Transpose −1 octave', hint: 'Alt+Shift+↓', run: () => transposeSelection(-12) },
  ]);
}

// What Space and "Play selected" play.
//
// The default is what is on screen: the sequence row being edited
// (state.selRow), on every channel that is toggled on in the sequencer header.
// That is the same answer in both views -- the row you hear is the row you see,
// in context with the parts around it, not the one channel you happen to be
// typing into. Muting the header toggles is how you hear less than that.
//
// A real selection in the sequencer overrides that, because dragging or
// shift+arrowing a block is a deliberate statement about what to hear. A single
// cell is not one -- it is only where the cursor came to rest -- so it plays the
// default like everywhere else.
export function getPlayRange() {
  if (state.editMode === 'sequence' && (selLeft(seq) !== selRight(seq) || selTop(seq) !== selBottom(seq))) {
    return { firstRow: selTop(seq), lastRow: selBottom(seq), firstCol: selLeft(seq), lastCol: selRight(seq) };
  }
  const cols = [];
  for (let ch = 0; ch < state.song.numChannels; ch++) {
    if (state.channelsEnabled[ch] && channelAt(ch).seq[state.selRow]) cols.push(ch);
  }
  // Nothing assigned at this row on any unmuted channel: render the focused
  // channel by itself, which is one pattern of silence. The transport stays
  // predictable (press, hear a bar of nothing, press again) and the worker never
  // sees a column range it cannot make sense of.
  if (!cols.length) {
    return { firstRow: state.selRow, lastRow: state.selRow, firstCol: state.selInstrument, lastCol: state.selInstrument };
  }
  return {
    firstRow: state.selRow, lastRow: state.selRow,
    firstCol: cols[0], lastCol: cols[cols.length - 1], cols,
  };
}

// --- undo. One pattern's notes and effects together: they are edited as one
// grid now, and an undo that restored the notes but not the effects beside
// them would leave a row describing something nobody wrote. ---
function snapshot() {
  const p = focusedPattern();
  if (!p) return null;
  return {
    notes: [...p.n],
    fx: [...p.e],
    channel: state.selInstrument,
    seqRow: state.selRow,
    pattern: focusedPatternNum(),
  };
}

function sameSnapshot(a, b) {
  if (a.channel !== b.channel || a.seqRow !== b.seqRow || a.pattern !== b.pattern) return false;
  if (a.notes.length !== b.notes.length || a.fx.length !== b.fx.length) return false;
  for (let i = 0; i < a.notes.length; i++) if (a.notes[i] !== b.notes[i]) return false;
  for (let i = 0; i < a.fx.length; i++) if (a.fx[i] !== b.fx[i]) return false;
  return true;
}

function pushUndo() {
  const s = snapshot();
  if (!s) return;
  // Don't push a state identical to the last one: it would make one Ctrl+Z do
  // nothing at all.
  const last = state.undoStack[state.undoStack.length - 1];
  if (last && sameSnapshot(last, s)) return;
  state.undoStack.push(s);
  state.redoStack = [];
  if (state.undoStack.length > 50) state.undoStack.shift();
}

// Undo and redo are the same move in opposite directions, so they are one
// function: take the top of `from`, put the current state on `to`, restore.
function restoreFrom(from, to) {
  if (!from.length) return;
  const now = snapshot();
  if (now) to.push(now);
  const s = from.pop();
  const ch = state.song.channels[s.channel];
  const p = ch && ch.pat[s.pattern - 1];
  if (!p) return;
  p.n = [...s.notes];
  p.e = [...s.fx];
  setCursor(pat, 0, 0);
  render();
  notify();
}

function undo() { restoreFrom(state.undoStack, state.redoStack); }
function redo() { restoreFrom(state.redoStack, state.undoStack); }

// --- copy/paste, generic across both grids ---
function copySelection(mode) {
  const grid = gridFor(mode), c = cursorFor(mode);
  c.copyBuf = [];
  for (let row = selTop(c); row <= selBottom(c); row++) {
    const line = [];
    for (let col = selLeft(c); col <= selRight(c); col++) line.push(grid.get(col, row));
    c.copyBuf.push(line);
  }
  // Which field the block started on, so a paste can refuse to smear a
  // velocity into a command column. See pasteSelection.
  c.copyCol = selLeft(c);
}
function pasteSelection(mode) {
  const grid = gridFor(mode), c = cursorFor(mode);
  if (!c.copyBuf) return;
  // A pattern block is realigned onto the field it was copied from. The five
  // fields hold different kinds of number, and pasting a column of pitches one
  // cell to the right would write them into the instrument column as garbage.
  let startCol = c.col;
  if (mode === 'pattern' && c.copyCol !== undefined) {
    startCol = voiceOf(c.col) * FIELDS + fieldOf(c.copyCol);
  }
  for (let row = c.row, i = 0; row < grid.numrows() && i < c.copyBuf.length; row++, i++)
    for (let col = startCol, j = 0; col < grid.numcols() && j < c.copyBuf[i].length; col++, j++)
      grid.set(col, row, c.copyBuf[i][j]);
}
// The whole paste, shared by Ctrl+V and the right-click menu so the two can't
// drift.
function doPaste(mode) {
  const c = cursorFor(mode);
  const isSingleCell = c.copyBuf && c.copyBuf.length === 1 && c.copyBuf[0].length === 1;
  if (mode !== 'sequence') pushUndo();
  pasteSelection(mode);
  if (mode === 'sequence') syncSeqIntoState();
  if (mode === 'pattern' && isSingleCell) {
    updatePatternCell(state.selInstrument, pat.col, pat.row);
    notify();
  } else {
    render(); notify();
  }
}

// --- keyboard navigation (arrows/home/end/backspace/delete), generic across
// both grids. Returns true if it handled the key. ---
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
      if (mode !== 'sequence') pushUndo();
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
  return true;
}

// Shared by the octave keys below and the keyboard panel's own +/- buttons
// (via state.notify), so both clamp the same way. 1-8 is the engine's playable
// range (see panels/keyboard.js).
export function shiftOctave(d) {
  state.octave = Math.min(8, Math.max(1, state.octave + d));
  // No pattern content changes, just an input preference — skip render
  notify();
}

// --- typing into the non-note fields ---------------------------------------
//
// Instrument and velocity take hex digits and shift them in from the right,
// the way every tracker does: type 4 then 0 and the cell reads 40. Two digits
// is the whole field, so a third starts again from the right.
function typeHex(col, digit, max) {
  const cur = patGrid.get(col, pat.row);
  let v = ((cur << 4) | digit) & 0xff;
  if (v > max) v = digit;          // the shift overflowed: start over
  return v;
}

// The value field takes decimal, because effect values are plain numbers --
// signed, and fractional for a gate length or a slide rate. Digits accumulate
// into a text buffer that lives only while the cursor stays on the cell, so
// half-typed "-1." is never stored; setCursor clears it.
let valBuf = '';

const VAL_KEYS = {
  Digit0: '0', Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4',
  Digit5: '5', Digit6: '6', Digit7: '7', Digit8: '8', Digit9: '9',
  Numpad0: '0', Numpad1: '1', Numpad2: '2', Numpad3: '3', Numpad4: '4',
  Numpad5: '5', Numpad6: '6', Numpad7: '7', Numpad8: '8', Numpad9: '9',
  Period: '.', NumpadDecimal: '.', Minus: '-', NumpadSubtract: '-',
};

// Commit whatever is in the buffer to the cell. A tempo is typed as BPM and
// stored as a row length, since that is the unit the player indexes rows with.
function commitVal(col) {
  const n = parseFloat(valBuf);
  if (!isFinite(n)) return;
  const p = focusedPattern();
  const cmd = p ? p.e[(pat.row + voiceOf(col) * state.song.patternLen) * 2] : 0;
  patGrid.set(col, pat.row, cmd === engine.TEMPO && n > 0 ? engine.calcSamplesPerRow(n) : n);
}

// Writes a note-off across the selection's Note fields, or at the cursor's own
// voice when nothing is selected. A note-off is the event that ends a held
// sound, so it is worth a key of its own rather than a hex value typed into a
// field: backquote, which sits under the same finger a tracker's note-off has
// always been on and is never a note key in either layout.
function writeNoteOff() {
  const p = focusedPattern();
  if (!p) return;
  pushUndo();
  const patternLen = state.song.patternLen;
  let wrote = false;
  forSelection(pat, (col, row) => {
    if (fieldOf(col) !== F_NOTE) return;
    p.n[row + voiceOf(col) * patternLen] = engine.NOTE_OFF;
    wrote = true;
  });
  if (!wrote) p.n[pat.row + voiceOf(pat.col) * patternLen] = engine.NOTE_OFF;
  setCursor(pat, voiceOf(pat.col) * FIELDS + F_NOTE, advancedRow(pat.row));
}

function onKeyDown(e) {
  // Only the keys the focused control genuinely uses are given up (see
  // focus.js): a focused slider keeps its arrows, and everything else -- notes,
  // octave, clipboard -- still reaches the grids.
  if (keyHandledByFocus(e)) return;

  // Octave: Minus, or Shift+Comma ("<"); Equal, or Shift+Period (">"). Matched
  // on e.code, like note entry, not on the printed character: e.key reflects
  // what the OS layout prints on a key, and on German/Swiss QWERTZ that is "-"
  // for the physical key at the Slash position (layouts.js's QWERTZ table) --
  // a genuine note key (offset 16). Minus/Equal are never note keys, so they
  // always mean octave; Comma/Period need Shift, since unshifted they are notes.
  //
  // The value field claims Minus and Period for itself, since a negative or
  // fractional effect value has to be typeable; the octave keeps Equal and the
  // two shifted forms there.
  const onVal = state.editMode === 'pattern' && fieldOf(pat.col) === F_VAL;
  if ((e.code === 'Minus' && !onVal) || (e.code === 'Comma' && e.shiftKey)) { shiftOctave(-1); return; }
  if (e.code === 'Equal' || (e.code === 'Period' && e.shiftKey)) { shiftOctave(1); return; }

  // In piano-roll view the piano roll replaces the pattern grid and installs its
  // own document keydown handler, so everything below belongs to it instead --
  // except when the sequencer itself has the cursor (editMode 'sequence', set
  // only by clicking a sequencer cell; see seqMouseDown). Assigning, clearing or
  // copying a pattern number is a sequencer operation wherever the sequencer is
  // drawn, and pianoroll.js has no keyboard route of its own into seqGrid.
  // pianoroll.js's own guard is the exact mirror of this one, so the two
  // handlers never both act on the same keypress.
  if (state.viewMode === 'pianoroll' && state.editMode !== 'sequence') return;

  // Escape leaves the sequencer for the pattern grid. Clicking a pattern cell
  // does the same, but a channel with no pattern refuses that click, so the
  // sequencer could otherwise hold the keyboard with no way out. In the pattern
  // grid it collapses the selection back to the cursor cell.
  if (e.code === 'Escape') {
    if (state.editMode === 'sequence') state.editMode = 'pattern';
    else { const c = cursorFor(state.editMode); setCursor(c, c.col, c.row); }
    render(); notify();
    e.preventDefault();
    return;
  }

  if (e.code === 'Tab') {
    e.preventDefault();
    const i = EDIT_MODES.indexOf(state.editMode);
    state.editMode = EDIT_MODES[(i + (e.shiftKey ? -1 : 1) + 2) % 2];
    render();
    notify();
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
  // Ctrl+Shift+Z first (redo), then Ctrl+Z (undo)
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyZ') { redo(); e.preventDefault(); return; }
  if (e.ctrlKey && e.code === 'KeyZ' && !e.shiftKey) { undo(); e.preventDefault(); return; }

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
  } else if (state.editMode === 'pattern') {
    const field = fieldOf(pat.col);

    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      insertRowAtCursor(pat.row);
      render(); notify();
      e.preventDefault();
      return;
    }
    // Backquote writes a note-off. Checked before everything else in pattern
    // mode: it is never a note key and never a value digit, so nothing else
    // wants it.
    if (e.code === 'Backquote') {
      writeNoteOff();
      render(); notify();
      e.preventDefault();
      return;
    }
    // Shift+Delete/Backspace clears the whole row -- all 4 voices, notes and
    // effects, since a chord is entered as a row and wants deleting as one too
    // (plain Delete still clears just the cell/selection below). Checked before
    // handleNav, whose Delete case would otherwise read the shift key as
    // "extend the selection".
    if (e.shiftKey && (e.code === 'Delete' || e.code === 'Backspace')) {
      pushUndo();
      clearRow(pat.row);
      setCursor(pat, pat.col, (pat.row + 1) % patGrid.numrows());
      render(); notify();
      e.preventDefault();
      return;
    }
    // Transpose shortcuts, matching the right-click menu. Alt is the one free
    // modifier here: ctrl+arrows already jump to the end of a grid and
    // shift+arrows extend the selection (both in handleNav), and this has to be
    // checked before it for the shift+alt pair to mean an octave rather than a
    // selection.
    if (e.altKey && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) {
      transposeSelection((e.code === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1));
      e.preventDefault();
      return;
    }

    // --- the four non-note fields claim the typing keys before the piano does.
    // A digit is a hex nibble in the Ins and Vol columns and a decimal digit in
    // Val, and those columns are where the cursor has to be for it to mean
    // that -- so the same key still plays a note everywhere else.
    if (!e.ctrlKey && !e.altKey && !e.metaKey) {
      if (field === F_INS || field === F_VOL) {
        const d = hexDigit(e.code);
        if (d >= 0) {
          pushUndo();
          // Velocity is 1-127, and an instrument field holds pool index + 1,
          // so both cap below the byte the shift produces.
          const max = field === F_VOL ? 127 : state.song.instruments.length;
          patGrid.set(pat.col, pat.row, typeHex(pat.col, d, max));
          updatePatternCell(state.selInstrument, pat.col, pat.row);
          notify();
          e.preventDefault();
          return;
        }
      }
      if (field === F_CMD) {
        const cmd = engine.CMD_KEYS[e.code];
        if (cmd) {
          pushUndo();
          patGrid.set(pat.col, pat.row, cmd);
          updatePatternCell(state.selInstrument, pat.col, pat.row);
          // The value beside it means something different now, so it is shown
          // again through the new command's eyes (a tempo as BPM, say).
          updatePatternCell(state.selInstrument, voiceOf(pat.col) * FIELDS + F_VAL, pat.row);
          notify();
          e.preventDefault();
          return;
        }
      }
      if (field === F_VAL) {
        const ch = VAL_KEYS[e.code];
        if (ch !== undefined) {
          // A minus on a value that already has one takes it off again, which
          // is the only sign toggle a single key can offer.
          if (ch === '-') valBuf = valBuf.startsWith('-') ? valBuf.slice(1) : '-' + valBuf;
          else valBuf += ch;
          pushUndo();
          commitVal(pat.col);
          updatePatternCell(state.selInstrument, pat.col, pat.row);
          notify();
          e.preventDefault();
          return;
        }
      }
    }

    // The chord pads own the digit row while a flavor is set, checked before
    // the note lookup below because the digit row doubles as sharps in the
    // chromatic layout. A digit past the end of the pad set falls through and
    // stays a sharp (see PAD_KEYS). Only on the Note field -- elsewhere the
    // digits were already claimed above.
    if (field === F_NOTE && state.flavor > 0 && PAD_KEYS[e.code] !== undefined
        && enterPadAtCursor(PAD_KEYS[e.code])) {
      e.preventDefault();
      return;
    }
    // Piano-key emulation: live-plays through panels/keyboard.js
    // (state.previewNote, a callback field like state.notify/state.requestStop,
    // so this module needn't import keyboard.js), but only *writes* into the
    // pattern grid when a pattern is actually focused. previewNote does the raw-
    // key-offset -> note-number math (octave + NOTE_OFFSET) and hands the result
    // back, so both sides agree on the exact value.
    const n = noteKeys()[e.code];
    if (n !== undefined) {
      const note = state.previewNote ? state.previewNote(n) : n + state.octave * 12 + engine.NOTE_OFFSET;
      // Only the Note field takes a written note. On the other four the key
      // still sounds and goes no further: the whole point of a piano key is
      // that pressing it plays something, and going silent because the cursor
      // happens to be on a velocity cell would read as the keyboard being
      // broken. previewNote already played it above.
      if (field === F_NOTE) enterNoteAtCursor(note);
      e.preventDefault();
      return;
    }
  }

  // Capture cursor position before handleNav moves it, for fast-path rendering below
  const oldNavCol = pat.col, oldNavRow = pat.row;
  const oldNavSingleCell = pat.col1 === pat.col2 && pat.row1 === pat.row2;

  if (handleNav(e, state.editMode)) {
    if (state.editMode === 'sequence') syncSeqIntoState();

    // Fast path: simple operations in pattern mode that don't need a full grid
    // rebuild. Arrow keys/Home/End with no shift → just move the cursor
    // highlight. Delete/Backspace on a single cell → update one cell + move.
    const isArrowOrHomeEnd = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.code);
    const isDelete = e.code === 'Delete' || e.code === 'Backspace';
    const fastPathOK = state.editMode === 'pattern' && !e.shiftKey && oldNavSingleCell
      && (isArrowOrHomeEnd || isDelete);

    if (fastPathOK) {
      const channel = state.selInstrument;
      if (isDelete) updatePatternCell(channel, oldNavCol, oldNavRow);
      moveCursor(oldNavCol, oldNavRow, pat.col, pat.row);
      notify();
    } else {
      render(); notify();
    }
    e.preventDefault();
  }
}

// 0-9 and A-F off the physical key, for the two hex fields.
function hexDigit(code) {
  if (/^Digit[0-9]$/.test(code)) return +code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return +code.slice(6);
  if (/^Key[A-F]$/.test(code)) return 10 + (code.charCodeAt(3) - 65);
  return -1;
}

function clearRow(row) {
  const p = focusedPattern();
  if (!p) return;
  const patternLen = state.song.patternLen;
  for (let c = 0; c < 4; c++) {
    p.n[row + c * patternLen] = 0;
    p.e[(row + c * patternLen) * 2] = 0;
    p.e[(row + c * patternLen) * 2 + 1] = 0;
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
  // A channel with no pattern assigned still takes the cursor. Every write goes
  // through patGrid, which is a no-op without a pattern number, so the cell
  // stays empty -- but the click is the only way back out of the sequencer with
  // the mouse, and refusing it here left the keyboard stuck in the sequencer on
  // a song whose channels are still empty.
  //
  // Shift+click extends the selection from its anchor to the clicked cell --
  // the mouse equivalent of shift+arrow. Restricted to the focused channel: one
  // pattern cursor is shared by all of them, so an anchor in one channel and a
  // corner in another describes no real rectangle. Shift+click on an unfocused
  // channel therefore just focuses it, like a plain click.
  const oldChannel = state.selInstrument, oldMode = state.editMode;
  const oldCol = pat.col, oldRow = pat.row;
  const extend = e.shiftKey && t.channel === state.selInstrument;
  if (!extend) state.selInstrument = t.channel;
  state.editMode = 'pattern';
  if (extend) extendSelection(pat, t.col, t.row);
  else setCursor(pat, t.col, t.row);
  dragMode = 'pattern';
  // Fast path: a single-cell click on the channel that already had focus. Any
  // other click changes which channel draws its full set of fields, so the grid
  // has to be rebuilt.
  if (!extend && oldChannel === t.channel && oldMode === 'pattern') {
    moveCursor(oldCol, oldRow, t.col, t.row);
    notify();
  } else {
    render(); notify();
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
  else return;
  render();
}
function onMouseUp() { dragMode = null; }

// --- rendering: full innerHTML rebuild on every change. Simpler and safer than
// surgical per-cell diffing at this grid size. The BPM/rows inputs live outside
// the rebuilt containers, so typing in them doesn't lose focus. ---
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
    const enabled = state.channelsEnabled[col];
    const classes = ['channel-toggleable'];
    if (col === state.selInstrument) classes.push('focused');
    if (!enabled) classes.push('channel-disabled');
    const title = `Channel ${col + 1}. Click to ${enabled ? 'mute' : 'unmute'} it: a muted channel is left out of`
      + ` Space / Play selected, and cannot be edited in the piano roll. Play still plays the whole song.`
      + ` Click a cell below to edit this channel's patterns and instrument.`;
    thead += `<th class="${classes.join(' ')}" data-channel="${col}" title="${title}">${col + 1}</th>`;
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

  $('seq-thead').querySelectorAll('th.channel-toggleable').forEach(th => {
    th.onclick = () => {
      const ch = +th.dataset.channel;
      state.channelsEnabled[ch] = !state.channelsEnabled[ch];
      // Clear selection of any notes from this channel
      if (!state.channelsEnabled[ch]) {
        state.pianoRoll.selectedNotes = state.pianoRoll.selectedNotes.filter(n => n.channel !== ch);
      }
      state.notify && state.notify();
    };
  });
}

// How many cells a channel's row draws: all five fields of every voice on the
// focused channel, the Note field alone everywhere else. Every DOM index in
// this module goes through here, so the two layouts can never disagree.
const colsShown = channel => (channel === state.selInstrument ? 4 * FIELDS : 4);
// The grid column a cell at DOM index `k` represents, for the narrow layout.
const gridColOf = (channel, k) => (channel === state.selInstrument ? k : k * FIELDS);
// The DOM index of grid column `col`, or -1 when that field isn't drawn.
const domIndexOf = (channel, col) =>
  channel === state.selInstrument ? col : (fieldOf(col) === F_NOTE ? voiceOf(col) : -1);

function patCellHTML(channel, p, col, row) {
  const focused = channel === state.selInstrument;
  const cls = [FIELD_CLASS[fieldOf(col)]];
  if (focused && state.editMode === 'pattern') {
    if (col === pat.col && row === pat.row) cls.push('cursor');
    else if (isSelected(pat, col, row)) cls.push('selected');
  }
  const v = p ? fieldGet(p, row, col) : 0;
  const text = p ? fieldHTML(v, col, p, row) : '';
  // On an unfocused channel the other four fields are not drawn at all, so a
  // note carrying a velocity, an instrument or an effect would look identical
  // to a plain one. A marker says there is more here than is shown.
  if (!focused && p && text) {
    const s = row + voiceOf(col) * state.song.patternLen;
    if ((p.n[s] >> 8) || p.e[s * 2]) cls.push('has-fields');
  }
  // A three-letter mnemonic says little on its own, so the command cell names
  // itself in full on hover -- including which channel-strip parameter a PARAM
  // command writes, which the P0..PC labels cannot show.
  const title = fieldOf(col) === F_CMD && v ? ` title="${engine.cmdName(v)}"` : '';
  return `<td class="${cls.join(' ')}" data-channel="${channel}" data-col="${col}" data-row="${row}"${title}>${text}</td>`;
}

function renderPatterns() {
  const patternLen = state.song.patternLen;
  let html = '';
  for (let channel = 0; channel < engine.MAX_CHANNELS; channel++) {
    const pn = patternNumFor(channel);
    const p = pn ? channelAt(channel).pat[pn - 1] : null;
    const focused = channel === state.selInstrument;
    const classes = ['pat-col'];
    if (focused) classes.push('focused');
    if (!pn) classes.push('no-pattern');
    if (focused) classes.push('expanded');
    html += `<div class="${classes.join(' ')}" title="${pn
        ? 'Four voice columns. The focused channel also shows each voice\'s instrument, velocity and effect. Play notes in with the piano or the computer keys; ` writes a note-off. Alt+arrows transpose; right-click for the rest.'
        : 'No pattern assigned — insert a pattern number in the sequencer above to edit notes here'
      }">`
      + `<div class="pat-col-head" data-channel="${channel}"${pn ? ` title="Channel ${channel + 1} plays pattern ${pn} at this sequence row. Click to edit it."` : ''}>Ch ${channel + 1} · ${pn ? 'Pat ' + formatPatternNum(pn) : String.fromCharCode(8212)}</div>`
      + '<table class="trk-table"><tbody>';
    const cols = colsShown(channel);
    for (let row = 0; row < patternLen; row++) {
      html += `<tr class="${isBeatRow(row) ? 'beat' : ''}${row === pat.row ? ' curRow' : ''}">`;
      for (let k = 0; k < cols; k++) html += patCellHTML(channel, p, gridColOf(channel, k), row);
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
  if (document.activeElement !== bpmEl) bpmEl.value = engine.bpmOf(state.song.rowLen);
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

// Fast path for single-cell updates during note entry: mutates the DOM cell's
// text without rebuilding the whole grid. Caller is responsible for moving the
// cursor and knowing this path is safe -- it skips refreshSongControls and
// renderSequencer entirely, so it cannot be used when those need updating.
function updatePatternCell(channel, col, row) {
  if (patRowEls.length === 0) { render(); return; } // grid not rendered yet
  const rows = patRowEls[channel];
  if (!rows || !rows[row]) { render(); return; }    // pattern changed
  const k = domIndexOf(channel, col);
  if (k < 0) return;                                // field isn't drawn here
  const cell = rows[row].children[k];
  if (!cell) { render(); return; }
  const p = patternOf(channel);
  cell.textContent = p ? fieldHTML(fieldGet(p, row, col), col, p, row) : '';
}

// Moves the cursor cell highlight from (oldCol, oldRow) to (newCol, newRow) on
// the focused channel without rebuilding the grid.
function moveCursor(oldCol, oldRow, newCol, newRow) {
  const channel = state.selInstrument;
  if (patRowEls.length === 0) { render(); return; }
  const rows = patRowEls[channel];
  if (!rows || !rows[oldRow] || !rows[newRow]) { render(); return; }
  const oldK = domIndexOf(channel, oldCol), newK = domIndexOf(channel, newCol);
  rows[oldRow].classList.remove('curRow');
  if (oldK >= 0 && rows[oldRow].children[oldK]) {
    rows[oldRow].children[oldK].classList.remove('cursor', 'selected');
  }
  rows[newRow].classList.add('curRow');
  if (newK >= 0 && rows[newRow].children[newK]) {
    rows[newRow].children[newK].classList.add('cursor');
    rows[newRow].children[newK].scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

function render() {
  refreshSongControls();
  renderSequencer();
  if (state.viewMode === 'pianoroll') {
    // Only init if piano roll doesn't exist yet
    if (!$('pianoroll-canvas')) {
      initPianoRoll();
    } else {
      // Just repaint, don't rebuild/scroll
      renderPianoRoll();
    }
  } else {
    // Ensure tracker patterns panel structure exists
    if (!$('pat-scroll')) {
      initTrackerPatternsPanel();
    }
    renderPatterns();
    scrollCursorIntoView();
  }
}

function initTrackerPatternsPanel() {
  $('patterns-panel').innerHTML =
    `<div class="row pat-header">
       <h3 title="The notes in the patterns playing at the sequencer's current row — every channel side by side. The highlighted column is the one you are editing, and the only one showing its instrument, velocity and effect fields.">Patterns</h3>
       <div class="spacer"></div>
       <span class="hint" id="pattern-hint"></span>
     </div>
     <div class="pat-scroll" id="pat-scroll"></div>`;
}

// Same trick as panels/pianoroll.js's flashFeedback: a channel with no pattern
// assigned still takes the cursor (see patternsMouseDown), so a note key typed
// there was previously a silent no-op with no way to tell why nothing happened.
function flashFeedback(message) {
  const hint = $('pattern-hint');
  if (!hint) return;
  const original = hint.textContent;
  hint.textContent = message;
  hint.style.color = '#ff4444';
  setTimeout(() => {
    hint.textContent = original;
    hint.style.color = '';
  }, 1000);
}

// --- playback row-following: main.js calls this every frame with the elapsed
// time of the playing buffer. It moves the real editing cursors rather than
// drawing a separate marker, so the pattern view switches to whatever pattern the
// playing row is on and the existing cursor/curRow highlighting doubles as the
// follow indicator with no new CSS. ---
let followSeq = -1, followPat = -1;
// Populated by renderPatterns(), see its comment.
let patRowEls = [];

// Moves the curRow highlight (and, in pattern edit mode, the live cursor cell)
// from `oldRow` to `newRow` in every channel's pattern column, without
// rebuilding any of the grid's markup. This is the fast path a mid-song row
// tick takes; a full render() only happens when the *set* of patterns shown
// actually changes (crossing a sequence step), not on every row.
function moveFollowRow(oldRow, newRow) {
  const cursorK = state.editMode === 'pattern' ? domIndexOf(state.selInstrument, pat.col) : -1;
  for (let ch = 0; ch < patRowEls.length; ch++) {
    const rows = patRowEls[ch], focused = ch === state.selInstrument;
    if (oldRow >= 0 && rows[oldRow]) {
      rows[oldRow].classList.remove('curRow');
      if (focused && cursorK >= 0 && rows[oldRow].children[cursorK]) {
        rows[oldRow].children[cursorK].classList.remove('cursor');
      }
    }
    if (newRow >= 0 && rows[newRow]) {
      rows[newRow].classList.add('curRow');
      if (focused && cursorK >= 0 && rows[newRow].children[cursorK]) {
        rows[newRow].children[cursorK].classList.add('cursor');
      }
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
// The worker's buffer only contains samples from `firstRow`/`firstCol` on, so
// row 0 of *that* buffer is sequence row followRow0, not row 0.
let followRow0 = 0, followCol0 = 0, followCol1 = engine.MAX_CHANNELS - 1, followCols = null;
// Sample offsets for the rows being played. Elapsed time cannot be divided by
// song.rowLen any more: a TEMPO command makes rows different lengths, and
// dividing by the opening tempo drifts further out of step with every change.
// Built once per render, from the same walk the player does.
let followTable = null;
export function setFollowRange(range) {
  followSeq = followPat = -1;
  followRow0 = range ? range.firstRow : 0;
  followCol0 = range ? range.firstCol : 0;
  followCol1 = range ? range.lastCol : engine.MAX_CHANNELS - 1;
  // A muted channel inside the span was skipped by the render, so it must not
  // light up keys either (see getPlayRange's `cols`).
  followCols = (range && range.cols) || null;
  followTable = engine.rowTable(state.song, followRow0,
    range ? range.lastRow : state.song.endPattern);
}

// Which notes, if any, channel `chan` is sounding at time t -- what decides
// which keys panels/keyboard.js still shows lit.
//
// v2 makes this a real question rather than an envelope estimate. Each of the
// four voice columns is scanned back for its most recent event: a note-off
// silences the column outright, and a note-on sounds until its gate, or until
// its envelope decays away when the instrument has no sustain level, or
// indefinitely when it has one and nothing releases it.
function channelActiveNotes(t, chan) {
  const song = state.song, patternLen = song.patternLen;
  const sample = t * 44100;
  const n = engine.rowAtSample(followTable, sample);
  const seqPos0 = followRow0 + Math.floor(n / patternLen), patPos0 = n % patternLen;
  const out = [];

  for (let col = 0; col < 4; col++) {
    // Walk backwards a whole pattern's worth of rows looking for this column's
    // last event. Anything older than that has had a pattern to die out in.
    for (let k = 0; k < patternLen; k++) {
      let seqPos = seqPos0, patPos = patPos0 - k;
      while (patPos < 0) {
        seqPos--;
        if (seqPos < followRow0) { patPos = -1; break; }
        patPos += patternLen;
      }
      if (patPos < 0) break;
      const pn = channelAt(chan).seq[seqPos] || 0;
      if (!pn) continue;
      const p = channelAt(chan).pat[pn - 1];
      const s = patPos + col * patternLen;
      const ev = p.n[s];
      if (!ev) continue;
      if (ev === engine.NOTE_OFF) break;      // this column is silent
      // Distance back through the table rather than k * rowLen: the rows
      // between may not all be the same length.
      const samplesSince = sample - followTable.rowStart[Math.max(0, n - k)];
      if (soundingAt(chan, p, s, samplesSince)) out.push(engine.pitchOf(ev));
      break;
    }
  }
  return out;
}

// Is the note stored at slot `s` still audible `samplesSince` samples after it
// started? Reads the instrument the note actually names, falling back to the
// channel's default, since a per-note instrument change is exactly the sort of
// thing this has to follow.
function soundingAt(chan, p, s, samplesSince) {
  const song = state.song;
  const ins = engine.insOf(p.n[s]);
  const i = song.instruments[ins < 0 ? channelAt(chan).ins : ins];
  if (!i) return false;
  const attack = i[engine.ENV_ATTACK] ** 2 * 4;
  const decay = i[engine.ENV_DECAY] ** 2 * 4;
  const release = i[engine.ENV_RELEASE] ** 2 * 4;
  // A gate on the same slot ends the note after that many rows, then it
  // releases. Without one, a sustaining instrument holds until a note-off,
  // which the caller has already looked for.
  if (p.e[s * 2] === engine.GATE) {
    return samplesSince < p.e[s * 2 + 1] * song.rowLen + release;
  }
  // (A gate is counted in rows, so it too is only approximate through a tempo
  // change -- but it is a key highlight, not the audio.)
  if (!i[engine.ENV_SUSTAIN_LEVEL]) return samplesSince < attack + decay;
  return true;
}

export function followPlayback(t) {
  const patternLen = state.song.patternLen;
  if (!followTable) setFollowRange(null);
  const n = engine.rowAtSample(followTable, t * 44100);
  const patPos = n % patternLen;
  const seqPos = followRow0 + Math.floor(n / patternLen);
  if (seqPos !== followSeq) {
    // Crossing a sequence step: which pattern each channel shows can
    // actually change, so this does need the full rebuild.
    followSeq = seqPos; followPat = patPos;
    state.selRow = seqPos;
    setCursor(seq, seq.col, seqPos, true);
    setCursor(pat, pat.col, patPos, true);
    render(); notify();
  } else if (patPos !== followPat) {
    // Same pattern set, just a later row within it -- the common case, hit on
    // every playback row, up to dozens of times a second at high BPM. A full
    // render() here would rebuild all MAX_CHANNELS pattern columns' innerHTML
    // every tick, and that DOM rebuild plus layout contends with the scope's
    // canvas draw on the same thread. Moving the two affected classes is enough.
    const oldPat = followPat;
    followPat = patPos;
    setCursor(pat, pat.col, patPos, true);
    moveFollowRow(oldPat, patPos);
  }
  if (state.highlightNotes) {
    const notes = [];
    // Restricted to the range that's actually sounding (all channels for a
    // normal full-song play) -- a channel outside a "play selected" range wasn't
    // rendered by the worker at all, so it has nothing to highlight.
    for (let ch = followCol0; ch <= followCol1 && ch < state.song.numChannels; ch++) {
      if (followCols && followCols.indexOf(ch) < 0) continue;
      for (const note of channelActiveNotes(t, ch)) notes.push(note);
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
      <label title="Tempo, in beats per minute. Four rows make a beat, so this sets how fast the pattern rows run. A TMP command in a pattern changes it part-way through, for every channel at once.">BPM <input id="song-bpm" type="number" min="10" max="1000"></label>
      <label title="How many rows every pattern in the song has. Shortening this throws away the notes past the new end.">Rows <input id="song-rpp" type="number" min="1" max="256"></label>
      <label title="Highlight every Nth row in both grids, so you can see where the beat is. 4 for 4/4, 3 for a waltz, 8 for 32nd-note patterns. A view setting — it changes nothing about the song.">Beat <input id="song-beat" type="number" min="1" max="32"></label>
    </div>
    <div class="trk-scroll" title="Click a cell, then type a pattern number (0-9, A-Z) to place a pattern; 0 or Backspace clears it. Arrow keys move, shift+arrows or click+drag select, Ctrl+C/Ctrl+V copy and paste a block. Clicking a column also picks that channel for the instrument panel.">
      <table class="trk-table"><thead id="seq-thead"></thead><tbody id="seq-tbody"></tbody></table></div>`;

  $('patterns-panel').classList.remove('wip');
  initTrackerPatternsPanel();

  $('song-bpm').oninput = () => {
    const bpm = +$('song-bpm').value;
    if (bpm >= 10 && bpm <= 1000) {
      state.song.rowLen = engine.calcSamplesPerRow(bpm);
      renderPianoRoll();
    }
  };
  $('song-rpp').onchange = () => {
    const len = +$('song-rpp').value;
    if (len >= 1 && len <= 256 && len !== state.song.patternLen) {
      state.requestStop && state.requestStop();
      engine.setPatternLength(state.song, len);
      // Reset (not just clamp) the cursor -- a stale selection corner beyond
      // the new, possibly-shorter patternLen would silently read past the
      // resized n[]/e[] arrays on the next copy/delete.
      setCursor(pat, 0, 0);
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
  // Delegated from #patterns-panel, not #pat-scroll: switching to piano-roll
  // view and back replaces #patterns-panel's whole innerHTML, which discards
  // #pat-scroll and builds a new one. A listener bound to that specific element
  // stopped firing the moment it was replaced. #patterns-panel itself is never
  // replaced, only its contents, so this survives any number of trips through
  // piano-roll view.
  $('patterns-panel').addEventListener('mousedown', patternsMouseDown);
  $('patterns-panel').addEventListener('contextmenu', patternsContextMenu);
  document.addEventListener('mouseover', onMouseOver);
  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('keydown', onKeyDown);

  render();
}

export function refreshTrackerPanel() {
  render();
}
