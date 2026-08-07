// Adjustable UI colour: an accent, and a tint for everything that isn't one.
//
// Every themed colour in screen.css is a `var(--xxx)` custom property on
// :root. Two of them are the user's:
//
//   --accent   the highlight colour -- cursors, selections, sliders, the
//              scope trace. Everything derived from it (selected-cell tint,
//              current-row tint) is a CSS color-mix() against it, so those
//              follow with no extra JS.
//
//   the tint   the hue of every *other* colour: the dark greys the whole
//              editor is built out of, and the three text shades. Not a
//              colour that gets used directly -- see applyTint below.
//
// HOW THE TINT WORKS, AND WHY IT IS NOT A color-mix()
//
// The obvious implementation is `color-mix(in srgb, var(--tint) 15%, #1c1f25)`
// per grey, in CSS, with no JS at all. It is wrong: mixing a colour into a
// grey moves its *lightness* as well as its hue, by an amount that depends on
// how bright the picked colour happens to be. The nine shades below are a
// deliberate ladder -- panel over page, card over panel, border over card, and
// three tiers of text on top -- and every bit of this UI's legibility is in the
// gaps between them. A tint that squashed those gaps together would be a
// contrast bug wearing a colour picker.
//
// So the tint is applied in JS instead, and only the two channels that are
// safe to move: each shade keeps its own lightness exactly, and takes the
// picked colour's hue. The saturation comes from the picked colour too, scaled
// down hard and capped -- these have to stay greys that happen to lean a
// direction, not colours. The text shades take two thirds of the greys'
// amount, because the same saturation that reads as a faint cast at 12%
// lightness reads as a wash at 96%.
//
// The default reproduces the palette that was previously hardcoded: those
// greys were never neutral, they were already a cool blue-grey at about hue
// 225, and picking that as the default tint means the editor looks identical
// until the control is touched.
//
// THREE PLACES CAN'T READ A CUSTOM PROPERTY
//
//   panels/scope.js, panels/sfx-view.js and panels/pianoroll.js draw canvas
//   pixels rather than styling DOM, and each used to carry `#0d0e11` copied
//   out of screen.css by hand. That copy is exactly what a tint breaks -- the
//   page would tint and the canvases would stay grey. They call getShade()
//   now, which reads the cached computed value rather than forcing a
//   getComputedStyle() inside a 60fps loop.
//
//   panels/instrument.js bakes each slider's fill into an inline
//   linear-gradient at paint time, so a colour picked after a slider was last
//   painted would sit stale until something repainted it. Both appliers
//   therefore fire a 'themechange' event, which instrument.js listens for to
//   repaint every slider at once, and sfx-view.js to redraw its waveforms.

const $ = id => document.getElementById(id);

const ACCENT_KEY = 'soundbox-accent', TINT_KEY = 'soundbox-tint';
const DEFAULT_ACCENT = '#ff8a3d';
// hsl(225, 44%, 50%) -- the hue and saturation the shade ladder below already
// had. See the note on defaults above.
const DEFAULT_TINT = '#476ab8';

// The shade ladder, as it was before any of this existed. These are the source
// of truth for *lightness*; their hue and saturation are replaced on every
// apply, so the exact blue in each hex here is only documentation of where the
// default tint came from.
const SHADES = {
  '--bg0': '#0d0e11',        // page background
  '--bg1': '#1c1f25',        // panel background
  '--bg2': '#262a32',        // card/button/input background
  '--bg3': '#333944',        // hover/active background
  '--border-dim': '#383d46',
  '--border': '#545c68',
  '--key-black': '#0a0b0d',  // piano-roll black-key lane, darker than --bg0
  '--text-dim2': '#7d8492',
  '--text-dim': '#b0b8c4',
  '--text': '#f3f5f8',
};
const TEXT_SHADES = new Set(['--text', '--text-dim', '--text-dim2']);

// How much of the picked colour's saturation each kind of shade takes, and the
// ceiling neither may pass. Past about 0.2 a background stops reading as a
// tinted grey and starts reading as a colour, which fights the accent.
const GREY_SAT = 0.30, TEXT_SAT = 0.20, MAX_SAT = 0.20;

// --- colour conversion. Enough of it, and no more. ---

function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  if (!d) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0))
    : max === g ? (b - r) / d + 2
      : (r - g) / d + 4;
  return { h: h * 60, s, l };
}

function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  const seg = Math.floor(((h % 360) + 360) % 360 / 60);
  const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][seg];
  const hex = v => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return '#' + hex(r) + hex(g) + hex(b);
}

// --- state ---

let accent = DEFAULT_ACCENT, tint = DEFAULT_TINT;
// The computed shade values, so canvas code can read one without a style
// recalc. Rebuilt on every applyTint.
let shades = { ...SHADES };

function applyAccent(hex) {
  accent = hex;
  document.documentElement.style.setProperty('--accent', hex);
  document.dispatchEvent(new Event('themechange'));
}

function applyTint(hex) {
  tint = hex;
  const { h, s } = hexToHsl(hex);
  for (const [name, base] of Object.entries(SHADES)) {
    const sat = Math.min(MAX_SAT, s * (TEXT_SHADES.has(name) ? TEXT_SAT : GREY_SAT));
    // The base's own lightness, untouched -- that ladder is the contrast.
    const value = hslToHex(h, sat, hexToHsl(base).l);
    shades[name] = value;
    document.documentElement.style.setProperty(name, value);
  }
  document.dispatchEvent(new Event('themechange'));
}

export function initTheme() {
  applyTint(localStorage.getItem(TINT_KEY) || DEFAULT_TINT);
  applyAccent(localStorage.getItem(ACCENT_KEY) || DEFAULT_ACCENT);
  $('theme-accent').value = accent;
  $('theme-accent').oninput = () => setAccent($('theme-accent').value);
  $('theme-tint').value = tint;
  $('theme-tint').oninput = () => setTint($('theme-tint').value);
}

export function setAccent(hex) {
  applyAccent(hex);
  localStorage.setItem(ACCENT_KEY, hex);
}

export function setTint(hex) {
  applyTint(hex);
  localStorage.setItem(TINT_KEY, hex);
}

export function getAccent() { return accent; }
export function getTint() { return tint; }

// The current value of a shade, for the canvases that can't read a CSS
// variable. Named with the custom property's own name so a reader can find the
// rule it corresponds to: getShade('--bg0').
export function getShade(name) { return shades[name]; }
