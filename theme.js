// Adjustable UI accent color. Every themed color in screen.css is a
// `var(--xxx)` custom property on :root; --accent is the one the user can
// change, and everything derived from it (selected-cell tint, current-row tint)
// is a CSS color-mix() against it, so those follow along with no extra JS.
//
// Two places can't read the custom property and need the value pushed to them:
//
//   panels/scope.js draws canvas pixels rather than styling DOM, and calls
//   getAccent() -- a cached string, not a live getComputedStyle(), so its 60fps
//   draw loop isn't forcing a style recalc every frame.
//
//   panels/instrument.js bakes each slider's fill into an inline
//   linear-gradient at paint time, so a color picked after a slider was last
//   painted would sit stale until something repainted it. applyAccent()
//   therefore fires a 'themechange' event, which instrument.js listens for to
//   repaint every slider at once.
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
