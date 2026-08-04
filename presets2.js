// SoundBox's instrument presets, converted to v2 voices and channel strips.
//
// presets.js itself is upstream data and is left alone. This reads the
// `gInstrumentPresets` global it defines and returns the same list in the two
// arrays v2 uses, so the instrument panel can offer them unchanged.
//
// THE ENVELOPE IS THE WHOLE PROBLEM
// ---------------------------------
// A v1 instrument states a note's length: attack, then a fixed hold, then a
// release, and the note is over. A v2 voice states a *shape* and is ended by
// something else -- a note-off, a gate, or its own sustain level being zero.
// There is no arithmetic that turns one into the other, because the question
// "does this sound stop by itself?" is not asked in v1 at all.
//
// So it is answered from the preset list's own sections. Upstream groups them
// LEADS / PADS / DRUMS / F/X, and that grouping is exactly the distinction
// needed: a drum stops by itself, a pad is held. That is better evidence than
// any threshold picked out of the parameters, because it is what the person
// who wrote the presets meant.
//
// Within the held sections one more test applies: a preset whose v1 hold is
// very short was written as a blip regardless of which section it sits in
// (SoundBox's "Softy" holds for 144 samples and gets its whole body from a
// 13,456-sample release). Those convert as percussive too.
//
// WHAT THIS IS NOT
// ----------------
// It is not a pass by ear. Nobody has listened to the converted set and
// adjusted it. The classification is defensible and the arithmetic is exact,
// but a preset that sounded wrong would still be here -- see
// tests/soundbox/test-presets2.mjs, which checks every one of them makes sound
// and does not clip, and cannot check whether it sounds *right*.

import * as engine from './engine2.js';

// A v1 envelope time is stored as an index: the real length is index² * 4
// samples. Going the other way rounds, so a converted length is within half an
// index of the original.
const timeIndex = samples => Math.min(255, Math.round(Math.sqrt(Math.max(0, samples) / 4)));

// A v1 hold shorter than this was written as a blip, whatever section it is
// filed under. About 0.09 seconds at 44.1 kHz.
const BLIP_SAMPLES = 4000;

// Section headers in the upstream list are entries with a name and no `i`.
const SECTION_RE = /^=+\[(.+?)\]=+$/;

// One v1 preset's 28 (or 29) numbers, as a v2 voice and strip.
export const convertPreset = function (i, section) {
  const holdSamples = i[11] * i[11] * 4;
  const releaseSamples = i[12] * i[12] * 4;
  const percussive = section === 'DRUMS' || holdSamples < BLIP_SAMPLES;

  const voice = [
    i[0], i[1], i[2], i[3],
    i[4], i[5], i[6], i[7], i[8],
    i[9],
    i[10],                                  // attack, unchanged
    // A percussive voice decays to nothing over what used to be its hold plus
    // its release, so it ends on its own exactly as it did. A held voice has
    // no decay: it reaches full level and stays there until it is released.
    percussive ? timeIndex(holdSamples + releaseSamples) : 0,
    percussive ? 0 : 255,                   // sustain level
    i[12],                                  // release, unchanged
    i[13] || 0,                             // exponential bend
    i[14] || 0, i[15] || 0,                 // arpeggio
  ];
  // Indices 16..28 are the channel strip, in the same order v2 keeps them.
  const fx = [];
  for (let k = 0; k < engine.NUM_FX_PARAMS; k++) fx.push(i[16 + k] || 0);
  return { voice, fx, percussive };
};

// The whole list, section headers included so the panel can still group them.
// A header entry has `name` and no `voice`.
export const v2Presets = function (raw) {
  const list = raw || (typeof window !== 'undefined' ? window.gInstrumentPresets : null) || [];
  const out = [];
  let section = '';
  for (const p of list) {
    const header = SECTION_RE.exec(p.name || '');
    if (header) { section = header[1]; out.push({ name: p.name, section }); continue; }
    if (!p.i) { out.push({ name: p.name, section }); continue; }
    out.push({ name: p.name, section, ...convertPreset(p.i, section) });
  }
  return out;
};
