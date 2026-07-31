export const audioContext = new (window.AudioContext || window.webkitAudioContext)();

// Master gain node sits between all sound sources and the destination, so
// adjusting its .gain.value scales the final output. Jammer (keyboard.js) and
// rendered songs (main.js) both connect here instead of directly to .destination.
export const masterGain = audioContext.createGain();
masterGain.connect(audioContext.destination);
