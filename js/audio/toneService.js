/**
 * Short synthesized feedback tones (Web Audio API — no audio files needed,
 * works fully offline). AudioContext starts 'suspended' until resumed from a
 * real user gesture; unlock() should be called synchronously from the
 * session-start tap so tones keep playing through the rest of an automatic,
 * hands-free session. Unlike speechSynthesis, this "unlock once" behavior is
 * the standard, well-supported Web Audio autoplay policy — not a per-call
 * gesture requirement — so tones are the more reliable feedback channel here.
 */

let audioCtx = null;

function getContext() {
  if (!audioCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    audioCtx = Ctor ? new Ctor() : null;
  }
  return audioCtx;
}

function playTone(freqSequence, noteDuration = 0.12, gain = 0.18) {
  const ctx = getContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();
  let t = ctx.currentTime;
  freqSequence.forEach((freq) => {
    const osc = ctx.createOscillator();
    const gainNode = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gainNode.gain.setValueAtTime(0, t);
    gainNode.gain.linearRampToValueAtTime(gain, t + 0.01);
    gainNode.gain.linearRampToValueAtTime(0, t + noteDuration);
    osc.connect(gainNode).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + noteDuration + 0.02);
    t += noteDuration;
  });
}

export const toneService = {
  /**
   * How long playCorrect()/playIncorrect() take to finish (2 notes × 120ms +
   * a little safety margin). Callers that also speak afterward should wait
   * at least this long first — Web Audio and speechSynthesis are two
   * independent audio paths with no shared clock, so starting both at once
   * plays them on top of each other instead of one after the other.
   */
  DURATION_MS: 300,

  /** Call synchronously from the tap that starts a session. */
  unlock() {
    const ctx = getContext();
    if (ctx && ctx.state === 'suspended') ctx.resume();
  },

  playCorrect() {
    playTone([660, 880]); // short ascending "ding"
  },

  playIncorrect() {
    playTone([220, 165]); // short descending buzz
  }
};
