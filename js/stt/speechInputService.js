/**
 * Wraps SpeechRecognition/webkitSpeechRecognition. Only reliably available in
 * a plain Safari tab on iOS — it does not work inside an installed
 * home-screen (standalone) PWA, a known Apple/WebKit limitation with no
 * workaround from the web app side. Callers should surface that clearly
 * rather than silently failing.
 */

import { answersMatch, getAlternatives, normalize } from '../util/answerMatch.js';

const RecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
const MAX_ALTERNATIVES = 5;

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  return dp[n];
}

/**
 * No tolerance at all for short words: German has plenty of minimal pairs a
 * single edit apart (Haus/Maus, Bein/Wein, ...), so being lenient there risks
 * accepting a genuinely wrong but similar-sounding word. Fuzziness only kicks
 * in for longer words/phrases, where a stray extra letter or substitution is
 * much more likely to be real STT noise than a flip to a different real word.
 */
function fuzzyThreshold(word) {
  if (word.length <= 6) return 0;
  return word.length <= 10 ? 1 : 2;
}

export const speechInputService = {
  isSupported() {
    return !!RecognitionCtor;
  },

  /** Accepts a match against any one of several synonyms listed in `expected` — see util/answerMatch.js. */
  answersMatch(transcript, expected) {
    return answersMatch(transcript, expected);
  },

  /**
   * Checks every recognition candidate (best-first, from maxAlternatives —
   * speech engines frequently rank the correct word 2nd or 3rd) against
   * every synonym in `expected`. Tries exact matches first; only if none of
   * those hit does it fall back to a small edit-distance tolerance, since
   * mishearing a letter or two is a common, expected kind of STT noise —
   * distinct from Quiz's typed answers, where exact spelling still matters.
   */
  answersMatchAny(transcripts, expected) {
    if (!expected) return false;
    const alternatives = getAlternatives(expected);
    const given = (transcripts || []).filter(Boolean).map(normalize);
    if (given.length === 0) return false;
    if (given.some((g) => alternatives.includes(g))) return true;
    return given.some((g) => alternatives.some((alt) => levenshtein(g, alt) <= fuzzyThreshold(alt)));
  },

  /** One-shot mic permission request, meant to be called directly from a tap so any OS prompt is allowed to appear. */
  async requestMicPermission() {
    if (!navigator.mediaDevices?.getUserMedia) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      // Surfaces again as a real error when listen() is actually used.
    }
  },

  /**
   * Starts a single listening attempt. Resolves via exactly one of
   * onResult/onTimeout/onError. onResult gets an array of candidate
   * transcripts (best-first) rather than a single string — see
   * answersMatchAny(). `timeoutMs` covers both true silence and the (fairly
   * common) case where recognition just never produces a result. Returns a
   * handle with stop() to cancel early.
   */
  listen({ lang, timeoutMs = 5000, onResult, onTimeout, onError }) {
    if (!RecognitionCtor) {
      onError?.('unsupported');
      return { stop() {} };
    }

    const recognition = new RecognitionCtor();
    recognition.lang = lang;
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = MAX_ALTERNATIVES;

    let settled = false;
    const finish = (fn, ...args) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn?.(...args);
    };

    const timer = setTimeout(() => {
      try { recognition.stop(); } catch {}
      finish(onTimeout);
    }, timeoutMs);

    recognition.onresult = (event) => {
      const result = event.results?.[0];
      const transcripts = result ? Array.from(result).map((r) => r.transcript) : [];
      finish(onResult, transcripts);
    };

    recognition.onerror = (event) => {
      if (event.error === 'no-speech') {
        finish(onTimeout);
      } else {
        finish(onError, event.error);
      }
    };

    recognition.onend = () => finish(onTimeout);

    try {
      recognition.start();
    } catch (err) {
      finish(onError, err?.message || 'start-failed');
    }

    return {
      stop() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { recognition.stop(); } catch {}
      }
    };
  }
};
