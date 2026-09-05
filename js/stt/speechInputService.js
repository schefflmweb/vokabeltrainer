/**
 * Wraps SpeechRecognition/webkitSpeechRecognition. Only reliably available in
 * a plain Safari tab on iOS — it does not work inside an installed
 * home-screen (standalone) PWA, a known Apple/WebKit limitation with no
 * workaround from the web app side. Callers should surface that clearly
 * rather than silently failing.
 */

const RecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

function normalize(str) {
  return str.trim().toLowerCase().replace(/[.,!?;:]+$/g, '');
}

export const speechInputService = {
  isSupported() {
    return !!RecognitionCtor;
  },

  answersMatch(transcript, expected) {
    return !!transcript && normalize(transcript) === normalize(expected);
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
   * onResult/onTimeout/onError. `timeoutMs` covers both true silence and the
   * (fairly common) case where recognition just never produces a result.
   * Returns a handle with stop() to cancel early.
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
    recognition.maxAlternatives = 1;

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
      const transcript = event.results?.[0]?.[0]?.transcript || '';
      finish(onResult, transcript);
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
