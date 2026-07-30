// The open dialog's built-in song library: one `export default {...}` module
// per song, the same shape the editor's own Export JS produces, so a song
// opened here, edited and re-exported round-trips through the ordinary import
// path (tests/soundbox/test-import.mjs covers it). Legacy sonant-x / old-
// SoundBox / hand-minified songs are converted in with `npm run convert-song`
// (scripts/convert-song.mjs).
//
// Two sections: full songs (multi-channel, multi-step sequences) and one-shot
// SFX (a single sequencer step). `desc` is the rendered channel count and
// length, measured rather than described, so nothing here claims a character
// the file might not have.
//
// Loading is a dynamic import() per card rather than 32 static imports at
// boot: this is ~176 KB of song data and the editor opens with none of it
// needed. main.js's loadDemoSong() runs the imported default through
// engine.normalizeSong(), since these files are sparse exports (trimmed
// tails, holes, channels past numChannels omitted) just like any other
// import.
//
// Nothing in this directory ships in the game zip -- it's tooling. A song
// that ends up in an actual game gets exported into src/js/sounds/.

export const DEMO_SONGS = [
  // --- full songs ---
  { section: 'Songs', file: 'gamemusic.js', name: 'Game music', desc: '7 channels · 1:20' },
  { section: 'Songs', file: 'greeble-game.js', name: 'Greeble — in-game', desc: '6 channels · 2:29' },
  { section: 'Songs', file: 'greeble-title.js', name: 'Greeble — title', desc: '5 channels · 1:04' },
  { section: 'Songs', file: 'super-glitch-box.js', name: 'Super Glitch Box', desc: '4 channels · 0:40' },
  { section: 'Songs', file: 'super-glitch-box-title.js', name: 'Super Glitch Box — title', desc: '6 channels · 0:20' },
  { section: 'Songs', file: 'archer-duel-of-aces.js', name: 'Archer: Duel of Aces', desc: '5 channels · 0:15' },
  { section: 'Songs', file: 'backpack-monsters.js', name: 'Backpack Monsters', desc: '5 channels · 0:55' },
  { section: 'Songs', file: 'moonlight-sonata.js', name: 'Moonlight Sonata, 3rd mvt', desc: 'Beethoven, readapted · 5 channels · 0:48' },
  { section: 'Songs', file: 'tendergotchi.js', name: 'Tendergotchi', desc: '5 channels · 0:27' },

  // --- one-shot sound effects ---
  { section: 'SFX', file: 'altar-done.js', name: 'Altar done', desc: '1 channel · 4.0s' },
  { section: 'SFX', file: 'footstep.js', name: 'Footstep', desc: '1 channel · 4.0s' },
  { section: 'SFX', file: 'gremlin-attack.js', name: 'Gremlin attack', desc: '1 channel · 1.8s' },
  { section: 'SFX', file: 'gremlin-hurt.js', name: 'Gremlin hurt', desc: '1 channel · 4.0s' },
  { section: 'SFX', file: 'pickup.js', name: 'Pickup', desc: '1 channel · 4.0s' },
  { section: 'SFX', file: 'player-attack.js', name: 'Player attack', desc: '1 channel · 4.0s' },
  { section: 'SFX', file: 'player-death.js', name: 'Player death', desc: '1 channel · 2.7s' },
  { section: 'SFX', file: 'player-hurt.js', name: 'Player hurt', desc: '1 channel · 4.0s' },
  { section: 'SFX', file: 'pot-break.js', name: 'Pot break', desc: '4 channels · 1.6s' },
  { section: 'SFX', file: 'spawn.js', name: 'Spawn', desc: '1 channel · 4.0s' },
  { section: 'SFX', file: 'tada.js', name: 'Tada', desc: '1 channel · 4.4s' },
  { section: 'SFX', file: 'torch.js', name: 'Torch', desc: '3 channels · 2.4s' },
  { section: 'SFX', file: 'greeble-boom.js', name: 'Greeble — boom', desc: '1 channel · 4.0s' },
  { section: 'SFX', file: 'greeble-fuel-get.js', name: 'Greeble — fuel get', desc: '1 channel · 3.0s' },
  { section: 'SFX', file: 'greeble-jet.js', name: 'Greeble — jet', desc: '1 channel · 4.0s' },
  { section: 'SFX', file: 'greeble-jump.js', name: 'Greeble — jump', desc: '1 channel · 4.0s' },
  { section: 'SFX', file: 'greeble-step.js', name: 'Greeble — step', desc: '1 channel · 4.0s' },
  { section: 'SFX', file: 'greeble-zap-gun.js', name: 'Greeble — zap gun', desc: '1 channel · 1.8s' },
  // musics1/musics2 in the source compilation, both unnamed there (the file
  // only labelled the three below); described by what they play.
  { section: 'SFX', file: 'tendergotchi-sfx-1.js', name: 'Tendergotchi — chirp', desc: 'rising blip with a pitch slide · 3.0s' },
  { section: 'SFX', file: 'tendergotchi-sfx-2.js', name: 'Tendergotchi — down-run', desc: 'descending five-note run · 1.5s' },
  { section: 'SFX', file: 'tendergotchi-fanfare.js', name: 'Tendergotchi — fanfare', desc: '1 channel · 1.5s' },
  { section: 'SFX', file: 'tendergotchi-fanfare-2.js', name: 'Tendergotchi — fanfare 2', desc: '1 channel · 2.2s' },
  { section: 'SFX', file: 'tendergotchi-angry-beep.js', name: 'Tendergotchi — angry beep', desc: '1 channel · 2.2s' },
];

export const SECTIONS = ['Songs', 'SFX'];
