/**
 * Wraps SpeechRecognition/webkitSpeechRecognition. Only reliably available in
 * a plain Safari tab on iOS — it does not work inside an installed
 * home-screen (standalone) PWA, a known Apple/WebKit limitation with no
 * workaround from the web app side. Callers should surface that clearly
 * rather than silently failing.
 */

import { answersMatch, getAlternatives, normalize, fuzzyMatchesAny } from '../util/answerMatch.js';

const RecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
const MAX_ALTERNATIVES = 5;

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
   * those hit does it fall back to the same small edit-distance tolerance
   * used for typed answers (see util/answerMatch.js) — checked across every
   * candidate transcript, since mishearing a letter or two is common STT
   * noise and the right word often isn't the top-ranked candidate.
   */
  answersMatchAny(transcripts, expected) {
    if (!expected) return false;
    const alternatives = getAlternatives(expected);
    const given = (transcripts || []).filter(Boolean).map(normalize);
    if (given.length === 0) return false;
    if (given.some((g) => alternatives.includes(g))) return true;
    return given.some((g) => fuzzyMatchesAny(g, alternatives));
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
