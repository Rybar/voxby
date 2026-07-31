// Scale + chord tables for note input.
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
// 'Major' breaks the ordering for exactly that reason: it was added after the
// rest (the chord flavors need a plain Ionian, which only Major *pentatonic*
// covered before), and appending is what keeps every saved scaleMode pointing
// at the scale it was saved for.
export const SCALES = [
  ['Chromatic', null],                            // off: tracker.js's NOTE_KEYS
  ['Minor pentatonic', [0, 3, 5, 7, 10], MINOR],  // no half-steps; everything loops
  ['Major pentatonic', [0, 2, 4, 7, 9], MAJOR],   // bright/upbeat
  ['Blues', [0, 3, 5, 6, 7, 10], MINOR],          // minor pentatonic + the flat 5th
  ['Natural minor', MINOR],                       // the plain minor scale
  ['Dorian', [0, 2, 3, 5, 7, 9, 10]],             // minor with a raised 6th -- jazzy
  ['Mixolydian', [0, 2, 4, 5, 7, 9, 10]],         // major with a flat 7th -- bluesy
  ['Harmonic minor', [0, 2, 3, 5, 7, 8, 11]],     // raised 7th -- dark/dramatic
  ['Major', MAJOR],                               // plain Ionian
];

// The intervals chords are built from for a given SCALES index: the parent
// scale where there is one, the scale itself otherwise. Null for Chromatic,
// where there's no scale and the digit row names the quality instead.
export function harmonyOf(mode) {
  const [, intervals, parent] = SCALES[mode];
  return parent || intervals;
}

export const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// The same twelve spelled downwards. Which of the two a note wants depends on
// the harmony around it, which nothing here tracks in general -- but a chord
// that knows it is a *flat* degree of its key does know: the ♭VII of C is B♭,
// never A#. chords.js's pads say so in their roman numerals, and that is the
// one place this is used. (The key's own root is still spelled sharp: naming
// E♭ minor's tonic correctly needs a key signature, which is a bigger idea
// than this table.)
export const FLAT_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
export const pitchName = (pitchClass, flat) =>
  (flat ? FLAT_NAMES : PITCH_NAMES)[((pitchClass % 12) + 12) % 12];

// Two straight rows of in-scale notes, replacing the chromatic layout's
// white-keys-below/black-keys-above shape. Degree numbering is *continuous*
// across the two rows -- the top row picks up where the bottom leaves off,
// so there's no overlap and no gap (a 5-note scale spans 4 octaves across
// the 20 keys, a 7-note scale ~2.9). The chromatic layout's sharp keys
// (S D G H J / 2 3 5 6 7) go unmapped in scale mode: having no way to hit an
// out-of-scale note is the entire point, and the digit row picks up chord
// duty instead (see chords.js).
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

// The chord vocabulary: quality name -> [display label, semitone intervals].
// Keyed by name so a caller can ask for `'maj7'` by writing 'maj7' -- the
// chord flavors in chords.js are lists of (degree, quality name) pairs, and
// nameChord below searches this one table.
//
// It used to be keyed by KeyboardEvent.code ('Digit1'...'Digit0'), from when
// the digit row was its only binding: a note key named the root and a digit
// pressed straight after named the quality. That flow is gone (the digit row
// now writes chord pads outright), and with it the distortion the digit keying
// forced -- there are only ten digits, so the qualities past the tenth were
// split off into a second-class group and the two the readout needed but no
// digit could reach lived in a separate table again. All one table now.
//
// Labels carry ♭/♯ where the name does; the key stays ASCII so flavor data
// can be typed without them.
export const QUALITIES = {
  // Triads (sus4 carries a 7th: it is the one everybody actually plays, and
  // the bare [0,5,7] is a fifth with a fourth in it rather than a chord)
  M: ['', [0, 4, 7]],   // a plain major triad is spelled by its letter alone
  m: ['m', [0, 3, 7]],
  dim: ['dim', [0, 3, 6]],
  aug: ['aug', [0, 4, 8]],
  sus2: ['sus2', [0, 2, 7]],
  sus4: ['sus4', [0, 5, 7, 10]],

  // Sevenths and sixths
  maj7: ['maj7', [0, 4, 7, 11]],
  m7: ['m7', [0, 3, 7, 10]],
  '7': ['7', [0, 4, 7, 10]],
  '6': ['6', [0, 4, 7, 9]],
  m6: ['m6', [0, 3, 7, 9]],
  m7b5: ['m7♭5', [0, 3, 6, 10]],
  dim7: ['dim7', [0, 3, 6, 9]],
  mMaj7: ['mMaj7', [0, 3, 7, 11]],   // harmonic minor's tonic
  maj7s5: ['maj7♯5', [0, 4, 8, 11]], // its III+

  // Ninths
  '9': ['9', [0, 4, 7, 10, 14]],
  maj9: ['maj9', [0, 4, 7, 11, 14]],
  m9: ['m9', [0, 3, 7, 10, 14]],

  // Elevenths
  '11': ['11', [0, 4, 7, 10, 14, 17]],
  maj11: ['maj11', [0, 4, 7, 11, 14, 17]],
  m11: ['m11', [0, 3, 7, 10, 14, 17]],

  // Thirteenths
  '13': ['13', [0, 4, 7, 10, 14, 17, 21]],
  maj13: ['maj13', [0, 4, 7, 11, 14, 17, 21]],
  m13: ['m13', [0, 3, 7, 10, 14, 17, 21]],

  // Adds
  add9: ['add9', [0, 4, 7, 14]],
  madd9: ['madd9', [0, 3, 7, 14]],
  add11: ['add11', [0, 4, 7, 17]],

  // Altered dominants
  '7s5': ['7♯5', [0, 4, 8, 10]],
  '7b9': ['7♭9', [0, 4, 7, 10, 13]],
  '7s9': ['7♯9', [0, 4, 7, 10, 15]],
  '7s11': ['7♯11', [0, 4, 7, 10, 18]],
};

// --- quartal voicing: the chord stacked in fourths instead of thirds. The
// McCoy Tyner / "So What" sound -- open, modal, and much wider than a close
// voicing (four fourths span an octave and a half, where a close 7th chord
// spans less than one).
//
// A quartal stack can't be built from the chord's own tones: the fourths above
// a Dm7's D are G and C, and G is not in the chord. It comes from the *mode the
// chord implies*, which the chord's own third and seventh are enough to name --
// a minor seventh implies Dorian, a dominant implies Mixolydian, a major
// seventh implies Ionian. That is why this needs no scale passed in and works
// for the borrowed chords a flavor is full of, where the key's own scale would
// have nothing to say.
//
// A fourth is three steps of a 7-note mode, so the stack is degrees d, d+3,
// d+6, d+9 -- scale fourths, which come out as a mix of perfect and augmented
// exactly where the mode says they should.
const DORIAN_M = [0, 2, 3, 5, 7, 9, 10];
const MIXO_M = [0, 2, 4, 5, 7, 9, 10];
const LOCRIAN_M = [0, 1, 3, 5, 6, 8, 10];

// Semitone offsets from the chord's root, `count` notes stacked in fourths.
//
// Major-quality chords anchor the stack on their third rather than their root:
// the fourth above a major chord's root is its avoid note (F over C), while
// starting a step up gives E-A-D-G, the rootless voicing every pianist reaches
// for on a major chord. Everything else anchors on the root, where the fourth
// above is a chord tone or a colour the mode wants anyway.
//
// Not every chord survives being restacked. A stack of fourths is built from a
// mode, and a mode has a plain fifth -- so a diminished or augmented chord
// comes back with its defining note quietly replaced, and the pad would be
// lying about which chord it just played. Those fall back to wideVoicing
// below, which is wider still and made of the chord's own notes.
export function quartalVoicing(chordIntervals, count = 4) {
  const has = iv => chordIntervals.some(i => i % 12 === iv);
  const minorThird = has(3), majorThird = has(4);
  const mode = minorThird && has(6) ? LOCRIAN_M
    : minorThird ? DORIAN_M
    : majorThird && has(10) ? MIXO_M
    : majorThird ? MAJOR
    : DORIAN_M;   // sus and other third-less chords: fourths all the way up,
                  // which is the one stack that adds no third of its own
  // Degree 2 of a major scale is its third; every other mode above anchors at 0.
  const anchor = mode === MAJOR ? 2 : 0;
  const stack = Array.from({ length: count }, (_, k) => degreeOffset(mode, 0, anchor + k * 3));

  // Does the stack still say what the chord says? The third is what makes a
  // chord major or minor, and an altered fifth is the entire content of a
  // diminished or augmented one. A seventh is negotiable -- dropping it is how
  // the classic rootless major voicing works -- so it isn't checked.
  const inStack = iv => stack.some(n => n % 12 === iv);
  // A sus chord's identity is the note standing in for the third, so that one
  // has to survive too -- Csus2 restacked comes back as a Cm7 with no D in it.
  // Only where there is no third at all: a 13th chord has a ninth as well, and
  // insisting the stack keep that would rule out every dominant quartal voicing.
  const sus = !minorThird && !majorThird
    && (has(2) && !inStack(2) || has(5) && !inStack(5));
  const keeps = !sus && (!minorThird || inStack(3)) && (!majorThird || inStack(4))
    && (!has(6) || inStack(6)) && (!has(8) || inStack(8));
  return keeps ? stack : wideVoicing(chordIntervals, count);
}

// The same chord, opened out across octaves: every other voice lifted one, so
// a four-note chord spans close to two octaves instead of sitting inside one.
// C-E-G-B becomes C-G-E-B, which is how the chord is actually played when both
// hands are on the keyboard -- a bass note with the rest fanned out above it,
// rather than four notes bunched together in the middle.
//
// Works on any ascending list, so it takes either intervals from a root (the
// quartal fallback above) or absolute notes that have already been through the
// R/3/5/7 toggles (panels/tracker.js's pad voicing) -- lifting alternate voices
// is the same operation either way.
export function wideVoicing(notes, count = 4) {
  return notes.slice(0, count).map((n, i) => n + (i % 2 ? 12 : 0)).sort((a, b) => a - b);
}

// Which voicing toggle a chord tone answers to: R/3/5/7/9/11/13, indexed by
// the tone's semitone interval. Functional, not positional -- what makes an
// interval "the third" is the slot it fills in the stack, not where it happens
// to sit in a particular chord's array. 5 is the sus'd third, 6 and 8 are the
// flat and sharp fifth, 9 is a sixth (dim7's too), and 12 folds back onto the
// root as an octave doubling.
//
// The positional reading this replaces was right only for chords with no gaps:
// add9 is [0,4,7,14], so its fourth tone consulted the "7" toggle while the
// "9" toggle could never do anything at all, in that chord or any other.
export const TONE_SLOT = [0, 1, 1, 1, 1, 1, 2, 2, 2, 3, 3, 3, 0, 4, 4, 4, 5, 5, 5, 6, 6, 6];
export const slotOf = interval => TONE_SLOT[interval] ?? 6;

// Readout for the chord just entered -- the only way to know what a diatonic
// stack actually spelled, and what the keyboard panel's chord name shows.
// Matches the deltas against QUALITIES (normalized into one octave, since a
// diatonic stack can run past it); anything the table doesn't name falls back
// to listing its intervals.
export function nameChord(rootPitch, deltas) {
  const name = PITCH_NAMES[((rootPitch % 12) + 12) % 12];
  if (deltas.length < 2) return name;
  const norm = set => [...new Set(set.map(d => ((d % 12) + 12) % 12))].sort((a, b) => a - b).join(',');
  const mine = norm(deltas);
  for (const key in QUALITIES) {
    const [label, iv] = QUALITIES[key];
    if (norm(iv) === mine) return name + label;
  }
  return name + ' ' + deltas.slice(1).join('-');
}
