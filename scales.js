// Scale + chord tables for note input (plans/soundbox-scale-chord-input.md).
// Pure data and math -- no DOM, no imports, no state: panels/tracker.js and
// panels/keyboard.js both read from here, and keeping it dependency-free is
// what lets both do so without closing an import cycle (tracker -> keyboard
// is already forbidden; see state.js's previewNote comment).
//
// Everything here speaks in *semitone offsets relative to state.octave's
// base note*, the same contract panels/tracker.js's chromatic NOTE_KEYS has
// always had -- so keyboard.js's previewNote math (offset + octave*12 +
// engine.NOTE_OFFSET), its physical-key highlighting and its .kb-label
// derivation all keep working unchanged whichever mapping is active. The
// root transpose folds into the offsets rather than being a second thing
// every caller has to remember to add.

// The two 7-note scales the sub-7-note ones borrow their harmony from; see
// the third SCALES slot below. Natural minor is also a scale in its own
// right, so the entry there reuses this array rather than repeating it.
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];

// [name, input intervals, harmony intervals]. The third slot is the 7-note
// parent scale chords are built from when the input scale has fewer than 7
// notes, and is omitted when the scale harmonizes itself.
//
// Why the split: diatonicChord stacks every *other* degree, which is real
// tertian harmony only on a 7-note scale. On a 5-note pentatonic the same
// rule gives C-F-Bb-Eb -- stacked 4ths, not a chord. Every one of these
// pentatonics is a 7-note scale with notes removed (minor pentatonic is
// natural minor minus the 2nd and 6th; major pentatonic is major minus the
// 4th and 7th; blues is minor pentatonic plus a passing b5), so harmonizing
// in the parent puts back exactly the notes the input rows can't reach and
// yields the chords you'd write by hand: Cm7, Ebmaj7, Fm7, Gm7, Bb7.
// Chord tones are therefore not always playable from the key rows -- that's
// the point of auto-harmonize, not a leak.
//
// Ordered pentatonics -> blues -> 7-note modes, roughly fewest notes first.
// The index is what state.scaleMode persists, so inserting one in the middle
// re-points an already-saved preference at its neighbour -- harmless for a
// dev tool (pick again), but worth knowing before reordering this list.
export const SCALES = [
  ['Chromatic', null],                            // off: tracker.js's NOTE_KEYS
  ['Minor pentatonic', [0, 3, 5, 7, 10], MINOR],  // no half-steps; everything loops
  ['Major pentatonic', [0, 2, 4, 7, 9], MAJOR],   // bright/upbeat
  ['Blues', [0, 3, 5, 6, 7, 10], MINOR],          // minor pentatonic + the flat 5th
  ['Natural minor', MINOR],                       // the plain minor scale
  ['Dorian', [0, 2, 3, 5, 7, 9, 10]],             // minor with a raised 6th -- jazzy
  ['Mixolydian', [0, 2, 4, 5, 7, 9, 10]],         // major with a flat 7th -- bluesy
  ['Harmonic minor', [0, 2, 3, 5, 7, 8, 11]],     // raised 7th -- dark/dramatic
];

// The intervals chords are built from for a given SCALES index: the parent
// scale where there is one, the scale itself otherwise. Null for Chromatic,
// where there's no scale and the digit row names the quality instead.
export function harmonyOf(mode) {
  const [, intervals, parent] = SCALES[mode];
  return parent || intervals;
}

export const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Two straight rows of in-scale notes, replacing the chromatic layout's
// white-keys-below/black-keys-above shape. Degree numbering is *continuous*
// across the two rows -- the top row picks up where the bottom leaves off,
// so there's no overlap and no gap (a 5-note scale spans 4 octaves across
// the 20 keys, a 7-note scale ~2.9). The chromatic layout's sharp keys
// (S D G H J / 2 3 5 6 7) go unmapped in scale mode: having no way to hit an
// out-of-scale note is the entire point, and the digit row picks up chord
// duty instead (see CHORD_QUALITIES).
const ROW_BOTTOM = ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'Period', 'Slash'];
const ROW_TOP = ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP'];

// Semitone offset of scale degree `d`, which may run past one octave (that's
// how the 20 keys cover 3-4 octaves, and how diatonicChord's +6 degree
// stacks past the octave on a 5-note scale).
export function degreeOffset(intervals, root, d) {
  const len = intervals.length;
  const oct = Math.floor(d / len);
  return oct * 12 + intervals[d - oct * len] + root;
}

export function scaleKeys(intervals, root) {
  const map = {};
  [...ROW_BOTTOM, ...ROW_TOP].forEach((code, d) => { map[code] = degreeOffset(intervals, root, d); });
  return map;
}

// Which degree of the scale a pitch class is (0-11, 0 = C -- the engine's
// note space starts on a C, see engine.NOTE_OFFSET), or -1 if it's out of
// the scale. Drives both the in-scale key tint on the on-screen piano and
// diatonicChord below, so a chord can be built from an on-screen click just
// as well as from a physical key press.
export function degreeOfPitch(intervals, root, pitchClass) {
  const pc = ((pitchClass % 12) + 12) % 12;
  return intervals.findIndex(iv => (iv + root) % 12 === pc);
}

// The diatonic chord on `pitchClass`: semitone deltas from the played note,
// stacking every other degree (d, d+2, d+4, d+6) of `intervals`, which is
// harmonyOf(mode) rather than the input scale. The quality falls out of the
// scale for free -- in Dorian, degree 0 gives a minor 7th and degree 3 a
// dominant 7th, with nobody having to name either.
// Returns null for a note that isn't in the harmony scale -- callers treat
// that as "no chord, just the note". Two ways to land there, both wanting
// that answer: the blues b5, a passing tone with no chord of its own, and
// an on-screen click on a key outside the key entirely.
export function diatonicChord(intervals, root, pitchClass) {
  const d = degreeOfPitch(intervals, root, pitchClass);
  if (d < 0) return null;
  const base = degreeOffset(intervals, root, d);
  return [0, 2, 4, 6].map(k => degreeOffset(intervals, root, d + k) - base);
}

// Chord qualities by digit, for the two-keypress flow: a note key names the
// root, a digit pressed straight after names the quality (Q then 1 = Cmaj7,
// W then 6 = D6). Grouped so it's learnable: 7ths, triads, sixths, altered,
// sus. Ordered root/3rd/5th/7th to match the four voicing toggles and the
// four note columns a pattern row has.
export const CHORD_QUALITIES = {
  Digit1: ['maj7', [0, 4, 7, 11]],
  Digit2: ['m7', [0, 3, 7, 10]],
  Digit3: ['7', [0, 4, 7, 10]],
  Digit4: ['m', [0, 3, 7]],
  Digit5: ['M', [0, 4, 7]],
  Digit6: ['6', [0, 4, 7, 9]],
  Digit7: ['m6', [0, 3, 7, 9]],
  Digit8: ['m7♭5', [0, 3, 6, 10]],
  Digit9: ['dim7', [0, 3, 6, 9]],
  Digit0: ['sus4', [0, 5, 7, 10]],
};

// Qualities the readout can name but no digit produces: the two chords
// harmonic minor throws off that nothing else does. Kept out of
// CHORD_QUALITIES because that table is bound to the digit row, and there
// are only ten digits -- these two aren't worth a slot each.
const EXTRA_NAMES = [
  ['mMaj7', [0, 3, 7, 11]],  // harmonic minor's tonic
  ['maj7♯5', [0, 4, 8, 11]], // its III+
];

// Readout for the chord just entered -- the only feedback that confirms a
// two-keypress entry did what was meant, and the only way to know what a
// diatonic stack actually spelled. Matches the deltas against the quality
// tables (normalized into one octave, since a diatonic stack can run past
// it); anything neither table names falls back to listing its intervals.
export function nameChord(rootPitch, deltas) {
  const name = PITCH_NAMES[((rootPitch % 12) + 12) % 12];
  if (deltas.length < 2) return name;
  const norm = set => [...new Set(set.map(d => ((d % 12) + 12) % 12))].sort((a, b) => a - b).join(',');
  const mine = norm(deltas);
  for (const code in CHORD_QUALITIES) {
    const [label, iv] = CHORD_QUALITIES[code];
    if (norm(iv) === mine) return name + label;
  }
  for (const [label, iv] of EXTRA_NAMES) if (norm(iv) === mine) return name + label;
  return name + ' ' + deltas.slice(1).join('-');
}
