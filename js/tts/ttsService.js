/**
 * iOS Safari only allows speechSynthesis.speak() once the page has called it
 * synchronously inside a user-gesture handler (tap/click); before that, calls
 * from a timer, promise, or event callback are silently dropped. Sessions
 * therefore call prime() from their start tap. When nothing is playing,
 * speech starts synchronously, so a tap-triggered call still counts as a
 * gesture; only replacing speech that is still playing defers by a moment.
 */

let voicesCache = [];
let voicesPollStarted = false;
let voiceListeners = [];

function pollVoicesUntilReady() {
  if (voicesPollStarted) return;
  voicesPollStarted = true;
  const check = () => {
    const v = speechSynthesis.getVoices();
    if (v && v.length && v.length !== voicesCache.length) {
      voicesCache = v;
      voiceListeners.forEach((fn) => fn(voicesCache));
    }
  };
  check();
  // onvoiceschanged is unreliable on iOS Safari, so poll for a while as a backup.
  speechSynthesis.addEventListener?.('voiceschanged', check);
  let attempts = 0;
  const interval = setInterval(() => {
    check();
    attempts += 1;
    if (voicesCache.length || attempts > 20) clearInterval(interval);
  }, 250);
}

pollVoicesUntilReady();

const VOICE_PREF_KEY_PREFIX = 'vocab-voice-';

function getPreferredVoiceName(langPrefix) {
  try { return localStorage.getItem(VOICE_PREF_KEY_PREFIX + langPrefix) || ''; } catch { return ''; }
}

function setPreferredVoiceName(langPrefix, name) {
  try {
    if (name) localStorage.setItem(VOICE_PREF_KEY_PREFIX + langPrefix, name);
    else localStorage.removeItem(VOICE_PREF_KEY_PREFIX + langPrefix);
  } catch {
    // Falls back to the default voice for this session only.
  }
}

/** True unless the engine says the voice is synthesised somewhere else (iOS lists plenty of those). */
const runsOnDevice = (voice) => voice.localService !== false;

function voicesFor(langPrefix) {
  const matching = voicesCache.filter((v) => v.lang?.toLowerCase().startsWith(langPrefix));
  // On-device voices speak instantly and work offline. Network voices can take
  // seconds to start, or stay silent altogether on a weak connection — which
  // is exactly where this app gets used — so they go last.
  return matching.sort((a, b) => Number(runsOnDevice(b)) - Number(runsOnDevice(a)));
}

function pickVoice(langPrefix) {
  const candidates = voicesFor(langPrefix);
  if (candidates.length === 0) return null;
  const preferredName = getPreferredVoiceName(langPrefix);
  const preferred = preferredName && candidates.find((v) => v.name === preferredName);
  return preferred || candidates[0];
}

// Chrome garbage-collects utterances nothing references any more, and then
// their onend never fires — which silently broke every "speak, then continue"
// chain. Holding them here until they finish prevents that.
const liveUtterances = new Set();

// Bumped on every new speech request, so end/error callbacks from utterances
// that were cancelled in favour of newer speech are ignored.
let generation = 0;

// Chrome and Safari both tend to drop an utterance queued in the same tick
// as cancel(). Only cancel when something is actually playing, and then give
// the engine a moment before speaking again.
const AFTER_CANCEL_DELAY_MS = 80;
// Safari accepts an utterance and then sometimes stays silent — but only,
// as far as we've seen, with a voice that is synthesised over the network.
// An on-device voice that hasn't started yet is simply warming up, and over
// Bluetooth that takes considerably longer: a car stereo has to wake its
// audio link first, and the first word of a card comes after the longest
// pause in a session. Replacing the utterance there cost the word instead of
// saving it — it arrived late, or (cancel() and speak() landing in the same
// tick, which the engines drop) not at all, while the translation spoken a
// few seconds later was always fine. So the backstop is armed for network
// voices only, and waits longer before it acts.
const SPEECH_START_TIMEOUT_MS = 2500;

function speakOne(text, langPrefix, { rate, gen, onDone, useDefaultVoice } = {}) {
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = langPrefix === 'en' ? 'en-US' : 'de-DE';
  utterance.rate = rate || 0.95;
  const voice = useDefaultVoice ? null : pickVoice(langPrefix);
  if (voice) utterance.voice = voice;

  let settled = false;
  let replaced = false;
  let startWatch = null;
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(startWatch);
    liveUtterances.delete(utterance);
    if (!replaced && gen === generation) onDone?.();
  };
  utterance.onstart = () => clearTimeout(startWatch);
  // Safari reports some failures only via onerror, never onend.
  utterance.onend = finish;
  utterance.onerror = finish;
  liveUtterances.add(utterance);
  speechSynthesis.speak(utterance);
  // A queue that has been idle can need a nudge before it plays anything.
  speechSynthesis.resume();

  if (voice && !useDefaultVoice && !runsOnDevice(voice)) {
    startWatch = setTimeout(() => {
      // speaking/pending means the engine has it in hand — leave it alone
      // rather than risk cutting off a voice that is simply slow to start.
      if (settled || gen !== generation || speechSynthesis.speaking || speechSynthesis.pending) return;
      replaced = true;
      speechSynthesis.cancel();
      // Re-speaking in the same tick as cancel() is what the engines drop
      // (see AFTER_CANCEL_DELAY_MS) — that would lose the word for good.
      setTimeout(() => {
        if (gen === generation) speakOne(text, langPrefix, { rate, gen, onDone, useDefaultVoice: true });
      }, AFTER_CANCEL_DELAY_MS);
    }, SPEECH_START_TIMEOUT_MS);
  }
  return utterance;
}

/** Starts a new speech request, replacing whatever is playing. run() receives this request's generation. */
function startFresh(run) {
  generation += 1;
  const gen = generation;
  const busy = speechSynthesis.speaking || speechSynthesis.pending;
  if (busy) speechSynthesis.cancel();
  // Chrome can get stuck in a paused state (e.g. after the tab was in the background).
  speechSynthesis.resume();
  if (!busy) {
    run(gen);
    return;
  }
  setTimeout(() => {
    if (gen === generation) run(gen);
  }, AFTER_CANCEL_DELAY_MS);
}

/**
 * Generous upper bound for how long speaking `text` takes — for callers'
 * backstop timers. Online voices can add seconds of latency even for a
 * single short word, so the base is large.
 */
function estimateDurationMs(text) {
  return 3500 + (text?.length || 0) * 100;
}

export const ttsService = {
  /**
   * iOS only lets a page speak once speak() has been called from a real tap.
   * Call this synchronously from the tap that starts a session; any speech
   * after that may then start later (e.g. once the audio session is set up).
   */
  prime() {
    const utterance = new SpeechSynthesisUtterance(' ');
    utterance.volume = 0;
    speechSynthesis.speak(utterance);
  },

  estimateDurationMs,

  /**
   * Speaks a sequence of { text, lang } items back-to-back. Must be called
   * synchronously from within a click/tap handler.
   */
  speakChain(items) {
    startFresh((gen) => {
      for (const item of items) {
        if (!item.text) continue;
        speakOne(item.text, item.lang, { rate: item.rate, gen });
      }
    });
  },

  /** direction: 'en-de' speaks English first, 'de-en' speaks German first. The (English) example, if any, is always spoken last. */
  speakCard(card, direction = 'en-de') {
    const en = { text: card.en, lang: 'en' };
    const de = { text: card.de, lang: 'de' };
    const first = direction === 'de-en' ? de : en;
    const second = direction === 'de-en' ? en : de;
    this.speakChain([
      first,
      second,
      ...(card.example ? [{ text: card.example, lang: 'en' }] : [])
    ]);
  },

  /**
   * Speaks a single utterance and calls onEnd when playback finishes — used to
   * chain into starting speech *recognition* right after the prompt is read.
   * That chain hop is not itself a user gesture, which is a smaller risk than
   * the speak() gesture requirement (see module doc), but isn't guaranteed;
   * callers should offer a manual fallback control regardless.
   */
  speakOnce(text, langPrefix, { onEnd, rate } = {}) {
    startFresh((gen) => speakOne(text, langPrefix, { rate, gen, onDone: onEnd }));
  },

  /**
   * Speaks a sequence of { text, lang } items one after another (chained via
   * each utterance's onend) and calls onEnd once the last one finishes — used
   * to know when it's safe to auto-advance. Same best-effort caveat as
   * speakOnce: this whole chain typically isn't gesture-triggered, so a
   * caller-side timeout backstop is recommended in case onEnd never fires.
   */
  speakSequence(items, onEnd) {
    const valid = items.filter((i) => i.text);
    if (valid.length === 0) {
      generation += 1;
      onEnd?.();
      return;
    }
    startFresh((gen) => {
      let i = 0;
      const playNext = () => {
        if (i >= valid.length) {
          onEnd?.();
          return;
        }
        const item = valid[i];
        i += 1;
        speakOne(item.text, item.lang, { rate: item.rate, gen, onDone: playNext });
      };
      playNext();
    });
  },

  stop() {
    generation += 1;
    speechSynthesis.cancel();
  },

  isSupported() {
    return typeof window !== 'undefined' && 'speechSynthesis' in window;
  },

  /** All voices the device offers for a language ('en' or 'de'), on-device ones first, for a voice picker. */
  listVoices(langPrefix) {
    return voicesFor(langPrefix);
  },

  runsOnDevice,

  getPreferredVoiceName,
  setPreferredVoiceName,

  /**
   * Called whenever the device's voice list changes after this point (e.g.
   * arrives asynchronously post-render — see module doc). Does NOT fire
   * immediately for voices already cached; callers should read
   * listVoices()/getPreferredVoiceName() directly for the current state and
   * use this only to react to later changes (a caller that re-subscribes on
   * every render, like a voice picker re-rendering itself, would otherwise
   * recurse forever on an immediate synchronous replay).
   */
  onVoicesChange(fn) {
    voiceListeners.push(fn);
    return () => {
      voiceListeners = voiceListeners.filter((l) => l !== fn);
    };
  },

  /** Speaks a short sample with a specific voice, for previewing in the voice picker — must be called directly from a click (see module doc). */
  previewVoice(langPrefix, voiceName, sampleText) {
    startFresh(() => {
      const utterance = new SpeechSynthesisUtterance(sampleText);
      utterance.lang = langPrefix === 'en' ? 'en-US' : 'de-DE';
      utterance.rate = 0.95;
      const voice = voicesCache.find((v) => v.name === voiceName);
      utterance.voice = voice || pickVoice(langPrefix);
      speechSynthesis.speak(utterance);
    });
  }
};
