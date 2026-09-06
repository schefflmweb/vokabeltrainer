/**
 * iOS Safari only allows speechSynthesis.speak() when the call happens
 * synchronously inside a user-gesture handler (tap/click). A call made later
 * from a timer, promise, or event callback is silently dropped. So every
 * public function here must be invoked directly from a click handler, and
 * queues its utterances synchronously in one go — never via setTimeout.
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

function voicesFor(langPrefix) {
  return voicesCache.filter((v) => v.lang?.toLowerCase().startsWith(langPrefix));
}

function pickVoice(langPrefix) {
  const candidates = voicesFor(langPrefix);
  if (candidates.length === 0) return null;
  const preferredName = getPreferredVoiceName(langPrefix);
  const preferred = preferredName && candidates.find((v) => v.name === preferredName);
  return preferred || candidates[0];
}

function speakOne(text, langPrefix, rate) {
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = langPrefix === 'en' ? 'en-US' : 'de-DE';
  utterance.rate = rate || 0.95;
  const voice = pickVoice(langPrefix);
  if (voice) utterance.voice = voice;
  speechSynthesis.speak(utterance);
  return utterance;
}

export const ttsService = {
  /**
   * Speaks a sequence of { text, lang } items back-to-back. Must be called
   * synchronously from within a click/tap handler.
   */
  speakChain(items) {
    speechSynthesis.cancel(); // clear anything stuck queued from before
    for (const item of items) {
      if (!item.text) continue;
      speakOne(item.text, item.lang, item.rate);
    }
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
    speechSynthesis.cancel();
    const utterance = speakOne(text, langPrefix, rate);
    if (onEnd) utterance.onend = onEnd;
  },

  /**
   * Speaks a sequence of { text, lang } items one after another (chained via
   * each utterance's onend) and calls onEnd once the last one finishes — used
   * to know when it's safe to auto-advance. Same best-effort caveat as
   * speakOnce: this whole chain typically isn't gesture-triggered, so a
   * caller-side timeout backstop is recommended in case onEnd never fires.
   */
  speakSequence(items, onEnd) {
    speechSynthesis.cancel();
    const valid = items.filter((i) => i.text);
    if (valid.length === 0) {
      onEnd?.();
      return;
    }
    let i = 0;
    const playNext = () => {
      if (i >= valid.length) {
        onEnd?.();
        return;
      }
      const item = valid[i];
      i += 1;
      const utterance = speakOne(item.text, item.lang, item.rate);
      utterance.onend = playNext;
    };
    playNext();
  },

  stop() {
    speechSynthesis.cancel();
  },

  isSupported() {
    return typeof window !== 'undefined' && 'speechSynthesis' in window;
  },

  /** All voices the device offers for a language ('en' or 'de'), for a voice picker. */
  listVoices(langPrefix) {
    return voicesFor(langPrefix);
  },

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
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(sampleText);
    utterance.lang = langPrefix === 'en' ? 'en-US' : 'de-DE';
    utterance.rate = 0.95;
    const voice = voicesCache.find((v) => v.name === voiceName);
    utterance.voice = voice || pickVoice(langPrefix);
    speechSynthesis.speak(utterance);
  }
};
