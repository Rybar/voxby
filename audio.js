// Single shared Web Audio context (Stage E.5 re-scope). Previously the
// jammer (jammer.js's CJammer, live note preview) and rendered song
// playback (main.js) each brought up their own separate audio pipeline --
// the jammer created a private AudioContext, and playback used a plain
// <audio> element, which has no AudioContext at all. That meant two
// independent "is this unlocked yet" states, and the jammer's own
// unlock (a document-wide 'click' listener inside jammer.js) never fired
// for physical-keyboard-only note preview -- a keydown isn't a 'click',
// so the context stayed suspended and jamming produced silence (and
// nothing for the scope to draw) until the user happened to click
// something else first.
//
// Now everything shares this one context, and main.js's startup gate
// modal (shown immediately on load, not dismissible except by clicking
// its Start button) is the single required user gesture that resumes it
// -- see main.js's #audio-gate-start handler.
export const audioContext = new (window.AudioContext || window.webkitAudioContext)();
