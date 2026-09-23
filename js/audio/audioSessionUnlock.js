/**
 * iOS Safari gives web pages the "ambient" audio session category by
 * default. That category (a) is silenced by the phone's physical mute
 * switch and (b) doesn't reliably route to Bluetooth (e.g. a car stereo)
 * the way real media playback does — speechSynthesis in particular is
 * known to keep playing through the phone's own speaker even with
 * Bluetooth connected and other apps (Music, Podcasts) routing correctly.
 * This is a long-standing WebKit limitation; there's no public API for a
 * page to request the "playback" category directly.
 *
 * The commonly reported (not guaranteed — can't be verified without a real
 * device connected to real Bluetooth car audio) workaround: keep a real,
 * if quiet, <audio> element continuously playing. Safari then tends to
 * treat the page's whole audio session as real media playback, which can
 * carry over to audio started later on the same page (Web Audio tones,
 * speechSynthesis) too. Must be started synchronously from a real tap,
 * same gesture requirement as toneService.unlock().
 *
 * The loop carries a very quiet tone (about -67 dBFS after the element's
 * volume) rather than digital silence, and its frequency divides the sample
 * rate exactly so the loop point can't click. A louder version (about
 * -24 dBFS) was tried against a Bluetooth delay in the car and made no
 * difference - what fixed that was the "Vorlauf" before automatic speech and
 * speaking the way the older version did (see ttsService.startFresh) - so it
 * stays as quiet as it can be.
 */

const KEEP_ALIVE_VOLUME = 0.05;

let audioEl = null;

// Starting playback switches iOS's audio session, which can cut off speech
// that began at the same moment — so speech waits until this has settled.
const PLAY_SETTLE_MAX_MS = 600;
const AFTER_PLAY_SETTLE_MS = 250;

/** A 1s WAV holding a very quiet tone, built at runtime (no network request, no bundled asset). */
function buildKeepAliveAudioUrl() {
  const sampleRate = 8000;
  const numSamples = sampleRate; // 1s, 16-bit mono => 2 bytes/sample
  const toneHz = 200; // 8000 / 200 = 40 samples per period, so 1s holds exactly 200 of them
  const amplitude = 300; // of 32767 — about -41 dBFS before the element's own volume
  const dataSize = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size (PCM)
  view.setUint16(20, 1, true); // AudioFormat: PCM
  view.setUint16(22, 1, true); // NumChannels: mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // ByteRate = sampleRate * channels * bytes/sample
  view.setUint16(32, 2, true); // BlockAlign
  view.setUint16(34, 16, true); // BitsPerSample
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.round(amplitude * Math.sin((2 * Math.PI * toneHz * i) / sampleRate));
    view.setInt16(44 + i * 2, sample, true);
  }

  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}

export const audioSessionUnlock = {
  /**
   * Call synchronously from the same tap as toneService.unlock(), at the
   * start of an Auto-mode session. Keeps looping for as long as Auto mode
   * stays mounted, inaudibly quiet but never digitally silent — see stop().
   * Resolves (never rejects) once it's safe to start speaking.
   */
  start() {
    if (!audioEl) {
      audioEl = new Audio(buildKeepAliveAudioUrl());
      audioEl.loop = true;
      audioEl.volume = KEEP_ALIVE_VOLUME;
    }
    // Best-effort — if this silently fails, speechSynthesis just falls back
    // to its normal (ambient-category, phone-speaker-only) behavior.
    const played = audioEl.play().catch(() => {});
    const timedOut = new Promise((resolve) => setTimeout(resolve, PLAY_SETTLE_MAX_MS));
    return Promise.race([played, timedOut])
      .then(() => new Promise((resolve) => setTimeout(resolve, AFTER_PLAY_SETTLE_MS)));
  },

  /** Call when leaving Auto mode — no reason to keep a silent loop running elsewhere. */
  stop() {
    audioEl?.pause();
  }
};
