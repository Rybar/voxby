// Inline SVG icon fragments for the soundbox UI (plans/soundbox-revamp.md
// Phase 3 Stage B), replacing the gui/*.png sprite sheet. Each fragment is
// an inner-SVG string using currentColor, so hover/active states are a CSS
// color change rather than an asset swap — see svgIcon() below and
// screen.css's button/.icon-btn rules. A 0..20 viewBox matches
// tools/drawtool/ui.js's existing icon-button convention, reused here for
// consistency across tools rather than inventing a second convention.
//
// Waveform/filter/copy/paste icons are defined now (cheap — this is a
// dev-only tool, none of it ships in the game zip) even though Stage B's
// own markup only uses the file/transport/about icons; Stage C's
// instrument panel and Stage D's tracker grids reuse this same set instead
// of duplicating icon work later.

export const ICONS = {
  // File
  newDoc: '<rect x="4" y="2" width="10" height="16" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/>'
    + '<path d="M9 7 V13 M6 10 H12" stroke="currentColor" stroke-width="1.6"/>',
  open: '<path d="M2 6 V16 H18 V8 H10 L8 6 Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  download: '<path d="M10 2 V13 M5.5 9 L10 13.5 L14.5 9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'
    + '<path d="M3 16.5 H17" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',

  // A chain link, for Stage E.14's Share button (a song packed into a URL).
  link: '<path d="M8 12 L12 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'
    + '<path d="M7.5 8.5 L5.5 6.5 A3 3 0 0 1 9.5 2.5 L11.5 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'
    + '<path d="M12.5 11.5 L14.5 13.5 A3 3 0 0 1 10.5 17.5 L8.5 15.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',

  // Transport
  play: '<path d="M5 3 L17 10 L5 17 Z" fill="currentColor"/>',
  stop: '<rect x="5" y="5" width="10" height="10" fill="currentColor"/>',
  // "Play selected": a play triangle with a bracket, for the Stage E.7
  // play-selected/solo-pattern button (main.js's #play-selected).
  playSel: '<path d="M4 3 V17 M2 3 H4 M2 17 H4" fill="none" stroke="currentColor" stroke-width="1.6"/>'
    + '<path d="M8 4 L18 10 L8 16 Z" fill="currentColor"/>',

  // Misc
  about: '<circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.6"/>'
    + '<text x="10" y="14.5" font-size="11" font-family="system-ui,sans-serif" text-anchor="middle" fill="currentColor">?</text>',

  // Waveforms (Stage C: OSC1/OSC2/LFO wave pickers)
  waveSine: '<path d="M2 10 Q6 3 10 10 T18 10" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  waveTriangle: '<path d="M2 10 L6 3 L14 17 L18 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  waveSaw: '<path d="M2 15 L2 5 L14 15 L14 5 L18 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  waveSquare: '<path d="M2 5 H8 V15 H14 V5 H18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',

  // Filters (Stage C: FX filter picker)
  filterLowpass: '<path d="M2 6 H8 Q13 6 13 12 T18 16" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  filterHighpass: '<path d="M2 16 Q7 16 7 8 T12 4 H18" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  filterBandpass: '<path d="M2 16 Q6 16 8 6 Q10 16 18 16" fill="none" stroke="currentColor" stroke-width="1.6"/>',

  // Edit (Stage C/D: copy/paste buttons)
  copy: '<rect x="3" y="5" width="10" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/>'
    + '<path d="M7 5 V3 H17 V15 H15" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  paste: '<rect x="4" y="4" width="12" height="14" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/>'
    + '<rect x="7" y="2" width="6" height="3" rx="0.5" fill="currentColor"/>',
};

export function svgIcon(name, size = 16) {
  return `<svg viewBox="0 0 20 20" width="${size}" height="${size}">${ICONS[name]}</svg>`;
}
