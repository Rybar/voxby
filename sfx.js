// Sound-effect recipes: what rhythms.js is to rhythm, this is to one-shot SFX.
//
// Data and arithmetic only -- no DOM and no state. Same rule as chords.js,
// scales.js and rhythms.js, and for the same reason: panels/sfx-view.js draws
// itself from this, and keeping the sound design out of the view is what makes
// it reviewable as sound design. The only import is engine.js, for its
// property-index constants and, at the bottom, its song constructors.
//
// Why recipes at all. Rolling all 29 instrument parameters uniformly does not
// produce sound effects: it produces silence (FX_DRIVE near 0, every volume
// low), a wall of noise (three sources at 255 each), or a four-second wash
// (a long envelope with a long delay). Nearly every roll is unusable, and the
// few that aren't are unusable in a different way each time. What makes a
// randomizer worth pressing is that it rolls *inside an archetype*: a zap is
// always short, always pitch-dropping, never noisy, and only the details vary.
// So each recipe below is a table of per-parameter rules, and the ranges in it
// are the actual design work.
//
// A rule is one of:
//
//   n           a fixed value
//   [lo, hi]    an integer rolled in that range, inclusive
//   pick(a, b)  one of these values, chosen evenly
//
// Arrays are always ranges and picks are always tagged, so neither can be read
// as the other -- the same reason panels/tracker.js's parseFxInput refuses
// three bare hex digits rather than guessing which byte they are.
//
// A recipe names only what it changes; anything it leaves out falls back to
// NEUTRAL below. It falls back there rather than to the channel's current
// instrument on purpose: inheriting would let a wild LFO left over from the
// last preset leak into every roll, and a roll has to sound like its recipe
// whatever the dialog was opened on top of.
//
// How the ranges below were arrived at, and how to check a change to them.
// Two measurements, both taken by rolling a recipe sixty times and rendering
// each roll through oneshot.js -- the same synth the export uses, driven on
// the main thread, so a script can measure a hundred rolls in a second.
//
// **Level.** Take the peak sample of each roll and count how many land in a
// usable band (audible, not pinned to full scale). Every recipe here sits at
// 100%, medians clustered around 0.3-0.5 of full scale. Anything that drops a
// recipe under about 90% is a range that wants narrowing, and correlating peak
// against each rolled parameter says which one -- that is how the FX_DIST trap
// below was found, after reading its name suggested the opposite of what it
// does.
//
// **Length.** Nominal length is arithmetic ((att^2+sust^2+rel^2)*4 samples,
// see soundLengthSamples), and it is *not* what you hear: ENV_EXP_DECAY bends
// the release into `(1-e) * 3^(-i13/16 * e)`, so at 200 the sound is inaudible
// a quarter of the way through its own tail. Measure the audible length
// instead -- the last sample above 2% of the roll's peak. The gap between the
// two numbers is how much of the envelope the decay is eating, and it is large:
// Thud once had a 300 ms envelope that stopped being audible at 100 ms.
//
// The envelope ranges were widened across every recipe in August 2026 for
// exactly that reason -- almost every roll came out a click. Medians before
// and after, in audible milliseconds:
//
//     Blip 20 -> 121    Jump 66 -> 167     Zap 90 -> 245
//     Hurt 74 -> 199    Laser 87 -> 223    Pickup 100 -> 329
//     Thud 100 -> 277   Powerup 472 -> 905  Explosion 688 -> 1314
//
// Both halves of that came from raising attack/sustain/release *and* pulling
// back the ENV_EXP_DECAY ceilings, since past about 120 the decay cancels
// whatever the release is set to.
//
// **Stacking.** A recipe that rolls a multi-note figure has to be quieter than
// one that does not, and by more than seems reasonable. The notes of a figure
// overlap -- that overlap is what makes an arpeggio a chord rather than a
// scale -- so peak level goes up with the note count, and Powerup went from a
// 0.43 median to 1.14 with three quarters of its rolls clipping the moment it
// grew a figure. Nothing in a per-parameter rule table can see that, because
// the figure is rolled separately from the sound. So FX_DRIVE carries it: the
// melodic recipes sit in the teens and twenties where the single-note ones sit
// near forty, and that is not a mistake in either.
//
// The same lesson landed twice. The second time was when Fill stopped handing
// back single notes (see DEFAULT_FIGURE): seven recipes that had only ever
// been measured one note at a time started arriving as two or three, and every
// one of their drives had to come down again. If a recipe's figure changes,
// re-measure its level -- the two are not independent, however much the rule
// table makes them look it.
//
// Where all seventeen stand, at 300 rolls each with their own figures: no
// silent rolls, clipping under 2% for everything except Chaos (~5%, which is
// the price of its parameter space), peak medians 0.23 to 0.41.
//
// None of this is in the test suite, with one exception: a level threshold
// would be flaky, a duration one would pin the sound design in place, and
// "sounds good" is not measurable at all. The exception is Chaos, whose whole
// specification is "never rolls something you cannot hear" -- that one is
// checked, against a seeded generator so it cannot flake. It is otherwise a
// listening job with a meter to hand.

import * as engine from './engine.js';

// `oneOf`, not `values`: every Array already has a `.values` method, so a
// pick tagged with that name is indistinguishable from a range by any test
// cheaper than Array.isArray -- which is exactly the confusion this tag exists
// to prevent. isRange is still checked first below, belt and braces.
export const pick = (...oneOf) => ({ oneOf });

// The plain, inert instrument every recipe starts from: one sine, unity drive,
// an open filter, no modulation and no delay. Audible, and nothing more.
//
// FX_DRIVE deserves its 32: player-small.js reads it as `drive = i[24]/32` and
// multiplies the sample by it, so 32 is unity gain and 0 is silence. It is the
// single likeliest way for a careless roll to produce nothing at all, which is
// why no recipe below lets it near the bottom of its slider range.
const NEUTRAL = {
  [engine.OSC1_WAVEFORM]: 0,
  [engine.OSC1_VOL]: 192,
  [engine.OSC1_SEMI]: 128,   // 128 = the note as written; 92-164 is the panel's range
  [engine.OSC1_XENV]: 0,
  [engine.OSC2_WAVEFORM]: 0,
  [engine.OSC2_VOL]: 0,
  [engine.OSC2_SEMI]: 128,
  [engine.OSC2_DETUNE]: 0,
  [engine.OSC2_XENV]: 0,
  [engine.NOISE_VOL]: 0,
  [engine.ENV_ATTACK]: 0,
  [engine.ENV_SUSTAIN]: 8,
  [engine.ENV_RELEASE]: 40,
  [engine.ENV_EXP_DECAY]: 0,
  [engine.ARP_CHORD]: 0,
  [engine.ARP_SPEED]: 0,
  [engine.LFO_WAVEFORM]: 0,
  [engine.LFO_AMT]: 0,
  [engine.LFO_FREQ]: 0,
  [engine.LFO_FX_FREQ]: 0,
  [engine.FX_FILTER]: 2,     // 2 = low-pass; 1 high, 3 band (panels/instrument.js)
  [engine.FX_FREQ]: 255,     // wide open
  [engine.FX_RESONANCE]: 0,
  [engine.FX_DIST]: 0,
  [engine.FX_DRIVE]: 32,
  [engine.FX_PAN_AMT]: 0,
  [engine.FX_PAN_FREQ]: 0,
  [engine.FX_DELAY_AMT]: 0,
  [engine.FX_DELAY_TIME]: 0,
};

// What a lock freezes, named and ordered as panels/instrument.js's own section
// headings -- a lock has to read as "keep what those sliders say", so the two
// lists must not drift apart.
export const GROUPS = [
  ['Osc 1', [engine.OSC1_WAVEFORM, engine.OSC1_VOL, engine.OSC1_SEMI, engine.OSC1_XENV]],
  ['Osc 2', [engine.OSC2_WAVEFORM, engine.OSC2_VOL, engine.OSC2_SEMI, engine.OSC2_DETUNE, engine.OSC2_XENV]],
  ['Noise', [engine.NOISE_VOL]],
  ['Env', [engine.ENV_ATTACK, engine.ENV_SUSTAIN, engine.ENV_RELEASE, engine.ENV_EXP_DECAY]],
  ['Arp', [engine.ARP_CHORD, engine.ARP_SPEED]],
  ['LFO', [engine.LFO_WAVEFORM, engine.LFO_AMT, engine.LFO_FREQ, engine.LFO_FX_FREQ]],
  ['FX', [engine.FX_FILTER, engine.FX_FREQ, engine.FX_RESONANCE, engine.FX_DIST, engine.FX_DRIVE,
    engine.FX_PAN_AMT, engine.FX_PAN_FREQ, engine.FX_DELAY_AMT, engine.FX_DELAY_TIME]],
];

// ARP_CHORD packs two semitone offsets into one byte, high nibble first
// (panels/instrument.js's bindArpNotes). These are the intervals that read as
// an arpeggio rather than as a mistake: fourths, fifths, thirds, octaves.
const ARP_MAJOR = pick(0x47, 0x74, 0x35, 0x53, 0x4C, 0x7C, 0x57);

// A note on the two ways this synth sweeps pitch, since half the recipes below
// turn on one of them and nothing in the parameter names says so.
//
// XENV is the envelope applied to pitch: player-small.js computes the
// oscillator step as `o1t * e ** (i[3]/32)`, where e is the volume envelope. So
// pitch follows loudness -- it *rises* through the attack and *falls* through
// the release. A zap or a thud is therefore an XENV sound with no attack (all
// fall); a jump is the same parameter with a real attack and almost no release
// (all rise). There is no third option, which is why no recipe here sweeps
// upward and then holds.
//
// The arpeggio is the other one: it retriggers the note at fixed semitone
// offsets, fast enough to hear as one gesture. That is what makes a coin sound
// a coin, and it is a ladder rather than a glide.
//
// One more trap, since two recipes below would otherwise get it wrong. FX_DIST
// reads as `dist = i[23] * 1e-5`, and player-small.js multiplies the sample by
// it, clamps to +/-1, then divides back out -- so the setting fixes a ceiling
// at 1/dist, and raising it makes the sound *quieter*, not dirtier. At these
// signal levels a value of 100 costs about 40x. It is an attenuator wearing a
// texture control's name, and the built-in presets agree: of the 28 that ship,
// sixteen leave it at 0 and almost all the rest sit between 1 and 21. Any
// recipe that rolls it stays in that band.

// --- figures: what goes in the step lane ---
//
// Rolling the sound and rolling the *figure* are two different jobs, and only
// the first one has anything to do with the 29 parameters above. A pickup is
// two or three notes climbing; an alarm is two notes alternating; an explosion
// is one. Which of those a recipe wants is part of what the recipe is, so it
// lives here beside the rules, in a `figure` field.
//
// "Intelligently" means the intervals come out of a small set that reads as
// music -- fourths, fifths, thirds, octaves -- rather than out of the full
// chromatic scale, and the notes are laid out in a shape rather than scattered.
// A random walk through twelve semitones is not a sound effect, it is a
// mistake with a rhythm.
//
// A recipe that says nothing about its figure gets DEFAULT_FIGURE: one note,
// which is what most sound effects are and what the lane already starts as.

// Semitone steps between consecutive notes. A figure cycles through whichever
// of these it drew, so [4, 3] climbs a major triad and [7] stacks fifths.
export const INTERVALS = {
  triad: [4, 3], minor: [3, 4], fourths: [5], fifths: [7], octaves: [12],
  thirds: [4], seconds: [2], wide: [7, 5], sixths: [9],
  // The second group is deliberately less well behaved. A tritone and a
  // chromatic run are the intervals that stop a figure sounding like a major
  // triad for the hundredth time, and a diminished or whole-tone stack is what
  // a machine sounds like when it is not trying to be music.
  tritone: [6], dim: [3], whole: [2, 2], penta: [2, 3], leap: [12, 7], chromatic: [1],
};

// Where each note of a figure sits, in semitones from the root.
//
// The shapes are named for what they sound like rather than for their maths,
// because that is how you pick one: `cascade` is the sci-fi power-down, `alt`
// is the alarm, `arch` is the little fanfare that comes back down.
// There is deliberately no 'single' here. One note is `count: 1`, and having
// it as a shape as well meant two knobs for one thing -- and the shape won:
// a recipe that rolled count 3 and shape 'single' still got one note, because
// every shape is sliced to `count` and 'single' only ever produced one offset.
// That is what made Fill hand back a single note far more often than any
// recipe's count range said it should.
export const SHAPES = ['repeat', 'rise', 'fall', 'arch', 'valley', 'alt', 'wander', 'cascade',
  'zigzag', 'ladder', 'drop'];

// When each note lands, as rows to advance before it. Pitch is only half of a
// figure -- two notes a fifth apart are a fanfare or a gallop depending
// entirely on where the second one falls -- and the lane has sixteen rows to
// say it with, so leaving every note on the row after the last one throws away
// the more expressive half.
export const RHYTHMS = ['even', 'gallop', 'accel', 'ritard', 'swing', 'pairs'];

function rhythmGaps(rhythm, count) {
  const gaps = [];
  for (let n = 1; n < count; n++) {
    switch (rhythm) {
      case 'gallop': gaps.push(n % 2 ? 1 : 2); break;         // short-short-long
      case 'swing': gaps.push(n % 2 ? 2 : 1); break;          // long-short
      case 'pairs': gaps.push(n % 2 ? 1 : 3); break;          // two together, then a wait
      // Both of these are capped at 3: a gap of 4 at 200 ms a step is most of
      // a second of nothing, which reads as two sounds rather than as one.
      case 'accel': gaps.push(Math.max(1, 3 - Math.floor((n - 1) / 2))); break;
      case 'ritard': gaps.push(Math.min(3, 1 + Math.floor(n / 2))); break;
      default: gaps.push(1);
    }
  }
  return gaps;
}

function figureOffsets(shape, count, iv, rnd) {
  const out = [];
  const step = n => iv[n % iv.length];
  let p = 0;
  switch (shape) {
    case 'repeat':
      for (let n = 0; n < count; n++) out.push(0);
      break;
    case 'alt':
      for (let n = 0; n < count; n++) out.push(n % 2 ? iv[0] : 0);
      break;
    case 'rise':
      for (let n = 0; n < count; n++) { out.push(p); p += step(n); }
      break;
    case 'fall':
      for (let n = 0; n < count; n++) { out.push(p); p -= step(n); }
      break;
    case 'arch': case 'valley': {
      // Built as a rise (or a fall) and then mirrored, so the way down is the
      // way up backwards -- an arch whose two halves used different intervals
      // reads as two unrelated figures stuck together.
      const sign = shape === 'arch' ? 1 : -1;
      const half = Math.ceil((count + 1) / 2);
      const rise = [];
      for (let n = 0; n < half; n++) { rise.push(p); p += sign * step(n); }
      out.push(...rise);
      for (let n = rise.length - 2; out.length < count; n--) out.push(rise[Math.max(0, n)]);
      break;
    }
    case 'wander':
      for (let n = 0; n < count; n++) { out.push(p); p += (rnd() < 0.5 ? -1 : 1) * step(n); }
      break;
    case 'cascade':
      // Each drop wider than the last: the interval that makes a machine sound
      // like it is losing power rather than playing a scale.
      for (let n = 0; n < count; n++) { out.push(p); p -= step(n) * (n + 1); }
      break;
    case 'zigzag':
      // Alternates direction and widens as it goes: neither a scale nor a
      // trill, which is what makes it read as deliberate rather than random.
      for (let n = 0; n < count; n++) { out.push(p); p += (n % 2 ? -1 : 1) * step(n) * (1 + (n >> 1)); }
      break;
    case 'ladder': {
      // Climbs, then stays. The fanfare that arrives somewhere and holds it,
      // rather than the one that keeps going until it runs out of notes.
      const climb = Math.max(1, Math.ceil(count / 2));
      for (let n = 0; n < count; n++) { out.push(p); if (n < climb - 1) p += step(n); }
      break;
    }
    case 'drop':
      // One note up high, then the rest well below it -- the "denied" sound.
      for (let n = 0; n < count; n++) out.push(n ? -step(0) * 2 : 0);
      break;
    default:
      out.push(0);
  }
  return out.slice(0, count);
}

// Move the whole figure to fit between `lo` and `hi` rather than clamping note
// by note: clamping flattens the end of a wide cascade into a repeated note,
// which is the one thing the shape was chosen to avoid. Only a figure wider
// than the whole allowed range gets clamped, and nothing sensible is.
function fitToRange(notes, lo, hi) {
  const min = Math.min(...notes), max = Math.max(...notes);
  const shift = min < lo ? lo - min : max > hi ? hi - max : 0;
  return notes.map(n => Math.max(lo, Math.min(hi, n + shift)));
}

// Weighted towards 'even' by repetition, the same way a recipe weights a pick:
// most figures should land on consecutive rows, and the other rhythms are the
// variation rather than the norm. A recipe overrides this when its archetype
// has a rhythm of its own -- an alarm is evenly spaced by definition.
const DEFAULT_RHYTHM = { oneOf: ['even', 'even', 'even', 'even', 'gallop', 'swing', 'accel', 'ritard', 'pairs'] };

// The figure a recipe gets when it declares none -- seven of the effects do,
// and this is what Fill hands them.
//
// Weighted to two notes rather than to one. Pressing Fill is an explicit "give
// me a figure", and a figure of one note is barely a figure: if you wanted the
// single note you already had it and would not have pressed the button. One is
// still in the bag, because a double zap is not always what a zap wants, but
// it is no longer the answer three times in four.
const DEFAULT_FIGURE = {
  count: { oneOf: [1, 2, 2, 2, 3] },
  shape: { oneOf: ['rise', 'fall', 'arch', 'repeat', 'wander', 'zigzag'] },
  intervals: { oneOf: [INTERVALS.fourths, INTERVALS.fifths, INTERVALS.thirds, INTERVALS.seconds, INTERVALS.octaves] },
  stepMs: [45, 110],
  rhythm: DEFAULT_RHYTHM,
};

// A figure for `recipe`, rooted at `root` and kept inside `bounds`.
// Returns { steps, stepMs } -- the whole lane, and the timing to play it at,
// because how fast a figure runs is as much part of it as which notes it uses.
export function rollFigure(recipe, root, bounds, rnd = Math.random) {
  const f = { ...DEFAULT_FIGURE, ...(recipe.figure || {}) };
  // `intervals` and `shape` are picked by hand rather than through rollValue:
  // an interval set is itself an array, which rollValue would read as a range.
  const shape = isPick(f.shape) ? f.shape.oneOf[Math.floor(rnd() * f.shape.oneOf.length)] : f.shape;
  const iv = isPick(f.intervals) ? f.intervals.oneOf[Math.floor(rnd() * f.intervals.oneOf.length)] : f.intervals;
  const count = Math.max(1, Math.min(STEPS, rollValue(f.count, rnd)));
  const notes = fitToRange(figureOffsets(shape, count, iv, rnd).map(o => root + o), bounds.lo, bounds.hi);

  const rhythm = isPick(f.rhythm) ? f.rhythm.oneOf[Math.floor(rnd() * f.rhythm.oneOf.length)] : f.rhythm;
  const gaps = rhythmGaps(rhythm, notes.length);

  const steps = new Array(STEPS).fill(0);
  // The gap *is* the advance, so nothing increments row on its own: a gap of 1
  // means the next row, and adding a gap on top of a post-increment would turn
  // every 'even' figure into a gallop.
  let row = 0;
  for (let n = 0; n < notes.length; n++) {
    if (n) row += gaps[n - 1];
    if (row >= STEPS) break;
    steps[row] = notes[n];
  }
  return { steps, stepMs: rollValue(f.stepMs, rnd), shape, rhythm };
}

export const RECIPES = [
  {
    name: 'Zap',
    hint: 'A short pitch-dropping blast. Lasers, shots, sparks.',
    rules: {
      [engine.OSC1_WAVEFORM]: pick(1, 2),
      [engine.OSC1_VOL]: [140, 255],
      [engine.OSC1_SEMI]: [128, 142],
      [engine.OSC1_XENV]: [140, 255],
      [engine.OSC2_WAVEFORM]: pick(1, 2),
      [engine.OSC2_VOL]: [0, 120],
      [engine.OSC2_SEMI]: [128, 142],
      [engine.OSC2_DETUNE]: [0, 40],
      [engine.OSC2_XENV]: [140, 255],
      [engine.ENV_SUSTAIN]: [4, 22],
      [engine.ENV_RELEASE]: [40, 85],
      [engine.ENV_EXP_DECAY]: [0, 70],
      [engine.FX_FREQ]: [110, 255],
      [engine.FX_RESONANCE]: [0, 180],
      [engine.FX_DRIVE]: [24, 50],
    },
  },
  {
    name: 'Laser',
    hint: 'A zap with the filter swept by the LFO, for the chirp on top.',
    rules: {
      [engine.OSC1_WAVEFORM]: pick(1, 2),
      [engine.OSC1_VOL]: [150, 255],
      [engine.OSC1_SEMI]: [128, 146],
      [engine.OSC1_XENV]: [120, 240],
      [engine.OSC2_WAVEFORM]: pick(1, 2),
      [engine.OSC2_VOL]: [40, 140],
      [engine.OSC2_SEMI]: [128, 146],
      [engine.OSC2_DETUNE]: [0, 60],
      [engine.OSC2_XENV]: [120, 240],
      [engine.ENV_SUSTAIN]: [4, 24],
      [engine.ENV_RELEASE]: [42, 90],
      [engine.ENV_EXP_DECAY]: [0, 65],
      [engine.LFO_WAVEFORM]: pick(0, 1, 2),
      [engine.LFO_AMT]: [60, 220],
      [engine.LFO_FREQ]: [4, 12],
      [engine.LFO_FX_FREQ]: 1,
      [engine.FX_FREQ]: [40, 170],
      [engine.FX_RESONANCE]: [110, 240],
      [engine.FX_DRIVE]: [30, 56],
    },
  },
  {
    name: 'Explosion',
    hint: 'Noise-led, long tail, filtered down. Blasts, crashes, impacts.',
    rules: {
      [engine.OSC1_WAVEFORM]: pick(0, 2),
      [engine.OSC1_VOL]: [60, 160],
      [engine.OSC1_SEMI]: [92, 110],
      [engine.OSC1_XENV]: [60, 200],
      [engine.NOISE_VOL]: [180, 255],
      [engine.ENV_ATTACK]: [0, 10],
      [engine.ENV_SUSTAIN]: [16, 50],
      [engine.ENV_RELEASE]: [100, 190],
      [engine.ENV_EXP_DECAY]: [30, 120],
      [engine.FX_FREQ]: [45, 95],
      [engine.FX_RESONANCE]: [0, 120],
      [engine.FX_DIST]: [0, 10],
      [engine.FX_DRIVE]: [30, 46],
      [engine.FX_DELAY_AMT]: [0, 60],
      [engine.FX_DELAY_TIME]: pick(1, 2, 3),
    },
  },
  {
    name: 'Pickup',
    hint: 'Two bright tones in quick succession. Coins, collectibles, ticks.',
    figure: { count: [2, 3], shape: pick('rise', 'rise', 'arch'),
      intervals: pick(INTERVALS.triad, INTERVALS.fourths, INTERVALS.fifths, INTERVALS.thirds), stepMs: [45, 85] },
    rules: {
      [engine.OSC1_WAVEFORM]: pick(1, 3),
      [engine.OSC1_VOL]: [150, 255],
      [engine.OSC1_SEMI]: [138, 152],
      [engine.OSC2_WAVEFORM]: pick(1, 3),
      [engine.OSC2_VOL]: [0, 120],
      [engine.OSC2_SEMI]: [138, 152],
      [engine.OSC2_DETUNE]: [0, 24],
      [engine.ENV_SUSTAIN]: [6, 20],
      [engine.ENV_RELEASE]: [40, 80],
      [engine.ENV_EXP_DECAY]: [0, 50],
      [engine.ARP_CHORD]: ARP_MAJOR,
      // Slow enough to hear as two or three notes rather than as a texture:
      // the speed doubles every notch (the synth reads it as
      // `rowLen * 2 ** (2 - i[15])`), so by 5 the steps are a blur and the
      // arpeggio stops sounding like a coin and starts sounding like a buzz.
      [engine.ARP_SPEED]: [2, 4],
      [engine.FX_FREQ]: [180, 255],
      [engine.FX_RESONANCE]: [0, 80],
      [engine.FX_DRIVE]: [18, 34],
      [engine.FX_DELAY_AMT]: [0, 90],
      [engine.FX_DELAY_TIME]: pick(1, 2),
    },
  },
  {
    name: 'Powerup',
    hint: 'A climbing arpeggio with a tail. Level-ups, unlocks, fanfares.',
    figure: { count: [3, 5], shape: pick('rise', 'rise', 'arch'),
      intervals: pick(INTERVALS.triad, INTERVALS.minor, INTERVALS.fourths, INTERVALS.fifths), stepMs: [60, 110] },
    rules: {
      [engine.OSC1_WAVEFORM]: pick(1, 2, 3),
      [engine.OSC1_VOL]: [140, 230],
      [engine.OSC1_SEMI]: [116, 130],
      [engine.OSC2_WAVEFORM]: pick(1, 3),
      [engine.OSC2_VOL]: [60, 160],
      [engine.OSC2_SEMI]: [128, 142],
      [engine.OSC2_DETUNE]: [0, 48],
      [engine.ENV_ATTACK]: [0, 14],
      [engine.ENV_SUSTAIN]: [16, 46],
      [engine.ENV_RELEASE]: [60, 135],
      [engine.ENV_EXP_DECAY]: [0, 35],
      [engine.ARP_CHORD]: ARP_MAJOR,
      [engine.ARP_SPEED]: [4, 6],
      [engine.FX_FREQ]: [140, 255],
      [engine.FX_RESONANCE]: [0, 120],
      [engine.FX_DRIVE]: [10, 22],
      [engine.FX_DELAY_AMT]: [30, 130],
      [engine.FX_DELAY_TIME]: pick(1, 2, 3),
    },
  },
  {
    name: 'Jump',
    hint: 'A rising blip: pitch climbs through the attack, then it is gone.',
    rules: {
      [engine.OSC1_WAVEFORM]: pick(1, 3),
      [engine.OSC1_VOL]: [160, 255],
      [engine.OSC1_SEMI]: [116, 134],
      [engine.OSC1_XENV]: [60, 170],
      // The attack is the whole sound here -- see the XENV note above.
      [engine.ENV_ATTACK]: [18, 42],
      [engine.ENV_SUSTAIN]: [2, 12],
      [engine.ENV_RELEASE]: [18, 45],
      [engine.ENV_EXP_DECAY]: [0, 45],
      [engine.FX_FREQ]: [150, 255],
      [engine.FX_RESONANCE]: [0, 90],
      [engine.FX_DRIVE]: [28, 48],
    },
  },
  {
    name: 'Hurt',
    hint: 'Detuned and dirty, with noise mixed in. Damage, misses, errors.',
    rules: {
      [engine.OSC1_WAVEFORM]: pick(1, 2),
      [engine.OSC1_VOL]: [150, 240],
      [engine.OSC1_SEMI]: [104, 124],
      [engine.OSC1_XENV]: [60, 180],
      [engine.OSC2_WAVEFORM]: pick(1, 2),
      [engine.OSC2_VOL]: [90, 180],
      [engine.OSC2_SEMI]: [104, 124],
      [engine.OSC2_DETUNE]: [40, 160],
      [engine.OSC2_XENV]: [40, 160],
      [engine.NOISE_VOL]: [60, 160],
      [engine.ENV_SUSTAIN]: [6, 22],
      [engine.ENV_RELEASE]: [40, 85],
      [engine.ENV_EXP_DECAY]: [20, 100],
      // Low-pass listed twice: a pick is even, so a repeat is how a recipe
      // weights one. Band-pass keeps only a narrow band and is the more
      // characterful of the two, so it comes up on one roll in three.
      [engine.FX_FILTER]: pick(2, 2, 3),
      [engine.FX_FREQ]: [90, 175],
      [engine.FX_RESONANCE]: [40, 200],
      [engine.FX_DIST]: [0, 14],
      [engine.FX_DRIVE]: [30, 50],
    },
  },
  {
    name: 'Thud',
    hint: 'Low, blunt and dry. Landings, doors, body hits.',
    rules: {
      [engine.OSC1_WAVEFORM]: pick(0, 3),
      [engine.OSC1_VOL]: [180, 255],
      [engine.OSC1_SEMI]: [92, 108],
      [engine.OSC1_XENV]: [120, 255],
      [engine.OSC2_WAVEFORM]: pick(0, 3),
      [engine.OSC2_VOL]: [0, 80],
      [engine.OSC2_SEMI]: [92, 108],
      [engine.OSC2_XENV]: [120, 255],
      [engine.NOISE_VOL]: [0, 60],
      [engine.ENV_SUSTAIN]: [8, 26],
      [engine.ENV_RELEASE]: [50, 105],
      [engine.ENV_EXP_DECAY]: [40, 130],
      [engine.FX_FREQ]: [30, 62],
      [engine.FX_RESONANCE]: [0, 100],
      [engine.FX_DIST]: [0, 8],
      [engine.FX_DRIVE]: [28, 44],
    },
  },
  {
    name: 'Blip',
    hint: 'The shortest useful sound. Menu moves, typing, cursor steps.',
    rules: {
      [engine.OSC1_WAVEFORM]: pick(1, 3),
      [engine.OSC1_VOL]: [150, 255],
      [engine.OSC1_SEMI]: [128, 152],
      [engine.ENV_SUSTAIN]: [3, 12],
      [engine.ENV_RELEASE]: [26, 48],
      [engine.ENV_EXP_DECAY]: [0, 55],
      [engine.FX_FREQ]: [180, 255],
      [engine.FX_RESONANCE]: [0, 60],
      [engine.FX_DRIVE]: [30, 50],
    },
  },
  {
    name: 'Alarm',
    hint: 'Two pitches trading back and forth. Warnings, sirens, timers.',
    figure: { count: [3, 6], shape: 'alt',
      intervals: pick(INTERVALS.fourths, INTERVALS.fifths, INTERVALS.thirds, INTERVALS.seconds), stepMs: [110, 190] },
    rules: {
      [engine.OSC1_WAVEFORM]: pick(1, 2),
      [engine.OSC1_VOL]: [160, 255],
      [engine.OSC1_SEMI]: [122, 138],
      [engine.OSC2_WAVEFORM]: pick(1, 2),
      [engine.OSC2_VOL]: [80, 180],
      [engine.OSC2_SEMI]: [122, 138],
      [engine.OSC2_DETUNE]: [10, 70],
      [engine.ENV_ATTACK]: [2, 14],
      [engine.ENV_SUSTAIN]: [14, 40],
      [engine.ENV_RELEASE]: [30, 70],
      [engine.ENV_EXP_DECAY]: [0, 40],
      // Band-pass most of the time: an alarm is a narrow, nasal thing, and the
      // band is what stops two square waves reading as a chord.
      [engine.FX_FILTER]: pick(2, 3, 3),
      [engine.FX_FREQ]: [70, 180],
      [engine.FX_RESONANCE]: [80, 220],
      [engine.FX_DRIVE]: [22, 40],
    },
  },
  {
    name: 'Warp',
    hint: 'A long sweeping machine noise. Teleports, engines, power-ups of the wrong kind.',
    figure: { count: [2, 3], shape: pick('fall', 'cascade', 'drop'),
      intervals: pick(INTERVALS.fifths, INTERVALS.octaves, INTERVALS.wide), stepMs: [90, 180] },
    rules: {
      [engine.OSC1_WAVEFORM]: pick(1, 2),
      [engine.OSC1_VOL]: [140, 240],
      [engine.OSC1_SEMI]: [98, 126],
      [engine.OSC1_XENV]: [80, 220],
      [engine.OSC2_WAVEFORM]: pick(1, 2),
      [engine.OSC2_VOL]: [60, 180],
      [engine.OSC2_SEMI]: [98, 132],
      [engine.OSC2_DETUNE]: [20, 140],
      [engine.OSC2_XENV]: [80, 220],
      [engine.NOISE_VOL]: [0, 70],
      // The long attack is doing the work: XENV ties pitch to loudness, so a
      // slow swell is a slow rise in pitch as well -- see the XENV note above.
      [engine.ENV_ATTACK]: [10, 50],
      [engine.ENV_SUSTAIN]: [20, 70],
      [engine.ENV_RELEASE]: [90, 180],
      [engine.ENV_EXP_DECAY]: [0, 60],
      [engine.LFO_WAVEFORM]: pick(0, 1, 2),
      [engine.LFO_AMT]: [90, 255],
      [engine.LFO_FREQ]: [1, 7],
      [engine.LFO_FX_FREQ]: 1,
      [engine.FX_FILTER]: pick(2, 3),
      [engine.FX_FREQ]: [40, 150],
      [engine.FX_RESONANCE]: [100, 220],
      [engine.FX_DRIVE]: [22, 40],
      [engine.FX_DELAY_AMT]: [40, 150],
      [engine.FX_DELAY_TIME]: pick(2, 3, 4, 6),
    },
  },
  {
    name: 'Drone',
    hint: 'A slow, wide texture that sits under everything. Atmosphere, engines, dread.',
    figure: { count: [1, 3], shape: pick('repeat', 'repeat', 'rise'), intervals: INTERVALS.octaves, stepMs: [150, 250] },
    rules: {
      [engine.OSC1_WAVEFORM]: pick(0, 2, 3),
      [engine.OSC1_VOL]: [110, 200],
      [engine.OSC1_SEMI]: [92, 116],
      [engine.OSC2_WAVEFORM]: pick(0, 2, 3),
      [engine.OSC2_VOL]: [80, 180],
      [engine.OSC2_SEMI]: [92, 120],
      // A wide detune between two low oscillators is the whole sound: the two
      // beat against each other slowly, which is what stops a held note being
      // a held note.
      [engine.OSC2_DETUNE]: [30, 200],
      [engine.NOISE_VOL]: [0, 80],
      [engine.ENV_ATTACK]: [30, 90],
      [engine.ENV_SUSTAIN]: [40, 110],
      [engine.ENV_RELEASE]: [80, 180],
      [engine.ENV_EXP_DECAY]: 0,
      [engine.LFO_WAVEFORM]: pick(0, 1),
      [engine.LFO_AMT]: [60, 220],
      [engine.LFO_FREQ]: [0, 4],
      [engine.LFO_FX_FREQ]: 1,
      [engine.FX_FILTER]: 2,
      [engine.FX_FREQ]: [30, 120],
      [engine.FX_RESONANCE]: [40, 180],
      [engine.FX_DRIVE]: [20, 36],
      [engine.FX_PAN_AMT]: [0, 180],
      [engine.FX_PAN_FREQ]: [0, 6],
      [engine.FX_DELAY_AMT]: [40, 160],
      [engine.FX_DELAY_TIME]: pick(3, 4, 6, 8),
    },
  },
  {
    name: 'Bell',
    hint: 'Bright, ringing and slow to die. Chimes, pickups with weight, menu confirms.',
    figure: { count: [2, 3], shape: pick('rise', 'fall', 'arch'),
      intervals: pick(INTERVALS.fifths, INTERVALS.octaves, INTERVALS.triad), stepMs: [90, 180] },
    rules: {
      // Sine and triangle only: a bell is a few clean partials, and a sawtooth
      // here is a buzzer.
      [engine.OSC1_WAVEFORM]: pick(0, 3),
      [engine.OSC1_VOL]: [150, 250],
      [engine.OSC1_SEMI]: [128, 140],
      [engine.OSC2_WAVEFORM]: pick(0, 3),
      // Tuned above the first, not beside it -- the inharmonic partial is what
      // reads as metal rather than as two of the same note.
      [engine.OSC2_VOL]: [80, 190],
      [engine.OSC2_SEMI]: [140, 152],
      [engine.OSC2_DETUNE]: [0, 40],
      [engine.ENV_ATTACK]: [0, 6],
      [engine.ENV_SUSTAIN]: [6, 20],
      [engine.ENV_RELEASE]: [90, 170],
      [engine.ENV_EXP_DECAY]: [40, 110],
      [engine.FX_FILTER]: 2,
      [engine.FX_FREQ]: [150, 255],
      [engine.FX_RESONANCE]: [0, 90],
      [engine.FX_DRIVE]: [16, 28],
      [engine.FX_DELAY_AMT]: [60, 170],
      [engine.FX_DELAY_TIME]: pick(2, 3, 4),
    },
  },
  {
    name: 'Pluck',
    hint: 'A melodic instrument, not an effect. Play it from the keyboard.',
    figure: { count: [2, 5], shape: pick('rise', 'fall', 'arch', 'wander'),
      intervals: pick(INTERVALS.triad, INTERVALS.minor, INTERVALS.fourths, INTERVALS.seconds), stepMs: [70, 150] },
    rules: {
      // The four recipes below this one are instruments rather than effects,
      // and they share one rule the effects break freely: SEMI stays at 128,
      // the note as written. An effect is played at one pitch and only has to
      // sound right there; an instrument is played up and down a keyboard, and
      // an oscillator detuned by seven semitones turns every melody into a
      // different one.
      [engine.OSC1_WAVEFORM]: pick(1, 2, 3),
      [engine.OSC1_VOL]: [150, 240],
      [engine.OSC1_SEMI]: 128,
      [engine.OSC2_WAVEFORM]: pick(1, 3),
      [engine.OSC2_VOL]: [40, 140],
      [engine.OSC2_SEMI]: pick(128, 140),
      [engine.OSC2_DETUNE]: [0, 30],
      [engine.ENV_ATTACK]: [0, 4],
      [engine.ENV_SUSTAIN]: [6, 22],
      [engine.ENV_RELEASE]: [45, 95],
      [engine.ENV_EXP_DECAY]: [20, 80],
      [engine.FX_FILTER]: 2,
      [engine.FX_FREQ]: [110, 240],
      [engine.FX_RESONANCE]: [20, 140],
      [engine.FX_DRIVE]: [20, 38],
      [engine.FX_DELAY_AMT]: [0, 90],
      [engine.FX_DELAY_TIME]: pick(2, 3, 4),
    },
  },
  {
    name: 'Pad',
    hint: 'A slow instrument that swells and holds. Chords, backgrounds, calm.',
    figure: { count: [1, 3], shape: pick('repeat', 'rise'), intervals: INTERVALS.fifths, stepMs: [140, 250] },
    rules: {
      [engine.OSC1_WAVEFORM]: pick(0, 2, 3),
      [engine.OSC1_VOL]: [110, 200],
      [engine.OSC1_SEMI]: 128,
      [engine.OSC2_WAVEFORM]: pick(0, 2, 3),
      [engine.OSC2_VOL]: [90, 180],
      // A fifth or an octave up, never anything between: this one is meant to
      // be played in chords, and a stray interval fights whatever it is under.
      [engine.OSC2_SEMI]: pick(128, 135, 140),
      [engine.OSC2_DETUNE]: [10, 90],
      [engine.ENV_ATTACK]: [35, 80],
      [engine.ENV_SUSTAIN]: [30, 80],
      [engine.ENV_RELEASE]: [70, 150],
      [engine.ENV_EXP_DECAY]: 0,
      [engine.LFO_WAVEFORM]: 0,
      [engine.LFO_AMT]: [30, 150],
      [engine.LFO_FREQ]: [0, 4],
      [engine.LFO_FX_FREQ]: 1,
      [engine.FX_FILTER]: 2,
      [engine.FX_FREQ]: [60, 180],
      [engine.FX_RESONANCE]: [20, 140],
      [engine.FX_DRIVE]: [17, 30],
      [engine.FX_PAN_AMT]: [0, 140],
      [engine.FX_PAN_FREQ]: [0, 5],
      [engine.FX_DELAY_AMT]: [40, 140],
      [engine.FX_DELAY_TIME]: pick(3, 4, 6),
    },
  },
  {
    name: 'Bass',
    hint: 'A low instrument with a filtered punch. Basslines, stabs, footsteps.',
    figure: { count: [2, 5], shape: pick('rise', 'fall', 'wander', 'repeat'),
      intervals: pick(INTERVALS.fifths, INTERVALS.fourths, INTERVALS.octaves, INTERVALS.seconds), stepMs: [80, 160] },
    rules: {
      [engine.OSC1_WAVEFORM]: pick(2, 3),
      [engine.OSC1_VOL]: [170, 255],
      // A fixed transposition rather than a rolled one, for the reason in
      // Pluck above: one or two octaves down still tracks the written note.
      [engine.OSC1_SEMI]: pick(104, 116),
      [engine.OSC2_WAVEFORM]: pick(0, 2),
      [engine.OSC2_VOL]: [40, 140],
      [engine.OSC2_SEMI]: pick(104, 116),
      [engine.OSC2_DETUNE]: [0, 30],
      [engine.ENV_ATTACK]: [0, 6],
      [engine.ENV_SUSTAIN]: [10, 30],
      [engine.ENV_RELEASE]: [40, 90],
      [engine.ENV_EXP_DECAY]: [20, 90],
      [engine.FX_FILTER]: 2,
      [engine.FX_FREQ]: [35, 95],
      [engine.FX_RESONANCE]: [40, 180],
      [engine.FX_DIST]: [0, 10],
      [engine.FX_DRIVE]: [24, 42],
    },
  },
  {
    name: 'Chaos',
    hint: 'Everything at once, inside the bounds that keep it audible. Press until something surprises you.',
    figure: { count: [1, 5], shape: pick(...SHAPES),
      intervals: pick(...Object.values(INTERVALS)), stepMs: [40, 200] },
    rules: {
      // The recipe that is barely a recipe. Every one of the 29 parameters is
      // rolled, and the only thing the ranges do is rule out the four ways a
      // uniform roll produces nothing worth hearing -- which is the whole
      // argument at the top of this file, applied as loosely as it can be.
      //
      //   1. Silence. FX_DRIVE stays well clear of 0, and OSC1_VOL is never
      //      low enough for the other two sources to be all there is.
      //   2. A filter that removes the sound. FX_FILTER is low-pass or
      //      band-pass, never high-pass: a high-pass at these cutoffs takes the
      //      note away and leaves the hiss. FX_FREQ keeps its floor above the
      //      band a C5 actually lives in.
      //   3. FX_DIST as an attenuator -- see the trap above. It stays in the
      //      band the shipped presets use.
      //   4. An envelope of no length, and one that never ends. Both bounded.
      [engine.OSC1_WAVEFORM]: pick(0, 1, 2, 3),
      [engine.OSC1_VOL]: [130, 230],
      [engine.OSC1_SEMI]: [104, 152],
      [engine.OSC1_XENV]: [0, 255],
      [engine.OSC2_WAVEFORM]: pick(0, 1, 2, 3),
      [engine.OSC2_VOL]: [0, 150],
      [engine.OSC2_SEMI]: [104, 152],
      [engine.OSC2_DETUNE]: [0, 255],
      [engine.OSC2_XENV]: [0, 255],
      [engine.NOISE_VOL]: [0, 135],
      [engine.ENV_ATTACK]: [0, 60],
      [engine.ENV_SUSTAIN]: [4, 60],
      [engine.ENV_RELEASE]: [30, 140],
      [engine.ENV_EXP_DECAY]: [0, 110],
      [engine.ARP_CHORD]: pick(0, 0, 0x47, 0x74, 0x35, 0x53, 0x4C, 0x7C, 0x57, 0x3B, 0x15),
      [engine.ARP_SPEED]: [0, 7],
      [engine.LFO_WAVEFORM]: pick(0, 1, 2, 3),
      [engine.LFO_AMT]: [0, 255],
      [engine.LFO_FREQ]: [0, 16],
      [engine.LFO_FX_FREQ]: pick(0, 1),
      [engine.FX_FILTER]: pick(2, 2, 3),
      // Neither of these reaches its own limit, and that is the fifth way a
      // roll produces nothing: the state-variable filter goes unstable with a
      // high Q at a cutoff near Nyquist, and the roll comes out silent rather
      // than merely bright. It is about one roll in a thousand, and pulling
      // both ceilings in a little costs nothing audible.
      [engine.FX_FREQ]: [80, 240],
      [engine.FX_RESONANCE]: [0, 200],
      [engine.FX_DIST]: [0, 14],
      [engine.FX_DRIVE]: [14, 30],
      [engine.FX_PAN_AMT]: [0, 255],
      [engine.FX_PAN_FREQ]: [0, 16],
      [engine.FX_DELAY_AMT]: [0, 180],
      [engine.FX_DELAY_TIME]: [0, 6],
    },
  },
];

// --- the parameters, named ---
//
// Every parameter, labelled as the instrument panel labels it and named as
// engine.js spells it. This is what makes the diagnostic in the header comment
// possible: roll a recipe a thousand times, split the rolls by whatever went
// wrong, and print the mean of each parameter for each side. Without labels
// that is a table of 29 numbers nobody can read, and it is how both the
// FX_DIST trap and the filter-instability silence were found.
export const PROPS = [
  [engine.OSC1_WAVEFORM, 'Osc1 wave', 'OSC1_WAVEFORM'],
  [engine.OSC1_VOL, 'Osc1 vol', 'OSC1_VOL'],
  [engine.OSC1_SEMI, 'Osc1 semi', 'OSC1_SEMI'],
  [engine.OSC1_XENV, 'Osc1 x-env', 'OSC1_XENV'],
  [engine.OSC2_WAVEFORM, 'Osc2 wave', 'OSC2_WAVEFORM'],
  [engine.OSC2_VOL, 'Osc2 vol', 'OSC2_VOL'],
  [engine.OSC2_SEMI, 'Osc2 semi', 'OSC2_SEMI'],
  [engine.OSC2_DETUNE, 'Osc2 det', 'OSC2_DETUNE'],
  [engine.OSC2_XENV, 'Osc2 x-env', 'OSC2_XENV'],
  [engine.NOISE_VOL, 'Noise vol', 'NOISE_VOL'],
  [engine.ENV_ATTACK, 'Env att', 'ENV_ATTACK'],
  [engine.ENV_SUSTAIN, 'Env sust', 'ENV_SUSTAIN'],
  [engine.ENV_RELEASE, 'Env rel', 'ENV_RELEASE'],
  [engine.ENV_EXP_DECAY, 'Env exp', 'ENV_EXP_DECAY'],
  [engine.ARP_CHORD, 'Arp notes', 'ARP_CHORD'],
  [engine.ARP_SPEED, 'Arp speed', 'ARP_SPEED'],
  [engine.LFO_WAVEFORM, 'LFO wave', 'LFO_WAVEFORM'],
  [engine.LFO_AMT, 'LFO amt', 'LFO_AMT'],
  [engine.LFO_FREQ, 'LFO freq', 'LFO_FREQ'],
  [engine.LFO_FX_FREQ, 'LFO → filter', 'LFO_FX_FREQ'],
  [engine.FX_FILTER, 'Filter type', 'FX_FILTER'],
  [engine.FX_FREQ, 'Filter freq', 'FX_FREQ'],
  [engine.FX_RESONANCE, 'Filter res', 'FX_RESONANCE'],
  [engine.FX_DIST, 'Dist', 'FX_DIST'],
  [engine.FX_DRIVE, 'Drive', 'FX_DRIVE'],
  [engine.FX_PAN_AMT, 'Pan amt', 'FX_PAN_AMT'],
  [engine.FX_PAN_FREQ, 'Pan freq', 'FX_PAN_FREQ'],
  [engine.FX_DELAY_AMT, 'Delay amt', 'FX_DELAY_AMT'],
  [engine.FX_DELAY_TIME, 'Delay time', 'FX_DELAY_TIME'],
];

// The rule a recipe gives a property, or NEUTRAL's if it says nothing.
function ruleFor(recipe, prop) {
  const r = recipe.rules[prop];
  return r === undefined ? NEUTRAL[prop] : r;
}

const isRange = rule => Array.isArray(rule);
const isPick = rule => !!rule && !isRange(rule) && Array.isArray(rule.oneOf);

function rollValue(rule, rnd) {
  if (isRange(rule)) return rule[0] + Math.floor(rnd() * (rule[1] - rule[0] + 1));
  if (isPick(rule)) return rule.oneOf[Math.floor(rnd() * rule.oneOf.length)];
  return rule;
}

// A fresh instrument for `recipe`, over `base`. Every property of every
// unlocked group is rolled; a locked group keeps whatever `base` had, byte for
// byte, which is what makes "keep the envelope, reroll the filter" a single
// press rather than a note on paper.
//
// `rnd` is injected rather than reaching for Math.random directly so the tests
// can assert on exact output instead of only on ranges.
export function rollInstrument(recipe, base, locked = new Set(), rnd = Math.random) {
  const out = base.slice();
  for (const [label, props] of GROUPS) {
    if (locked.has(label)) continue;
    for (const prop of props) out[prop] = rollValue(ruleFor(recipe, prop), rnd);
  }
  return out;
}

// A small nudge instead of a fresh roll: the sound stays recognisably the one
// you have, with every value moved by up to `amount` of its own range.
//
// Only ranges move. A pick has no "nearby" value -- a square wave is not a
// slightly-detuned sawtooth, and a filter type is not a dial -- so mutating one
// would be a reroll wearing a nudge's name, and the sound would jump about
// exactly when you asked it not to.
export function mutateInstrument(recipe, base, locked = new Set(), amount = 0.15, rnd = Math.random) {
  const out = base.slice();
  for (const [label, props] of GROUPS) {
    if (locked.has(label)) continue;
    for (const prop of props) {
      const rule = ruleFor(recipe, prop);
      if (!isRange(rule)) continue;
      const [lo, hi] = rule;
      const step = Math.round((hi - lo) * amount * (rnd() * 2 - 1));
      // Clamped back into the recipe's own range, never merely into 0-255: a
      // mutation that could leave the range would, given enough presses, walk
      // the sound out of its archetype one nudge at a time.
      out[prop] = Math.max(lo, Math.min(hi, (out[prop] | 0) + step));
    }
  }
  return out;
}

// How long a note on this instrument actually sounds, in samples: the envelope
// (player-small.js's createNote sizes its buffer at exactly this) plus however
// long the delay goes on repeating it afterwards.
//
// The delay term is what the export needs and the ear does not. Delay taps read
// out of the channel buffer, which is only as long as the pattern, so a pattern
// cut to the envelope alone truncates the repeats -- the exported file would be
// audibly shorter than what the tool played. `dly` is FX_DELAY_TIME whole rows
// (player-small.js: `instr.i[28] * rowLen`), and each repeat is FX_DELAY_AMT/255
// of the one before, so the tail is however many repeats it takes to fall below
// hearing. Capped, because an amount near 255 decays so slowly that the honest
// answer is longer than any pattern can be.
const DELAY_FLOOR = 0.02, MAX_REPEATS = 8;
export function soundLengthSamples(instrument, rowLen) {
  const i = instrument;
  const env = (i[engine.ENV_ATTACK] ** 2 + i[engine.ENV_SUSTAIN] ** 2 + i[engine.ENV_RELEASE] ** 2) * 4;
  const amt = i[engine.FX_DELAY_AMT] / 255, time = i[engine.FX_DELAY_TIME];
  if (!(amt > 0) || !time) return env;
  const repeats = amt >= 1 ? MAX_REPEATS
    : Math.min(MAX_REPEATS, Math.ceil(Math.log(DELAY_FLOOR) / Math.log(amt)));
  return env + repeats * time * rowLen;
}

// --- the sound as a song ---
//
// A sound effect is not always one note. Half the hand-built ones in this
// repo's demo songs are a short figure -- two notes for a pickup, three
// falling ones for a death, a pair a fifth apart for an alarm -- and an
// arpeggio cannot make those: it repeats one fixed interval pattern at one
// fixed speed for as long as the note sounds. So a sound is a *step lane*
// here: an array of note numbers, one per row, 0 for a row with no note.
// STEPS is how many rows the lane offers; a one-note sound is simply a lane
// with a note in row 0 and nothing after it, so nothing about the simple case
// gets harder.
export const STEPS = 16;

// The lane's own row length, in samples, decoupled from the song's tempo.
// A sound effect ships in a game that has no tempo, and the gap between the
// two notes of a pickup is part of the sound, not part of the arrangement --
// tying it to whatever BPM the tune happened to be at would change the effect
// every time the song's tempo changed. 20 ms is about as tight as two separate
// notes read as two notes rather than as one chord; 250 ms is a slow
// deliberate figure.
export const MIN_STEP_MS = 20, MAX_STEP_MS = 250, DEFAULT_STEP_MS = 60;
export const SAMPLE_RATE = 44100;   // engine.js's calcSamplesPerRow assumes it too
export const msToRowLen = ms => Math.max(1, Math.round(ms * SAMPLE_RATE / 1000));
export const rowLenToMs = rowLen => Math.round(rowLen * 1000 / SAMPLE_RATE);

// patternLen is one byte in the binary song format (engine.js's CBinWriter
// putUBYTE), which the share link and the legacy .snd export both go through.
export const MAX_PATTERN_ROWS = 255;

// How many rows the whole effect occupies: the last note's row, plus however
// long a note started there goes on sounding. The tail term is what the export
// needs and the ear does not -- see soundLengthSamples above for why the delay
// half of it matters.
export function songRowsFor(instrument, steps, rowLen) {
  let last = 0;
  for (let r = 0; r < steps.length; r++) if (steps[r]) last = r;
  const tail = Math.ceil(soundLengthSamples(instrument, rowLen) / rowLen);
  return Math.max(1, Math.min(MAX_PATTERN_ROWS, last + tail));
}

// --- packs: many sounds in one file ---
//
// Each shelved sound as `[rowLen, patternLen, instrument, notes]`, which is
// the format src/js/core/sfxpack.js expands back into a song. Read that file
// for what each field is and why the names come out as const bindings rather
// than as object keys -- the short version is that a string key stored at
// build time and read back as a static property is the one thing the game's
// minifier reliably breaks.
//
// Notes are trimmed to the last one that sounds. The rows after it are the
// tail, and the player reads a missing array entry as "no note here", so
// spelling those zeroes out would be bytes spent to say nothing.

// A JS identifier from a sound's name, for the index constant. Uppercased
// because that is what a constant looks like, and de-duplicated by the caller
// -- two shelved sounds called "zap" would otherwise emit the same binding
// twice and the file would not parse.
function constName(name, taken) {
  let base = String(name).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!base || /^[0-9]/.test(base)) base = 'SFX_' + base;
  let out = base, n = 2;
  while (taken.has(out)) out = base + '_' + n++;
  taken.add(out);
  return out;
}

// `entries` is [{ name, i, steps, stepMs }, ...] -- what the SFX view's shelf
// holds.
export function packToJS(entries) {
  const taken = new Set();
  const names = entries.map(e => constName(e.name, taken));
  const rows = entries.map((e, ix) => {
    const rowLen = msToRowLen(e.stepMs);
    const patternLen = songRowsFor(e.i, e.steps, rowLen);
    let last = 0;
    for (let r = 0; r < e.steps.length; r++) if (e.steps[r]) last = r;
    const notes = e.steps.slice(0, last + 1).map(n => n | 0);
    return `  /* ${names[ix]} */ [${rowLen}, ${patternLen}, [${e.i.join(',')}], [${notes.join(',')}]],`;
  });
  return `// A sound-effect pack exported by Voxby.
//
//   import pack, { ${names.slice(0, 2).join(', ') || 'NAME'} } from './sounds/thispack.js';
//   import { expandPack } from './core/sfxpack.js';
//   import { initAudio, playSound } from './core/utils.js';
//
//   const sfx = initAudio(expandPack(pack));
//   playSound(sfx[${names[0] || 'NAME'}]);
//
// Each entry is [rowLen, patternLen, instrument, notes]; core/sfxpack.js
// expands one back into a song the player can render.

${names.map((n, ix) => `export const ${n} = ${ix};`).join('\n')}

export default [
${rows.join('\n')}
];
`;
}

export function buildSfxSong(instrument, steps, rowLen) {
  const song = engine.makeNewSong();
  song.rowLen = rowLen;
  song.patternLen = songRowsFor(instrument, steps, rowLen);
  song.numChannels = 1;
  song.endPattern = 0;
  const ch = engine.makeEmptyChannel(song.patternLen);
  ch.i = instrument.slice();
  ch.p[0] = 1;
  for (let r = 0; r < steps.length && r < song.patternLen; r++) {
    if (steps[r]) ch.c[0].n[r] = steps[r];
  }
  song.songData = [ch];
  return song;
}
