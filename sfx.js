// Sound-effect recipes: what rhythms.js is to rhythm, this is to one-shot SFX.
//
// Data and arithmetic only -- no DOM, no state, and nothing imported but
// engine.js's property-index constants. Same rule as chords.js, scales.js and
// rhythms.js, and for the same reason: main.js's SFX dialog draws itself from
// this, and keeping the sound design out of the dialog is what makes it
// reviewable as sound design.
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
// How the ranges below were arrived at, and how to check a change to them:
// render 40 rolls of each recipe through CPlayer, take the peak sample of
// each, and count how many land in a usable band (audible, not pinned to full
// scale). Every recipe here sits at 100%, medians clustered around 0.3-0.4 of
// full scale. Anything that drops a recipe under about 90% is a range that
// wants narrowing, and correlating peak level against each rolled parameter
// says which one -- that is how the FX_DIST trap below was found, after
// reading its name suggested the opposite of what it does. None of this is in
// the test suite: a level threshold would be flaky, and "sounds good" is not
// measurable at all. It is a listening job with a meter to hand.

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
      [engine.ENV_SUSTAIN]: [0, 12],
      [engine.ENV_RELEASE]: [20, 60],
      [engine.ENV_EXP_DECAY]: [0, 90],
      [engine.FX_FREQ]: [110, 255],
      [engine.FX_RESONANCE]: [0, 180],
      [engine.FX_DRIVE]: [28, 60],
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
      [engine.ENV_SUSTAIN]: [0, 14],
      [engine.ENV_RELEASE]: [22, 65],
      [engine.ENV_EXP_DECAY]: [0, 80],
      [engine.LFO_WAVEFORM]: pick(0, 1, 2),
      [engine.LFO_AMT]: [60, 220],
      [engine.LFO_FREQ]: [4, 12],
      [engine.LFO_FX_FREQ]: 1,
      [engine.FX_FREQ]: [40, 170],
      [engine.FX_RESONANCE]: [110, 240],
      [engine.FX_DRIVE]: [36, 66],
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
      [engine.ENV_ATTACK]: [0, 6],
      [engine.ENV_SUSTAIN]: [10, 40],
      [engine.ENV_RELEASE]: [80, 170],
      [engine.ENV_EXP_DECAY]: [50, 180],
      [engine.FX_FREQ]: [45, 95],
      [engine.FX_RESONANCE]: [0, 120],
      [engine.FX_DIST]: [0, 10],
      [engine.FX_DRIVE]: [34, 54],
      [engine.FX_DELAY_AMT]: [0, 60],
      [engine.FX_DELAY_TIME]: pick(1, 2, 3),
    },
  },
  {
    name: 'Pickup',
    hint: 'Two bright tones in quick succession. Coins, collectibles, ticks.',
    rules: {
      [engine.OSC1_WAVEFORM]: pick(1, 3),
      [engine.OSC1_VOL]: [150, 255],
      [engine.OSC1_SEMI]: [138, 152],
      [engine.OSC2_WAVEFORM]: pick(1, 3),
      [engine.OSC2_VOL]: [0, 120],
      [engine.OSC2_SEMI]: [138, 152],
      [engine.OSC2_DETUNE]: [0, 24],
      [engine.ENV_SUSTAIN]: [2, 10],
      [engine.ENV_RELEASE]: [15, 45],
      [engine.ENV_EXP_DECAY]: [0, 60],
      [engine.ARP_CHORD]: ARP_MAJOR,
      [engine.ARP_SPEED]: [5, 7],
      [engine.FX_FREQ]: [180, 255],
      [engine.FX_RESONANCE]: [0, 80],
      [engine.FX_DRIVE]: [28, 52],
      [engine.FX_DELAY_AMT]: [0, 90],
      [engine.FX_DELAY_TIME]: pick(1, 2),
    },
  },
  {
    name: 'Powerup',
    hint: 'A climbing arpeggio with a tail. Level-ups, unlocks, fanfares.',
    rules: {
      [engine.OSC1_WAVEFORM]: pick(1, 2, 3),
      [engine.OSC1_VOL]: [140, 230],
      [engine.OSC1_SEMI]: [116, 130],
      [engine.OSC2_WAVEFORM]: pick(1, 3),
      [engine.OSC2_VOL]: [60, 160],
      [engine.OSC2_SEMI]: [128, 142],
      [engine.OSC2_DETUNE]: [0, 48],
      [engine.ENV_ATTACK]: [0, 10],
      [engine.ENV_SUSTAIN]: [10, 30],
      [engine.ENV_RELEASE]: [40, 90],
      [engine.ENV_EXP_DECAY]: [0, 40],
      [engine.ARP_CHORD]: ARP_MAJOR,
      [engine.ARP_SPEED]: [4, 6],
      [engine.FX_FREQ]: [140, 255],
      [engine.FX_RESONANCE]: [0, 120],
      [engine.FX_DRIVE]: [28, 56],
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
      [engine.ENV_ATTACK]: [10, 26],
      [engine.ENV_SUSTAIN]: [0, 6],
      [engine.ENV_RELEASE]: [10, 30],
      [engine.ENV_EXP_DECAY]: [0, 60],
      [engine.FX_FREQ]: [150, 255],
      [engine.FX_RESONANCE]: [0, 90],
      [engine.FX_DRIVE]: [30, 55],
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
      [engine.ENV_SUSTAIN]: [2, 14],
      [engine.ENV_RELEASE]: [20, 55],
      [engine.ENV_EXP_DECAY]: [30, 140],
      // Low-pass listed twice: a pick is even, so a repeat is how a recipe
      // weights one. Band-pass keeps only a narrow band and is the more
      // characterful of the two, so it comes up on one roll in three.
      [engine.FX_FILTER]: pick(2, 2, 3),
      [engine.FX_FREQ]: [90, 175],
      [engine.FX_RESONANCE]: [40, 200],
      [engine.FX_DIST]: [0, 14],
      [engine.FX_DRIVE]: [34, 58],
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
      [engine.ENV_SUSTAIN]: [4, 16],
      [engine.ENV_RELEASE]: [30, 80],
      [engine.ENV_EXP_DECAY]: [60, 200],
      [engine.FX_FREQ]: [30, 62],
      [engine.FX_RESONANCE]: [0, 100],
      [engine.FX_DIST]: [0, 8],
      [engine.FX_DRIVE]: [30, 48],
    },
  },
  {
    name: 'Blip',
    hint: 'The shortest useful sound. Menu moves, typing, cursor steps.',
    rules: {
      [engine.OSC1_WAVEFORM]: pick(1, 3),
      [engine.OSC1_VOL]: [150, 255],
      [engine.OSC1_SEMI]: [128, 152],
      [engine.ENV_SUSTAIN]: [1, 6],
      [engine.ENV_RELEASE]: [8, 24],
      [engine.ENV_EXP_DECAY]: [0, 80],
      [engine.FX_FREQ]: [180, 255],
      [engine.FX_RESONANCE]: [0, 60],
      [engine.FX_DRIVE]: [30, 50],
    },
  },
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
