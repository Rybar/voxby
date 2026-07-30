// Note/chord entry pie menu. Opened by panels/tracker.js when a note cell is
// double-clicked: a radial overlay with
// the note in an inner ring and the chord quality in an outer one.
//
// This module is deliberately all geometry, labels and gesture -- it knows
// nothing about the song, the pattern grid or how a chord is spelled. Every
// musical answer comes from the `ctx` its caller passes to openPie(), whose
// implementations in tracker.js are the same chordAt()/voiced()/writeChordRow()
// the keyboard paths use. That's what makes it impossible for the pie to
// enter something typing a note wouldn't, and it's also why the import edge
// runs tracker -> pie and never back.
//
// Rings are hit-tested by angle+radius arithmetic rather than by pointer
// events on the <path>s: the wedges are drawn from the same two numbers the
// hit test reads, so the two can't disagree, and the "crossing out of the
// note ring locks the note" behaviour below falls out of a radius comparison
// instead of needing enter/leave bookkeeping per wedge.

import { state } from '../state.js';
import { SCALES, PITCH_NAMES, CHORD_QUALITIES, harmonyOf, degreeOfPitch } from '../scales.js';

// Ring boundaries, in px from the center. The hub is a cancel target as well as
// the readout; past R_DEAD a release is also a cancel, so a pie opened by
// accident is dismissed by flicking away from it rather than having to find a
// specific spot. Sized off the labels rather than picked round: the hub has to
// hold a chord name ("Cmaj7") plus the octave without spilling into the note
// ring, and the quality ring has to give 12 wedges an arc that fits "m7♭5".
const R_HUB = 25;
// Helper to get radii based on scale mode
const getRing = () => {
  const scaled = !!SCALES[state.scaleMode][1];
  if (scaled) {
    // Scale mode: 2 rings (note, quality)
    return { NOTE: 67, CAT: 0, QUAL: 118, DEAD: 145 };
  } else {
    // Chromatic mode: 3 rings (note, category, quality)
    return { NOTE: 55, CAT: 90, QUAL: 130, DEAD: 157 };
  }
};

// Scale-degree labels for the inner ring, indexed by semitones above the
// scale root. Deliberately uppercase throughout: this says *which degree*,
// while what quality sits on it is the outer ring's whole job.
const ROMAN = ['I', '♭II', 'II', '♭III', 'III', 'IV', '♭V', 'V', '♭VI', 'VI', '♭VII', 'VII'];

// `null` quality = write the bare note; 'auto' = whatever the scale
// harmonizes it to (tracker.js's diatonic stack, the same one chord mode
// writes on a single keypress).
const SINGLE = { quality: null, name: 'note' };
const AUTO = { quality: 'auto', name: 'auto' };

// Chord categories for the middle ring in chromatic mode (5 categories).
// Ordered by commonality within each category.
const CATEGORIES = [
  { name: 'Major', quals: ['Digit1', 'Digit5', 'maj9', 'Digit6', 'maj11', 'maj13'] },
  { name: 'Minor', quals: ['Digit2', 'Digit4', 'min9', 'Digit7', 'min11', 'min13', 'Digit8'] },
  { name: 'Dom', quals: ['Digit3', 'dom9', 'dom11', 'dom13', 'aug7', 'sev_b9', 'sev_sh9', 'sev_sh11'] },
  { name: 'Dim/Aug', quals: ['dim3', 'Digit9', 'aug3'] },
  { name: 'Sus/Add', quals: ['sus2', 'Digit0', 'add9', 'madd9', 'add11'] },
];

let open = null;

// The inner ring: the active scale's degrees, or all 12 pitch classes when
// no scale is set. Restricting it under a scale is the point -- it's the same
// promise the remapped Z-M/Q-P key rows make, and it buys much bigger targets
// (a pentatonic gets 5 wedges of 72 degrees each).
function buildRing1() {
  const intervals = SCALES[state.scaleMode][1];
  if (!intervals) return PITCH_NAMES.map((name, pitch) => ({ pitch, name, sub: '' }));
  return intervals.map(iv => ({
    pitch: (iv + state.scaleRoot) % 12,
    name: PITCH_NAMES[(iv + state.scaleRoot) % 12],
    sub: ROMAN[iv],
  }));
}

// The category ring (chromatic mode only): chord type categories.
function buildRingCat() {
  return CATEGORIES.map(cat => ({ name: cat.name, quals: cat.quals }));
}

// The outer ring: the default direction (12 o'clock) first, then the same ten
// qualities the digit row enters, in the same order -- the pie and the
// two-keypress flow teach each other rather than being two vocabularies.
// 'auto' only appears when there's a scale to infer a quality from.
// In chromatic mode with a category selected, filter to that category's qualities.
function buildRing2(catIdx = -1) {
  const scaled = !!SCALES[state.scaleMode][1];

  // In chromatic mode with a category selected, show only that category's chords
  if (!scaled && catIdx >= 0 && catIdx < CATEGORIES.length) {
    const categoryQuals = CATEGORIES[catIdx].quals.map(code => ({ quality: code, name: CHORD_QUALITIES[code][0] }));
    return [SINGLE].concat(categoryQuals);
  }

  // Otherwise show all qualities
  const digits = Object.keys(CHORD_QUALITIES).map(code => ({ quality: code, name: CHORD_QUALITIES[code][0] }));
  return (scaled ? [AUTO, SINGLE] : [SINGLE]).concat(digits);
}

// Check if a chord quality can be played from a given pitch using only
// notes from the INPUT scale (not harmony). For C major pentatonic, only
// allow chords built from C/D/E/G/A, not the full major scale.
function isDiatonicForNote(pitchClass, qualityCode) {
  const inputScale = SCALES[state.scaleMode][1];
  if (!inputScale) return true; // chromatic: everything is valid
  const intervals = CHORD_QUALITIES[qualityCode][1];
  // Check if all chord tones from this pitch are in the input scale
  return intervals.every(semi => {
    const tonePitch = (pitchClass + semi) % 12;
    return degreeOfPitch(inputScale, state.scaleRoot, tonePitch) >= 0;
  });
}

// --- geometry: angle 0 at 12 o'clock, growing clockwise, so wedge i of n is
// centered on i*(360/n) and the hit test is a plain rounded division. ---
const rad = deg => (deg - 90) * Math.PI / 180;
const px = (r, deg) => {
  const rDead = getRing().DEAD;
  return rDead + r * Math.cos(rad(deg));
};
const py = (r, deg) => {
  const rDead = getRing().DEAD;
  return rDead + r * Math.sin(rad(deg));
};

function wedgePath(r0, r1, a0, a1) {
  return `M${px(r1, a0)} ${py(r1, a0)}A${r1} ${r1} 0 0 1 ${px(r1, a1)} ${py(r1, a1)}`
    + `L${px(r0, a1)} ${py(r0, a1)}A${r0} ${r0} 0 0 0 ${px(r0, a0)} ${py(r0, a0)}Z`;
}

function pick(list, ang) {
  return Math.round(ang / (360 / list.length)) % list.length;
}

function label(r, ang, text, cls, dy) {
  return `<text class="pie-t ${cls}" x="${px(r, ang)}" y="${py(r, ang)}" dy="${dy}">${text}</text>`;
}

function ring(list, r0, r1, hot, ringCls) {
  const step = 360 / list.length;
  let html = '';
  for (let i = 0; i < list.length; i++) {
    const a = i * step, on = i === hot;
    html += `<path class="pie-w ${ringCls}${on ? ' on' : ''}" d="${wedgePath(r0, r1, a - step / 2, a + step / 2)}"/>`;
  }
  // Text after every wedge so a label is never painted under its neighbour's
  // fill (SVG has no z-index -- document order is the whole stacking rule).
  const mid = (r0 + r1) / 2;
  for (let i = 0; i < list.length; i++) {
    const a = i * step, on = i === hot ? ' on' : '';
    html += list[i].sub
      ? label(mid, a, list[i].name, 'main' + on, -2) + label(mid, a, list[i].sub, 'sub' + on, 9)
      : label(mid, a, list[i].name, 'main' + on, 3);
  }
  return html;
}

function selection() {
  const o = open;
  if (o.noteIdx < 0) return null;
  const note = o.ctx.noteFor(o.ring1[o.noteIdx].pitch);
  const q = o.locked && o.qualIdx >= 0 ? o.ring2Filtered[o.qualIdx].quality : null;
  return { note, ...o.ctx.chordFor(note, q) };
}

function draw() {
  const o = open, sel = selection();
  const scaled = !!SCALES[state.scaleMode][1];

  // In chromatic mode with a category selected, rebuild ring2 for that category
  if (!scaled && o.catIdx >= 0) {
    o.ring2 = buildRing2(o.catIdx);
  }

  // In scale mode, filter qualities by the selected note's diatonic compatibility
  const filterByNote = scaled && o.noteIdx >= 0;
  const selectedPitch = filterByNote ? o.ring1[o.noteIdx].pitch : 0;

  const ring2 = o.ring2
    .filter(e => !filterByNote || e.quality === null || e.quality === 'auto' ||
      isDiatonicForNote(selectedPitch, e.quality))
    .map(e => e.quality !== 'auto' ? e
      : { ...e, sub: o.noteIdx >= 0 ? o.ctx.chordFor(o.ctx.noteFor(o.ring1[o.noteIdx].pitch), 'auto').name : '' });

  // Store filtered ring for hit-testing and selection
  o.ring2Filtered = ring2;

  // In chromatic mode, show 3 rings (note, category, quality); in scale mode, 2 rings (note, quality)
  const R = getRing();
  let html = '';
  if (!scaled) {
    // Chromatic: 3 rings
    // Quality ring: dim until category is locked
    // Category ring: dim until we're actually in it (catIdx >= 0)
    // Note ring: always active
    html = ring(ring2, R.CAT, R.QUAL, o.catLocked ? o.qualIdx : -1, 'pie-r3' + (o.catLocked ? '' : ' dim'))
      + ring(o.ringCat, R.NOTE, R.CAT, o.catIdx, 'pie-r2' + (o.catIdx >= 0 ? '' : ' dim'))
      + ring(o.ring1, R_HUB, R.NOTE, o.noteIdx, 'pie-r1');
  } else {
    // Scale mode: 2 rings
    html = ring(ring2, R.NOTE, R.QUAL, o.locked ? o.qualIdx : -1, 'pie-r2' + (o.locked ? '' : ' dim'))
      + ring(o.ring1, R_HUB, R.NOTE, o.noteIdx, 'pie-r1');
  }

  o.svg.innerHTML = html
    + `<circle class="pie-hub" cx="${R.DEAD}" cy="${R.DEAD}" r="${R_HUB}"/>`
    + `<text class="pie-hub-t" x="${R.DEAD}" y="${R.DEAD}" dy="-1">${sel ? sel.name : '·'}</text>`
    + `<text class="pie-hub-t sub" x="${R.DEAD}" y="${R.DEAD}" dy="11">oct ${state.octave}</text>`;
}

// Every hover change funnels through here so the audition and the piano
// shadow are driven by exactly what the ring highlights -- entering a wedge
// *is* the preview trigger, which is the reason to build a pie instead of a
// dropdown.
function setHover(noteIdx, catIdx, catLocked, qualIdx) {
  const o = open;
  if (noteIdx === o.noteIdx && catIdx === o.catIdx && catLocked === o.catLocked && qualIdx === o.qualIdx) return;
  o.noteIdx = noteIdx; o.catIdx = catIdx; o.catLocked = catLocked; o.qualIdx = qualIdx;
  // Scale mode uses 'locked' for backward compat
  o.locked = catLocked;
  draw();
  const sel = selection();
  o.ctx.preview(sel ? sel.notes : []);
}

function onMove(e) {
  const o = open;
  const dx = e.clientX - o.cx, dy = e.clientY - o.cy;
  const r = Math.sqrt(dx * dx + dy * dy);
  const ang = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
  const scaled = !!SCALES[state.scaleMode][1];
  const R = getRing();

  if (r < R_HUB) {
    setHover(-1, -1, false, -1);
  } else if (r < R.NOTE) {
    setHover(pick(o.ring1, ang), -1, false, -1);
  } else if (!scaled) {
    // Chromatic mode: 3 rings (note, category, quality)
    if (r < R.CAT) {
      // In category ring: lock note, select category
      if (o.noteIdx >= 0) setHover(o.noteIdx, pick(o.ringCat, ang), false, -1);
    } else if (r < R.QUAL) {
      // In quality ring: lock category, select quality
      if (o.catIdx >= 0) setHover(o.noteIdx, o.catIdx, true, pick(o.ring2Filtered || o.ring2, ang));
    } else {
      // Past dead zone
      setHover(o.noteIdx, o.catIdx, o.catLocked, -1);
    }
  } else {
    // Scale mode: 2 rings (note, quality)
    if (r < R.QUAL) {
      if (o.noteIdx >= 0) setHover(o.noteIdx, -1, true, pick(o.ring2Filtered || o.ring2, ang));
    } else {
      setHover(o.noteIdx, -1, o.catLocked, -1);
    }
  }
}

// Releasing over any wedge commits (a note wedge alone = the bare note); the
// hub and the dead zone are cancels. The one exception is the release that
// ends the opening double-click: if the pointer never left the hub, the user
// double-clicked without dragging, so the pie stays up to be clicked at
// instead of vanishing under them.
function onUp() {
  const o = open;
  if (o.noteIdx >= 0) return commit();
  if (o.armed) { o.armed = false; return; }
  closePie();
}

function commit() {
  const sel = selection(), ctx = open.ctx;
  closePie();
  ctx.commit(sel.notes, sel.name, sel.note);
}

// The pie is opened on a row rather than on a key, so it needs some answer to
// "which octave" -- state.octave, overridable live from the wheel or the same
// -/= (and </>) keys that move it everywhere else, is cheaper than spending a
// third ring on it. Re-auditions afterwards: the wedge under the cursor now
// means a different note, and hearing that (and seeing it move on the piano) is
// the point of picking the octave from in here.
function shiftOctave(d) {
  const next = Math.min(8, Math.max(1, state.octave + d));
  if (next === state.octave) return;
  state.octave = next;
  open.ctx.octaveChanged();
  draw();
  const sel = selection();
  open.ctx.preview(sel ? sel.notes : []);
}

function onWheel(e) {
  e.preventDefault();
  shiftOctave(e.deltaY < 0 ? 1 : -1);
}

// Swallows the lot while the pie is up: it's modal, and every key the editor
// binds (Space to play, digits, the note rows) would otherwise fire behind
// it. Capture phase so this runs before the handlers on document -- which is
// also why the octave keys are handled here rather than left to tracker.js's
// own: they have to keep working *and* refresh the pie.
function onKey(e) {
  e.stopPropagation();
  if (e.code === 'Escape') { e.preventDefault(); closePie(); return; }
  if (e.key === '-' || e.key === '<') shiftOctave(-1);
  else if (e.key === '=' || e.key === '>') shiftOctave(1);
}

function closePie() {
  if (!open) return;
  const { el, ctx } = open;
  document.removeEventListener('keydown', onKey, true);
  el.remove();
  open = null;
  ctx.preview([]);
}

// `x`/`y` are viewport coordinates (the opening mousedown's clientX/clientY).
// `ctx` supplies every musical answer: noteFor(pitchClass) -> an absolute note
// number at the current octave, chordFor(note, quality) -> {notes, name},
// preview(notes), commit(notes, name, rootNote), octaveChanged().
export function openPie(x, y, ctx) {
  closePie();
  const R = getRing();
  // Keep the whole outer ring on screen -- the pointer lands wherever the
  // double-clicked cell was, which near an edge would otherwise put half the
  // qualities outside the window.
  const cx = Math.min(Math.max(x, R.QUAL + 4), innerWidth - R.QUAL - 4);
  const cy = Math.min(Math.max(y, R.QUAL + 4), innerHeight - R.QUAL - 4);
  const el = document.createElement('div');
  el.className = 'pie';
  el.innerHTML = `<svg class="pie-svg" width="${R.DEAD * 2}" height="${R.DEAD * 2}"
    style="left:${cx - R.DEAD}px;top:${cy - R.DEAD}px"></svg>`;
  document.body.appendChild(el);
  // `armed` = the button that opened this is still down, so the whole pick can
  // be one drag-and-release. The overlay is full-viewport, which is also what
  // keeps the grid underneath from seeing the mousemoves (tracker.js's
  // drag-select would rubber-band along with the pointer otherwise).
  const scaled = !!SCALES[state.scaleMode][1];
  open = {
    el, svg: el.firstElementChild, ctx, cx, cy,
    ring1: buildRing1(),
    ringCat: scaled ? [] : buildRingCat(),  // category ring only in chromatic mode
    ring2: buildRing2(),
    noteIdx: -1, catIdx: -1, locked: false, catLocked: false, qualIdx: -1, armed: true,
  };
  el.addEventListener('mousemove', onMove);
  el.addEventListener('mouseup', onUp);
  el.addEventListener('wheel', onWheel, { passive: false });
  // A right-click is a cancel, not a browser menu: the pie covers the whole
  // viewport, so without this the only thing under the pointer to open a
  // context menu on would be the overlay itself.
  el.addEventListener('contextmenu', e => { e.preventDefault(); closePie(); });
  document.addEventListener('keydown', onKey, true);
  draw();
}
