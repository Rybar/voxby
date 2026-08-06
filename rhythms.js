// Drum kits and grooves: what chords.js is to harmony, this is to rhythm.
//
// Pure data and lookups -- no DOM, no state, and no imports at all. Same rule
// as chords.js and scales.js, and for the same reason: panels/drums.js draws
// the step grid from this, and keeping the knowledge out of the panel is what
// makes it reviewable as music rather than as UI.
//
// A kit is a list of *lanes*. A lane is one drum voice, and in this song
// format one voice means one channel, because a channel has exactly one
// instrument. So a four-lane kit spends four of the sixteen channels. That is
// the format's limit, not a design choice -- plans/voxby-synth-v2.md is where
// it gets lifted, and when it does a lane becomes an instrument inside one
// channel with nothing here or in the panel needing to change.
//
// `preset` names a real entry in presets.js's DRUMS section, so a kit adds no
// synthesis of its own: it is a curated selection of sounds that already ship.
// `note` is the pitch the lane writes. Drums are pitched like everything else
// here -- 135 is C-4, 147 is C-5, the two values SoundBox's own songs use for
// kick and snare -- and since a lane's hit is an ordinary pattern note, it can
// still be retuned by hand in the tracker grid afterwards. The step grid reads
// *any* non-zero note as a hit, so retuning one never makes it disappear.

// The four voices every groove below is written for. A kit must fill all four:
// a groove that names a lane the kit hasn't got would silently lose part of
// its rhythm, and there is no useful way to substitute one drum for another.
export const ROLES = [
  ['K', 'Kick'],
  ['S', 'Snare'],
  ['H', 'Hat'],
  ['O', 'Open hat'],
];

export const KITS = [
  {
    name: 'Basic',
    lanes: [
      { role: 'K', preset: 'Bass drum 2', note: 135 },
      { role: 'S', preset: 'Snare 2', note: 147 },
      { role: 'H', preset: 'Hihat 1', note: 147 },
      { role: 'O', preset: 'Open hihat', note: 147 },
    ],
  },
  {
    name: 'Punchy',
    lanes: [
      { role: 'K', preset: 'Bass drum 4 (dirty)', note: 135 },
      { role: 'S', preset: 'Snare 3', note: 147 },
      { role: 'H', preset: 'Hihat 2', note: 147 },
      { role: 'O', preset: 'Open hihat', note: 147 },
    ],
  },
  {
    name: 'Soft',
    lanes: [
      { role: 'K', preset: 'Bass drum 1', note: 135 },
      { role: 'S', preset: 'Snare 1', note: 147 },
      { role: 'H', preset: 'Hihat 1', note: 147 },
      { role: 'O', preset: 'Open hihat', note: 147 },
    ],
  },
];

// A groove is one bar, written as one character per sixteenth note: `x` is a
// hit, anything else is silence. `steps` is how many sixteenths that bar has --
// 16 for 4/4, 12 for 3/4 and for the triplet feels, which is the whole reason
// the length is a field rather than a constant.
//
// They are written out rather than generated because a groove is a quotation,
// not a formula: what makes a shuffle sound like a shuffle is where it refuses
// to put the hits. Ordered easiest-to-hear first, since the list is read top to
// bottom by someone who does not yet know which one they want.
export const GROOVES = [
  {
    name: 'Rock', steps: 16,
    // Kick on 1 and 3, snare on 2 and 4, eighth-note hats. The backbeat almost
    // every other groove here is a departure from.
    hits: { K: 'x.......x.......', S: '....x.......x...', H: 'x.x.x.x.x.x.x.x.', O: '................' },
  },
  {
    name: 'Rock (driving)', steps: 16,
    // The same backbeat with sixteenth hats and a pushed kick before beat 3 --
    // the push is what makes it lean forward.
    hits: { K: 'x.....x.x.......', S: '....x.......x...', H: 'xxxxxxxxxxxxxxxx', O: '................' },
  },
  {
    name: 'Four on the floor', steps: 16,
    // House: kick on every beat, snare on the backbeat, and the open hat on the
    // offbeat eighths -- the offbeat hat is the genre, not the kick.
    hits: { K: 'x...x...x...x...', S: '....x.......x...', H: '................', O: '..x...x...x...x.' },
  },
  {
    name: 'Disco', steps: 16,
    // Four on the floor again, but with closed hats filling the eighths so the
    // open hat reads as an accent instead of the pulse.
    hits: { K: 'x...x...x...x...', S: '....x.......x...', H: 'x.x.x.x.x.x.x.x.', O: '..x...x...x...x.' },
  },
  {
    name: 'Boom bap', steps: 16,
    // Hip-hop: the kick answers itself just before beat 3 and again on the "and"
    // of 4, which is what leaves the space the snare lands in.
    hits: { K: 'x.....x...x.....', S: '....x.......x...', H: 'x.x.x.x.x.x.x.x.', O: '................' },
  },
  {
    name: 'Funk', steps: 16,
    // Sixteenth hats throughout and a kick that syncopates against them. Every
    // kick but the first is off the beat.
    hits: { K: 'x..x..x...x..x..', S: '....x.......x...', H: 'xxxxxxxxxxxxxxxx', O: '................' },
  },
  {
    name: 'Breakbeat', steps: 16,
    // The chopped-loop feel: the snare moves off the backbeat and the kick
    // fills what it left. Ghost snares are what the extra S hits are.
    hits: { K: 'x.x.......x.....', S: '....x..x....x...', H: 'x.xxx.x.x.xxx.x.', O: '................' },
  },
  {
    name: 'Half time', steps: 16,
    // One snare a bar instead of two. The same tempo reads as half as fast,
    // which is the cheapest way to make a section feel heavier.
    hits: { K: 'x.........x.....', S: '........x.......', H: 'x.x.x.x.x.x.x.x.', O: '................' },
  },
  {
    name: 'Drum and bass', steps: 16,
    // Two-step: kick on 1 and the "and" of 3, snare only on 3, hats riding
    // sixteenths underneath.
    hits: { K: 'x.........x.....', S: '........x.......', H: 'xxxxxxxxxxxxxxxx', O: '..............x.' },
  },
  {
    name: 'Shuffle', steps: 12,
    // A triplet bar: twelve steps, hats on the first of each triplet. The swing
    // is in the grid itself, not in a timing offset.
    hits: { K: 'x.....x.....', S: '...x.....x..', H: 'x..x..x..x..', O: '............' },
  },
  {
    name: 'Waltz', steps: 12,
    // 3/4: kick on 1, snare on 2 and 3, hats on the eighths. Set Beat to 4 and
    // Rows to a multiple of 12 for this to line up with the sequencer's
    // highlight.
    hits: { K: 'x...........', S: '....x...x...', H: 'x.x.x.x.x.x.', O: '............' },
  },
  {
    name: 'Fill', steps: 16,
    // Not a groove: a bar to stamp over the last bar of a section. Snare
    // sixteenths building to the downbeat the next bar starts on.
    hits: { K: 'x...............', S: '....x.x.xx.xxxxx', H: '................', O: '..............x.' },
  },
];

// --- fitting a groove to the song's grid ---
//
// A step is a sixteenth note. `beatRows` is the song's rows-per-beat (the
// sequencer's Beat control), so a beat is beatRows rows and a sixteenth is a
// quarter of that. At the default Beat of 4 this is one row per step and
// nothing is lost; at Beat 8 every groove doubles in resolution for free.
//
// Below Beat 4 two sixteenths can round onto the same row. The later one wins,
// which is the same thing that happens if you type them there by hand -- a row
// holds one hit per lane, and no rounding can invent the row to put the other
// one on.
export function rowOfStep(step, beatRows) {
  return Math.round(step * beatRows / 4);
}

// How many pattern rows one bar of this groove occupies, which is also how far
// apart repeats of it are stamped.
export function barRows(groove, beatRows) {
  return Math.max(1, Math.round(groove.steps * beatRows / 4));
}

// The rows one role's hits land on, for one bar starting at row 0. Roles the
// groove doesn't write get an empty list rather than a missing key, so callers
// need no guard.
export function rowsOf(groove, role, beatRows) {
  const line = groove.hits[role] || '';
  const rows = [];
  for (let step = 0; step < line.length; step++) {
    if (line[step] === 'x') rows.push(rowOfStep(step, beatRows));
  }
  return rows;
}

// The lanes of a kit, resolved against presets.js's library. Returns null if a
// preset a kit names has gone missing (renamed in the library, say), so the
// caller can say so instead of quietly building a kit of silent channels.
export function resolveKit(kitIndex, presetList) {
  const kit = KITS[kitIndex];
  if (!kit) return null;
  const out = [];
  for (const lane of kit.lanes) {
    const preset = presetList.find(p => p.name === lane.preset);
    if (!preset || !preset.i) return null;
    out.push({ role: lane.role, label: labelOf(lane.role), note: lane.note, preset: lane.preset, i: preset.i });
  }
  return out;
}

export function labelOf(role) {
  const r = ROLES.find(x => x[0] === role);
  return r ? r[1] : role;
}
