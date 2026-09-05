/**
 * iOS Safari only allows speechSynthesis.speak() when the call happens
 * synchronously inside a user-gesture handler (tap/click). A call made later
 * from a timer, promise, or event callback is silently dropped. So every
 * public function here must be invoked directly from a click handler, and
 * queues its utterances synchronously in one go — never via setTimeout.
 */

let voicesCache = [];
let voicesPollStarted = false;

function pollVoicesUntilReady() {
  if (voicesPollStarted) return;
  voicesPollStarted = true;
  const check = () => {
    const v = speechSynthesis.getVoices();
    if (v && v.length) voicesCache = v;
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

function pickVoice(langPrefix) {
  const match = voicesCache.find((v) => v.lang?.toLowerCase().startsWith(langPrefix));
  return match || null;
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

  stop() {
    speechSynthesis.cancel();
  },

  isSupported() {
    return typeof window !== 'undefined' && 'speechSynthesis' in window;
  }
};
