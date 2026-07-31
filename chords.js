// Chord flavors: named sets of chords that sound good together, one per genre.
//
// Pure data and lookups -- no DOM, no state, and no imports but scales.js's
// chord vocabulary. Same rules as scales.js, and for the same reason:
// panels/keyboard.js draws the pad strip and panels/tracker.js binds the digit
// row to it, and keeping this module free of panel dependencies is what lets
// both read from it (tracker -> keyboard is forbidden; see state.js's
// previewNote comment).
//
// A flavor exists because harmonizing a scale can't produce one. tracker.js's
// diatonicAt() stacks the scale it is given, so every chord it can reach is
// diatonic by construction -- and what makes a genre sound like itself is
// mostly the chords that aren't: the ♭VII in rock, the V7 in a minor key, the
// tritone sub in jazz, the Neapolitan ♭II in horror. So a flavor is a written
// list rather than a derivation, and it may say anything it likes.
//
// Each pad is [semitones above the key's root, QUALITIES key, roman label].
// The root itself is state.scaleRoot, applied by the caller -- the pads are
// degrees, not pitches, so changing key moves the whole set at once.
//
// `scale` is the SCALES index the flavor plays over. Picking a flavor sets it,
// so one choice arms the melody keys and the chord pads together and they
// cannot disagree; changing the scale afterwards is allowed and doesn't change
// the flavor back.
//
// `progs` are [name, pad-index sequence] -- canned progressions in the flavor's
// own pads, used by the stamp button.
//
// `moves` is optional: pad index -> the pads that idiomatically follow it. Only
// worth writing where the idiom beats the acoustics; rankNext() at the bottom
// of this file works the rest out from shared tones and root motion.

import { QUALITIES } from './scales.js';

// SCALES indices, named so the tables below read as music rather than numbers.
const BLUES = 3, MINOR = 4, DORIAN = 5, HARMONIC = 7, MAJOR = 8;

// Index 0 is "no flavor", the same way SCALES[0] is Chromatic: the pad strip
// is empty, the digit row keeps its chromatic meaning, and nothing about note
// entry changes. Everything after it is ordered roughly by how familiar the
// chord set is, since the list is read top to bottom by someone who doesn't
// yet know which one they want.
export const FLAVORS = [
  { name: 'None', scale: -1, pads: [], progs: [] },

  {
    name: 'Pop', scale: MAJOR,
    // The four chords behind a very large fraction of popular music, then the
    // rest of the major key's own triads. ♭VII is the one borrowed chord --
    // rock's flat seventh, which the major scale can't give you.
    pads: [
      [0, 'M', 'I'], [7, 'M', 'V'], [9, 'm', 'vi'], [5, 'M', 'IV'],
      [2, 'm', 'ii'], [4, 'm', 'iii'], [7, 'sus4', 'Vsus4'], [10, 'M', '♭VII'],
    ],
    progs: [
      ['I–V–vi–IV', [0, 1, 2, 3]],
      ['vi–IV–I–V', [2, 3, 0, 1]],
      ['I–vi–IV–V', [0, 2, 3, 1]],
    ],
  },

  {
    name: 'Lo-fi', scale: DORIAN,
    // Sevenths and ninths everywhere -- the genre is defined by never playing a
    // bare triad. Dorian underneath, with ♭VI borrowed from natural minor for
    // the one chord that darkens it.
    pads: [
      [0, 'm9', 'i9'], [5, '9', 'IV9'], [2, 'm7', 'ii7'], [10, 'maj7', '♭VIImaj7'],
      [3, 'maj7', '♭IIImaj7'], [7, 'm7', 'v7'], [8, 'maj7', '♭VImaj7'], [0, 'm7', 'i7'],
    ],
    progs: [
      ['i9–IV9', [0, 1]],
      ['i9–ii7–♭IIImaj7–IV9', [0, 2, 4, 1]],
      ['i7–♭VII–♭VI–♭VII', [7, 3, 6, 3]],
    ],
  },

  {
    name: 'Jazz', scale: MAJOR,
    // ii-V-I and the chords that decorate it. ♭II7 is the tritone substitution
    // -- the same tritone as V7 with a different root, and the one pad here
    // that is flatly outside the key.
    pads: [
      [2, 'm7', 'ii7'], [7, '7', 'V7'], [0, 'maj7', 'Imaj7'], [9, 'm7', 'vi7'],
      [4, 'm7', 'iii7'], [5, 'maj7', 'IVmaj7'], [11, 'm7b5', 'viiø7'], [1, '7', '♭II7'],
    ],
    progs: [
      ['ii–V–I', [0, 1, 2]],
      ['I–vi–ii–V', [2, 3, 0, 1]],
      ['iii–vi–ii–V', [4, 3, 0, 1]],
    ],
    // Where the idiom beats the acoustics: a ii wants its V and a V wants its
    // I, whatever tones they happen to share. Read by the suggestion ranking,
    // which otherwise works this out from shared tones and root motion.
    moves: { 0: [1], 1: [2, 7], 2: [3, 0], 3: [0, 4], 4: [3], 7: [2] },
  },

  {
    name: 'Blues', scale: BLUES,
    // Dominant sevenths on all three degrees -- the chord set that makes no
    // sense in classical harmony and is the entire sound of the genre.
    pads: [
      [0, '7', 'I7'], [5, '7', 'IV7'], [7, '7', 'V7'], [10, '7', '♭VII7'],
      [0, '9', 'I9'], [5, '9', 'IV9'], [3, 'M', '♭III'], [6, 'dim7', '♯IV°7'],
    ],
    progs: [
      // The 12-bar, one pad per bar, exactly as it is counted.
      ['12-bar', [0, 0, 0, 0, 1, 1, 0, 0, 2, 1, 0, 2]],
      ['quick change', [0, 1, 0, 0, 1, 1, 0, 0, 2, 1, 0, 2]],
      ['I–IV–V', [0, 1, 2]],
    ],
    // The 12-bar's own order. Every one of these chords shares a tritone with
    // the others, so shared tones say almost nothing here and the form says
    // everything.
    moves: { 0: [1, 2], 1: [0, 2], 2: [1, 0], 4: [1, 5], 5: [4, 0] },
  },

  {
    name: 'Epic', scale: MINOR,
    // Minor triads and the two major chords above them (♭VI, ♭VII) -- the
    // trailer-music sound. IV is borrowed from Dorian: a major fourth over a
    // minor key is the lift every one of these cues eventually reaches for.
    pads: [
      [0, 'm', 'i'], [8, 'M', '♭VI'], [10, 'M', '♭VII'], [5, 'm', 'iv'],
      [3, 'M', '♭III'], [7, 'm', 'v'], [0, 'sus2', 'isus2'], [5, 'M', 'IV'],
    ],
    progs: [
      ['i–♭VI–♭VII', [0, 1, 2]],
      ['i–♭VII–♭VI–♭VII', [0, 2, 1, 2]],
      ['i–iv–♭VI–♭VII', [0, 3, 1, 2]],
    ],
    // The rise ♭VI -> ♭VII -> i is the whole sound, and it is stepwise motion,
    // which the generic ranking scores below a fifth it should not prefer here.
    moves: { 0: [1, 3, 2], 1: [2, 0], 2: [0, 1], 3: [1, 0] },
  },

  {
    name: 'Chiptune', scale: MAJOR,
    // Plain triads, no sevenths: three or four square-wave voices can't spell a
    // 7th chord without losing the bass, and the NES-era writing this imitates
    // didn't try. ♭VII and ♭VI are the heroic borrowed pair.
    pads: [
      [0, 'M', 'I'], [5, 'M', 'IV'], [7, 'M', 'V'], [9, 'm', 'vi'],
      [10, 'M', '♭VII'], [8, 'M', '♭VI'], [4, 'm', 'iii'], [2, 'm', 'ii'],
    ],
    progs: [
      ['I–♭VII–IV–I', [0, 4, 1, 0]],
      ['I–V–vi–IV', [0, 2, 3, 1]],
      ['vi–IV–I–V', [3, 1, 0, 2]],
    ],
  },

  {
    name: 'Dreamy', scale: MAJOR,
    // Major sevenths and suspensions -- chords with no leading tone pulling
    // anywhere, which is what makes a progression float instead of resolve.
    pads: [
      [0, 'maj9', 'Imaj9'], [5, 'maj7', 'IVmaj7'], [9, 'm9', 'vi9'], [7, 'sus4', 'Vsus4'],
      [2, 'sus2', 'IIsus2'], [4, 'm7', 'iii7'], [0, 'add9', 'Iadd9'], [10, 'add9', '♭VIIadd9'],
    ],
    progs: [
      ['Imaj9–IVmaj7', [0, 1]],
      ['vi9–IVmaj7–Imaj9–Vsus4', [2, 1, 0, 3]],
      ['Iadd9–♭VIIadd9', [6, 7]],
    ],
  },

  {
    name: 'Funk', scale: DORIAN,
    // One or two chords held for a long time, so they have to be interesting on
    // their own: ninths, elevenths and a thirteenth rather than movement.
    pads: [
      [0, 'm9', 'i9'], [5, '9', 'IV9'], [7, '13', 'V13'], [3, 'maj9', '♭IIImaj9'],
      [2, 'm7', 'ii7'], [0, 'm7', 'i7'], [10, '9', '♭VII9'], [5, 'm7', 'iv7'],
    ],
    progs: [
      ['i9–IV9', [0, 1]],
      ['i9–IV9–♭VII9–♭IIImaj9', [0, 1, 6, 3]],
      ['i7–iv7', [5, 7]],
    ],
  },

  {
    name: 'Spooky', scale: HARMONIC,
    // Harmonic minor's own chords, which nothing else produces: a dominant V7
    // inside a minor key and a fully diminished seventh on the leading tone.
    // ♭II is the Neapolitan -- a major triad a half step above the tonic.
    pads: [
      [0, 'm', 'i'], [1, 'M', '♭II'], [7, '7', 'V7'], [11, 'dim7', 'vii°7'],
      [5, 'm', 'iv'], [8, 'M', '♭VI'], [3, 'aug', '♭III+'], [0, 'mMaj7', 'imMaj7'],
    ],
    progs: [
      ['i–♭II–V7–i', [0, 1, 2, 0]],
      ['i–iv–V7', [0, 4, 2]],
      ['i–vii°7–i', [0, 3, 0]],
    ],
  },

  {
    name: 'Andalusian', scale: HARMONIC,
    // The descending tetrachord i–♭VII–♭VI–V, flamenco's and every sea
    // shanty's cadence. V is major over a minor key, which is what makes the
    // last step land.
    pads: [
      [0, 'm', 'i'], [10, 'M', '♭VII'], [8, 'M', '♭VI'], [7, 'M', 'V'],
      [7, '7', 'V7'], [5, 'm', 'iv'], [3, 'M', '♭III'], [1, 'M', '♭II'],
    ],
    progs: [
      ['i–♭VII–♭VI–V', [0, 1, 2, 3]],
      ['i–♭VII–♭VI–V7', [0, 1, 2, 4]],
      ['iv–♭III–♭II–i', [5, 6, 7, 0]],
    ],
    // Strictly descending: the cadence is a walk down, one step at a time, and
    // stopping at V is the point. The fifth motion the generic ranking prefers
    // (i straight to V) skips the two chords the flavor exists for.
    moves: { 0: [1], 1: [2], 2: [3, 4], 3: [0], 4: [0], 5: [6], 6: [7, 1], 7: [0] },
  },
];

// The pad at `i` of flavor `f`, or undefined -- for "no flavor", for a digit
// past the end of a shorter pad set, and for a stale saved preference pointing
// at a flavor that no longer exists.
export function padOf(f, i) {
  return (FLAVORS[f] || FLAVORS[0]).pads[i];
}

export function padsOf(f) {
  return (FLAVORS[f] || FLAVORS[0]).pads;
}

export function progsOf(f) {
  return (FLAVORS[f] || FLAVORS[0]).progs;
}

// The pads that most plausibly come after `from`, best first, at most three.
// Empty when there is no previous chord to follow.
//
// The flavor's own `moves` table wins where it has an opinion -- a ii wants its
// V whatever the two happen to share. Otherwise this is worked out from the
// chords themselves, which gets every flavor a suggestion for free and needs no
// per-genre data: chords that share notes with the one just played sound like a
// continuation of it, and root motion by a fourth or fifth is the strongest
// pull in tonal music (it is what a cadence is). A step up or down is the weaker
// second-best. Everything else scores on shared tones alone.
export function rankNext(f, from) {
  const flavor = FLAVORS[f] || FLAVORS[0];
  const pads = flavor.pads;
  if (from < 0 || !pads[from]) return [];
  if (flavor.moves && flavor.moves[from]) return flavor.moves[from];

  // The pitch classes a pad actually sounds, as degrees of the key.
  const tones = i => new Set(QUALITIES[pads[i][1]][1].map(iv => (pads[i][0] + iv) % 12));
  const played = tones(from);

  return pads
    .map((pad, i) => {
      if (i === from) return null;   // a chord doesn't suggest itself
      let shared = 0;
      for (const t of tones(i)) if (played.has(t)) shared++;
      const step = (((pad[0] - pads[from][0]) % 12) + 12) % 12;
      const motion = step === 5 || step === 7 ? 3 : step === 2 || step === 10 ? 1 : 0;
      return { i, score: shared + motion };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, 3)
    .map(x => x.i);
}
