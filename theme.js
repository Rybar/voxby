// Adjustable UI theme (plans/soundbox-revamp.md Phase 3 Stage E.9). Every
// themed color in screen.css is a `var(--xxx)` custom property on :root;
// the only one exposed as user-adjustable is --accent (the "bright blue,
// change it to orange" ask, made a live-editable knob rather than a second
// hardcoded color) -- everything derived from it (selected-cell tint,
// current-row tint) uses CSS color-mix() against --accent directly, so
// picking a new accent recolors those too with no extra JS.
//
// panels/scope.js draws its own canvas pixels (oscilloscope trace,
// spectrometer bars) rather than styling DOM, so it can't just inherit
// --accent from CSS -- it reads getAccent() instead. That's a plain cached
// string, not a live getComputedStyle() read, so the persistent rAF draw
// loop (60fps) isn't paying for a style recalc every frame; the cache is
// only refreshed when setAccent() actually changes it.
//
// Stage E.10: panels/instrument.js's slider fills (paintFill(), Stage E.8)
// have the same problem one level worse -- they're not even a live CSS
// read, just a linear-gradient baked into each slider's inline style at
// paint time, so a color picked *after* a slider was last painted would
// otherwise sit stale until the next unrelated interaction repainted it.
// Fixed the same way scope.js's per-frame redraw already keeps itself in
// sync: applyAccent() fires a 'themechange' DOM event every time --accent
// actually changes, and instrument.js listens for it to repaint every
// slider immediately.
const $ = id => document.getElementById(id);

const STORAGE_KEY = 'soundbox-accent';
const DEFAULT_ACCENT = '#ff8a3d';

let accent = DEFAULT_ACCENT;

function applyAccent(hex) {
  accent = hex;
  document.documentElement.style.setProperty('--accent', hex);
  document.dispatchEvent(new Event('themechange'));
}

export function initTheme() {
  applyAccent(localStorage.getItem(STORAGE_KEY) || DEFAULT_ACCENT);
  $('theme-accent').value = accent;
  $('theme-accent').oninput = () => setAccent($('theme-accent').value);
}

export function setAccent(hex) {
  applyAccent(hex);
  localStorage.setItem(STORAGE_KEY, hex);
}

export function getAccent() { return accent; }
