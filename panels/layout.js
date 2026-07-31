// Vertical layout for the three rows below #top: the keyboard row, the
// tracks row (sequencer + patterns), and the bottom row (instrument +
// scope). Only the keyboard and bottom rows are collapsible/resizable here
// -- the tracks row is the primary work area, so it always takes whatever
// space these two leave it, floored at TRACKS_MIN (mirrored in screen.css's
// #tracks min-height) rather than being squeezed to nothing the way it used
// to be at a short viewport or high browser/OS zoom (see screen.css's
// comment on #tracks for the mechanics of that bug).
//
// Both rows persist their height and collapsed state through state.js
// (kbRowH/kbRowCollapsed/bottomRowH/bottomRowCollapsed), null height meaning
// "use the row's natural/CSS size" -- so a user who never touches a handle
// sees exactly the old fixed layout.

import { state, savePrefs } from '../state.js';
import { svgIcon } from '../icons.js';

const $ = id => document.getElementById(id);

const HANDLE_H = 6;     // px, matches screen.css's .row-handle height
const TRACKS_MIN = 140; // px, matches screen.css's #tracks min-height
const ROW_MIN = 60;     // px, a resizable row's own floor while expanded
const COLLAPSED_H = 27; // px, matches screen.css's .row-collapsed height

const ROWS = {
  kb: { el: 'keyboard-row', toggle: 'keyboard-toggle', handle: 'keyboard-handle',
        hField: 'kbRowH', cField: 'kbRowCollapsed', label: 'keyboard' },
  bottom: { el: 'bottom', toggle: 'bottom-toggle', handle: 'bottom-handle',
            hField: 'bottomRowH', cField: 'bottomRowCollapsed', label: 'instrument' },
};

// How tall `key`'s row may grow without pushing #tracks under TRACKS_MIN,
// given the *other* resizable row's current height.
function maxFor(key) {
  const other = ROWS[key === 'kb' ? 'bottom' : 'kb'];
  const otherH = state[other.cField] ? COLLAPSED_H : $(other.el).getBoundingClientRect().height;
  return window.innerHeight - $('top').getBoundingClientRect().height - otherH - TRACKS_MIN - HANDLE_H * 2;
}

function applyRow(key) {
  const row = ROWS[key];
  const el = $(row.el);
  const collapsed = state[row.cField];
  el.classList.toggle('row-collapsed', collapsed);
  $(row.handle).classList.toggle('row-handle-hidden', collapsed);
  $(row.toggle).title = `${collapsed ? 'Expand' : 'Collapse'} the ${row.label} row`;
  if (collapsed) { el.style.height = ''; return; }
  const h = Math.max(ROW_MIN, Math.min(state[row.hField] || el.getBoundingClientRect().height, maxFor(key)));
  el.style.height = h + 'px';
}

function toggleRow(key) {
  state[ROWS[key].cField] = !state[ROWS[key].cField];
  applyRow(key);
  savePrefs();
}

function startDrag(key, downEvent) {
  if (downEvent.button !== 0) return;
  const row = ROWS[key];
  const el = $(row.el);
  const startY = downEvent.clientY;
  const startH = el.getBoundingClientRect().height;
  const max = maxFor(key);
  $(row.handle).classList.add('dragging');
  const onMove = e => {
    // The bottom row sits *below* its handle, so dragging the handle down
    // (positive dy) shrinks it; the keyboard row sits *above* its handle, so
    // the same drag grows it.
    const dy = e.clientY - startY;
    const h = Math.max(ROW_MIN, Math.min(startH + (key === 'bottom' ? -dy : dy), max));
    el.style.height = h + 'px';
    state[row.hField] = h;
  };
  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    $(row.handle).classList.remove('dragging');
    savePrefs();
  };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  downEvent.preventDefault();
}

export function initLayout() {
  for (const key of Object.keys(ROWS)) {
    const row = ROWS[key];
    $(row.toggle).insertAdjacentHTML('afterbegin', svgIcon('chevron'));
    $(row.toggle).onclick = () => toggleRow(key);
    $(row.handle).onpointerdown = e => startDrag(key, e);
    applyRow(key);
  }
  // A viewport resize (or an in-page zoom change, which fires the same
  // event) can put a saved height above what now fits -- re-clamp both.
  window.addEventListener('resize', () => { applyRow('kb'); applyRow('bottom'); });
}
