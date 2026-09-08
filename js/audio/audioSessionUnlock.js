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
 * if silent, <audio> element continuously playing. Safari then tends to
 * treat the page's whole audio session as real media playback, which can
 * carry over to audio started later on the same page (Web Audio tones,
 * speechSynthesis) too. Must be started synchronously from a real tap,
 * same gesture requirement as toneService.unlock().
 */

let audioEl = null;

/** A ~0.1s silent WAV, built at runtime (no network request, no bundled asset). */
function buildSilentAudioUrl() {
  const sampleRate = 8000;
  const numSamples = 800; // 0.1s, 8-bit mono => 1 byte/sample
  const dataSize = numSamples;
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
  view.setUint32(28, sampleRate, true); // ByteRate = sampleRate * channels * bytes/sample
  view.setUint16(32, 1, true); // BlockAlign
  view.setUint16(34, 8, true); // BitsPerSample
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < dataSize; i++) view.setUint8(44 + i, 128); // silence (8-bit unsigned midpoint)

  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}

export const audioSessionUnlock = {
  /**
   * Call synchronously from the same tap as toneService.unlock(), at the
   * start of an Auto-mode session. Keeps looping silently for as long as
   * Auto mode stays mounted — see stop().
   */
  start() {
    if (!audioEl) {
      audioEl = new Audio(buildSilentAudioUrl());
      audioEl.loop = true;
      audioEl.volume = 0;
    }
    audioEl.play().catch(() => {
      // Best-effort — if this silently fails, speechSynthesis just falls
      // back to its normal (ambient-category, phone-speaker-only) behavior.
    });
  },

  /** Call when leaving Auto mode — no reason to keep a silent loop running elsewhere. */
  stop() {
    audioEl?.pause();
  }
};
