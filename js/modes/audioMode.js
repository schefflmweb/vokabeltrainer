import { vocabStore } from '../data/vocabStore.js';
import { ttsService } from '../tts/ttsService.js';
import { syncService } from '../data/syncService.js';
import { speechInputService } from '../stt/speechInputService.js';
import { toneService } from '../audio/toneService.js';
import { audioSessionUnlock } from '../audio/audioSessionUnlock.js';
import { progressBarHtml } from '../ui/progressBar.js';
import { flagGB, flagDE } from '../ui/flags.js';
import {
  playIcon, tapIcon, micIcon, warningIcon, hourglassIcon, refreshIcon, starIcon,
  thinkingIcon, speakerIcon, xCircleIcon, checkCircleIcon, errorIcon, skipIcon
} from '../ui/icons.js';

const SESSION_SIZE = 15;
const LISTEN_TIMEOUT_MS = 8000;
const REVEAL_DELAY_MS = 3000;
const AUTO_ADVANCE_DELAY_MS = 800;
const TAP_AUTO_ADVANCE_BACKSTOP_MS = 6000;
// Backstop for the primary word's speakOnce() onEnd, in case it never fires
// (speech silently dropped) — same reasoning as the other best-effort speech
// chains in this file. Generous, since a real long word/phrase should still
// finish speaking well within it.
const PRIMARY_SPEECH_BACKSTOP_MS = 4000;
// Pause after the translation finishes speaking, before auto-advancing to
// the next card — and the window in which a spoken "Stop" is listened for.
// Originally 2000; on-device testing showed "Stopp" never got recognized in
// that window at all (not even close — always "Nichts gehört"), and voice
// mode's own answer-listening (which works) uses an 8s window — iOS's
// recognizer needs real time just to start up before it's even capturing,
// so 2s may have simply never left it enough room. Bumped to 4000 as a
// compromise: still a short pause when nothing is said, but with a real
// chance of actually hearing "Stop" if it's said promptly.
const STOP_LISTEN_WINDOW_MS = 4000;
const STOP_WORDS = ['stop', 'stopp'];
const RESUME_WORDS = ['weiter'];
// How long the "Gehört: ..." / "Nichts gehört" status stays on screen before
// advancing — a real (not just debug) glance-at-the-screen confirmation of
// what the mic picked up, but also directly diagnostic: if this shows real
// recognized words for other speech, "Stop" not registering is a wording/
// matching issue; if it always shows "Nichts gehört", the mic likely isn't
// capturing anything at all in this window.
const LISTEN_RESULT_PAUSE_MS = 1200;
// Buffer before starting a new recognition session right after a previous
// one just ended (entering the pause, and each re-arm of the "Weiter" loop)
// — "Stop" working but "Weiter" not, right after, pointed at back-to-back
// recognition starts not giving iOS enough time to release the previous
// session first.
const RESUME_LISTEN_RESTART_DELAY_MS = 500;

function normalizeCommand(str) {
  return str.trim().toLowerCase().replace(/[.,!?;:]+$/g, '');
}

/** True if any recognition candidate (best-first) matches one of `keywords` exactly. */
function matchesCommand(transcripts, keywords) {
  return (transcripts || []).some((t) => keywords.includes(normalizeCommand(t)));
}

export function mount(container) {
  let direction = 'en-de'; // 'en-de' | 'de-en'
  let interactionMode = 'tap'; // 'tap' | 'voice'
  let phase = 'select'; // 'select' | 'active' | 'finished'
  let queue = [];
  let index = -1;
  let stats = { known: 0, unknown: 0 };

  // Voice-mode per-card state
  let voiceState = 'idle'; // 'speaking' | 'listening' | 'result' | 'error'
  let voiceResult = null; // { transcript, correct, expected }
  let voiceErrorMessage = '';
  let activeListen = null;
  let pendingAdvance = false; // guards against double-advance (auto + manual "Weiter" tap racing)
  let autoAdvanceTimer = null;

  // Tap-mode per-card state: translation is hidden for a few seconds to give
  // room for active recall before it's shown/spoken.
  let tapRevealed = false;
  let tapRevealTimer = null;
  // True while waiting for a spoken "Weiter" after the user said "Stop"
  // during the post-translation pause — see afterTranslationSpoken().
  let tapPaused = false;
  // Live status for the "Stop" detection window: null | 'listening' |
  // { kind: 'heard'|'silence'|'error', text? } — see afterTranslationSpoken().
  let tapListenState = null;
  function clearRevealTimer() {
    if (tapRevealTimer) {
      clearTimeout(tapRevealTimer);
      tapRevealTimer = null;
    }
  }

  // Backstop for the primary word's speakOnce() — see enterCard().
  let primarySpeechTimer = null;
  function clearPrimarySpeechTimer() {
    if (primarySpeechTimer) {
      clearTimeout(primarySpeechTimer);
      primarySpeechTimer = null;
    }
  }

  // iOS Safari only allows speechSynthesis.speak() when called synchronously
  // inside the tap handler — so the next round's due-list is always fetched
  // ahead of time, and the "Los geht's" / "Neue Runde" tap never awaits
  // anything before it calls speakCard()/speakOnce().
  let pendingQueue = null;
  function prefetchQueue() {
    pendingQueue = null;
    vocabStore.getDue(SESSION_SIZE).then((q) => {
      pendingQueue = q;
      if (phase === 'select' || phase === 'finished') render();
    });
  }

  function currentCard() {
    return index >= 0 && index < queue.length ? queue[index] : null;
  }

  function primaryText(card) {
    return direction === 'de-en' ? card.de : card.en;
  }

  function secondaryText(card) {
    return direction === 'de-en' ? card.en : card.de;
  }

  function promptLang() {
    return direction === 'de-en' ? 'de' : 'en';
  }

  function answerLang() {
    return direction === 'de-en' ? 'en' : 'de';
  }

  function setDirection(dir) {
    direction = dir;
    render();
  }

  function setInteractionMode(mode) {
    interactionMode = mode;
    // Both modes may use the mic now: voice mode for the answer itself,
    // tap mode for the "Stop"/"Weiter" pause commands (see
    // afterTranslationSpoken()).
    speechInputService.requestMicPermission();
    render();
  }

  function startSession() {
    if (!pendingQueue) return; // guarded by disabled button; shouldn't fire
    toneService.unlock(); // real tap — unlocks Web Audio for the rest of this session
    audioSessionUnlock.start(); // real tap — nudges iOS toward routing audio to Bluetooth (see module doc)
    // Also request mic permission here, not just from the tap/voice toggle
    // in setInteractionMode(): tap mode is the default, so a user who never
    // touches that toggle would otherwise never trigger a permission prompt
    // from a real tap at all — leaving the *first* mic access attempt to
    // happen deep in an async chain (afterTranslationSpoken), where iOS may
    // silently refuse to grant it. This was very likely why "Stop" was never
    // heard regardless of how long the listen window was.
    speechInputService.requestMicPermission();
    queue = pendingQueue;
    index = 0;
    stats = { known: 0, unknown: 0 };
    phase = queue.length > 0 ? 'active' : 'finished';
    prefetchQueue(); // load next round's due-list in the background
    enterCard();
  }

  function backToSelect() {
    clearRevealTimer();
    clearPrimarySpeechTimer();
    if (autoAdvanceTimer) {
      clearTimeout(autoAdvanceTimer);
      autoAdvanceTimer = null;
    }
    activeListen?.stop();
    activeListen = null;
    tapPaused = false;
    tapListenState = null;
    phase = 'select';
    render();
  }

  /** Called synchronously from a tap (start / next-card button) — speaks the current card and, in voice mode, chains into listening once speech ends. */
  function enterCard() {
    pendingAdvance = false;
    if (autoAdvanceTimer) {
      clearTimeout(autoAdvanceTimer);
      autoAdvanceTimer = null;
    }
    const card = currentCard();
    if (!card) {
      render();
      return;
    }
    if (interactionMode === 'tap') {
      tapRevealed = false;
      tapPaused = false;
      tapListenState = null;
      render();
      clearRevealTimer();
      clearPrimarySpeechTimer();
      // Thinking time (REVEAL_DELAY_MS) is meant to start once the word has
      // actually finished being spoken — not the moment speak() was called,
      // which would cut it short (or start the reveal mid-word) for longer
      // words. onEnd fires when playback genuinely finishes; the backstop
      // covers the case where it silently never fires at all.
      let revealStarted = false;
      const startReveal = () => {
        if (revealStarted) return;
        revealStarted = true;
        clearPrimarySpeechTimer();
        if (currentCard() !== card) return; // card changed while speech was playing
        tapRevealTimer = setTimeout(() => revealTranslation(card), REVEAL_DELAY_MS);
      };
      ttsService.speakOnce(primaryText(card), promptLang(), { onEnd: startReveal });
      primarySpeechTimer = setTimeout(startReveal, PRIMARY_SPEECH_BACKSTOP_MS);
      return;
    }

    voiceState = 'speaking';
    voiceResult = null;
    voiceErrorMessage = '';
    render();
    ttsService.speakOnce(primaryText(card), promptLang(), {
      onEnd: () => beginListening(card)
    });
  }

  /**
   * Fires ~3s after a tap-mode card starts. This speak call is NOT triggered
   * synchronously from a tap (it's a setTimeout callback), which iOS Safari's
   * autoplay policy can silently drop — best-effort only. The translation is
   * always shown as text regardless, and "Nochmal anhören" lets the user
   * trigger it manually (a real tap) if the auto-speak didn't play. Once the
   * reveal speech ends, the card auto-advances (counted as "kannte ich")
   * unless the user already tapped ✅/❌ themselves.
   */
  function revealTranslation(card) {
    if (currentCard() !== card || interactionMode !== 'tap') return;
    tapRevealed = true;
    render();
    const items = [{ text: secondaryText(card), lang: answerLang() }];
    if (card.example) items.push({ text: card.example, lang: 'en' });
    ttsService.speakSequence(items, () => afterTranslationSpoken(card));
    // Backstop in case none of the onend callbacks fire (speech silently dropped).
    if (autoAdvanceTimer) clearTimeout(autoAdvanceTimer);
    autoAdvanceTimer = setTimeout(() => afterTranslationSpoken(card), TAP_AUTO_ADVANCE_BACKSTOP_MS);
  }

  /**
   * Runs once the translation (+ example) has finished being spoken, or the
   * backstop above fired instead. Gives a short pause (STOP_LISTEN_WINDOW_MS)
   * before auto-advancing — during which a spoken "Stop" pauses the advance
   * until "Weiter" is heard (or a rate button is tapped, always available as
   * a manual override). Falls back to a plain timed pause with no listening
   * if speech recognition isn't supported (e.g. the installed home-screen
   * PWA — see speechInputService's module doc).
   */
  function afterTranslationSpoken(card) {
    if (currentCard() !== card) return;
    if (autoAdvanceTimer) {
      clearTimeout(autoAdvanceTimer);
      autoAdvanceTimer = null;
    }
    if (!speechInputService.isSupported()) {
      autoAdvanceTimer = setTimeout(() => autoAdvanceTap(card), STOP_LISTEN_WINDOW_MS);
      return;
    }
    // audioSessionUnlock's silent loop (see its module doc) is meant to nudge
    // iOS toward a *playback* audio session for Bluetooth routing — but a
    // real microphone capture needs a *recording*-capable session, and the
    // two can starve each other. Pausing the loop while genuinely listening
    // (resumed the moment listening ends, in every branch below) avoids that
    // conflict.
    audioSessionUnlock.stop();
    tapListenState = 'listening-stop';
    render();
    activeListen = speechInputService.listen({
      lang: 'de-DE', // "Stop"/"Weiter" are said in German regardless of card direction
      timeoutMs: STOP_LISTEN_WINDOW_MS,
      onResult: (transcripts) => {
        activeListen = null;
        if (currentCard() !== card) { audioSessionUnlock.start(); return; }
        if (matchesCommand(transcripts, STOP_WORDS)) {
          enterPaused(card); // keeps listening — audioSessionUnlock stays paused until resumed
        } else {
          audioSessionUnlock.start();
          tapListenState = { kind: 'heard', text: transcripts?.[0] || '' };
          render();
          autoAdvanceTimer = setTimeout(() => { tapListenState = null; autoAdvanceTap(card); }, LISTEN_RESULT_PAUSE_MS);
        }
      },
      onTimeout: () => {
        activeListen = null;
        audioSessionUnlock.start();
        tapListenState = { kind: 'silence' };
        render();
        autoAdvanceTimer = setTimeout(() => { tapListenState = null; autoAdvanceTap(card); }, LISTEN_RESULT_PAUSE_MS);
      },
      onError: (err) => {
        activeListen = null;
        audioSessionUnlock.start();
        tapListenState = { kind: 'error', text: err };
        render();
        autoAdvanceTimer = setTimeout(() => { tapListenState = null; autoAdvanceTap(card); }, LISTEN_RESULT_PAUSE_MS);
      }
    });
  }

  function enterPaused(card) {
    if (currentCard() !== card) return;
    tapPaused = true;
    tapListenState = null;
    render();
    // A short buffer before starting the next recognition session — starting
    // one immediately back-to-back with the "Stop" session that just ended
    // may not give iOS enough time to tear the previous one down first.
    setTimeout(() => {
      if (tapPaused && currentCard() === card) listenForResume(card);
    }, RESUME_LISTEN_RESTART_DELAY_MS);
  }

  /** Re-arms listening in a loop (a single listen() call times out after LISTEN_TIMEOUT_MS) until "Weiter" is heard or the pause is left some other way. */
  function listenForResume(card) {
    if (currentCard() !== card || !tapPaused) return;
    audioSessionUnlock.stop(); // see afterTranslationSpoken() — kept paused for the whole "waiting for Weiter" loop
    tapListenState = 'listening-weiter';
    render();
    activeListen = speechInputService.listen({
      lang: 'de-DE',
      timeoutMs: LISTEN_TIMEOUT_MS,
      onResult: (transcripts) => {
        activeListen = null;
        if (currentCard() !== card || !tapPaused) { audioSessionUnlock.start(); return; }
        if (matchesCommand(transcripts, RESUME_WORDS)) {
          tapListenState = null;
          resumeFromPause(card); // resumes audioSessionUnlock itself
        } else {
          tapListenState = { kind: 'heard', text: transcripts?.[0] || '' };
          render();
          setTimeout(() => {
            if (tapPaused && currentCard() === card) listenForResume(card); // not "Weiter" — keep listening
          }, RESUME_LISTEN_RESTART_DELAY_MS);
        }
      },
      onTimeout: () => {
        activeListen = null;
        tapListenState = { kind: 'silence' };
        render();
        setTimeout(() => {
          if (tapPaused && currentCard() === card) listenForResume(card); // keep listening — no time limit on the pause itself
        }, RESUME_LISTEN_RESTART_DELAY_MS);
      },
      onError: (err) => {
        activeListen = null;
        audioSessionUnlock.start();
        tapListenState = { kind: 'error', text: err };
        render();
        // Stop retrying on a real error (e.g. permission revoked) rather than
        // looping forever — the rate buttons remain as a manual way onward.
      }
    });
  }

  function resumeFromPause(card) {
    if (currentCard() !== card) return;
    tapPaused = false;
    audioSessionUnlock.start();
    render();
    autoAdvanceTap(card);
  }

  function autoAdvanceTap(card) {
    if (currentCard() !== card) return;
    if (autoAdvanceTimer) {
      clearTimeout(autoAdvanceTimer);
      autoAdvanceTimer = null;
    }
    rate(true); // no explicit tap -> counts as "kannte ich" per user's choice
  }

  function beginListening(card) {
    if (currentCard() !== card) return; // card changed while speech was playing
    voiceState = 'listening';
    render();
    audioSessionUnlock.stop(); // see afterTranslationSpoken() — a competing silent playback loop can starve real mic capture
    activeListen = speechInputService.listen({
      lang: answerLang() === 'de' ? 'de-DE' : 'en-US',
      timeoutMs: LISTEN_TIMEOUT_MS,
      onResult: (transcripts) => handleVoiceResult(card, transcripts),
      onTimeout: () => handleVoiceResult(card, []),
      onError: (err) => handleVoiceError(card, err)
    });
  }

  /** transcripts: array of recognition candidates, best-first (see speechInputService.listen). */
  function handleVoiceResult(card, transcripts) {
    if (currentCard() !== card) return;
    activeListen = null;
    audioSessionUnlock.start();
    const expected = secondaryText(card);
    const correct = speechInputService.answersMatchAny(transcripts, expected);
    stats[correct ? 'known' : 'unknown'] += 1;
    vocabStore.markReviewed(card.id, correct);
    syncService.sync();
    voiceResult = { transcript: transcripts?.[0] || '', correct, expected };
    voiceState = 'result';
    render();

    // Fully hands-free by default: a tone plays (reliable, unlocked once at
    // session start) and the round auto-advances. The "Weiter"/"Antwort
    // anhören" buttons stay in the UI as a manual alternative — guarded by
    // pendingAdvance so a tap and the automatic path can't both fire.
    if (correct) {
      toneService.playCorrect();
      autoAdvanceTimer = setTimeout(() => advanceCard(), AUTO_ADVANCE_DELAY_MS);
    } else {
      toneService.playIncorrect();
      // Wait for the tone to finish before speaking — Web Audio and
      // speechSynthesis share no clock, so starting both at once played them
      // on top of each other instead of one after the other.
      setTimeout(() => {
        // Best-effort speech — the correct answer is also always shown as text.
        ttsService.speakOnce(expected, answerLang(), { onEnd: () => advanceCard() });
      }, toneService.DURATION_MS);
      // Backstop in case onEnd never fires (e.g. speech silently dropped).
      autoAdvanceTimer = setTimeout(() => advanceCard(), toneService.DURATION_MS + LISTEN_TIMEOUT_MS);
    }
  }

  function handleVoiceError(card, err) {
    if (currentCard() !== card) return;
    activeListen = null;
    audioSessionUnlock.start();
    voiceState = 'error';
    voiceErrorMessage = err === 'not-allowed'
      ? 'Mikrofon-Zugriff verweigert. Bitte in den Safari-Website-Einstellungen erlauben.'
      : 'Spracherkennung war gerade nicht verfügbar.';
    render();
  }

  function retryListening() {
    const card = currentCard();
    if (card) beginListening(card);
  }

  function skipListening() {
    const card = currentCard();
    if (card) {
      activeListen?.stop();
      activeListen = null;
      handleVoiceResult(card, []);
    }
  }

  function advanceCard() {
    if (pendingAdvance) return; // already advanced (auto path and manual tap raced)
    pendingAdvance = true;
    index += 1;
    phase = currentCard() ? 'active' : 'finished';
    if (phase === 'active') {
      enterCard(); // resets pendingAdvance for the new card
    } else {
      prefetchQueue();
      render();
    }
  }

  function rate(known) {
    if (pendingAdvance) return; // already advanced (auto path and manual tap raced)
    pendingAdvance = true;
    const card = currentCard();
    if (!card) return;
    clearRevealTimer();
    clearPrimarySpeechTimer();
    if (autoAdvanceTimer) {
      clearTimeout(autoAdvanceTimer);
      autoAdvanceTimer = null;
    }
    activeListen?.stop(); // manual rate overrides any pending "Stop"/"Weiter" listening
    activeListen = null;
    audioSessionUnlock.start(); // in case a pending listen had it paused (see afterTranslationSpoken())
    tapPaused = false;
    tapListenState = null;
    stats[known ? 'known' : 'unknown'] += 1;
    vocabStore.markReviewed(card.id, known);
    syncService.sync();
    index += 1;
    if (currentCard()) {
      phase = 'active';
      enterCard(); // resets pendingAdvance for the new card
    } else {
      phase = 'finished';
      prefetchQueue();
      render();
    }
  }

  function replay() {
    const card = currentCard();
    if (!card) return;
    if (interactionMode === 'tap') {
      if (tapRevealed) {
        ttsService.speakCard(card, direction);
      } else {
        ttsService.speakOnce(primaryText(card), promptLang());
      }
    } else if (voiceState === 'result') {
      ttsService.speakOnce(voiceResult.expected, answerLang());
    }
  }

  function render() {
    if (!ttsService.isSupported()) {
      container.innerHTML = `<div class="pad"><p class="hint">Sprachausgabe wird auf diesem Gerät nicht unterstützt.</p></div>`;
      return;
    }
    if (phase === 'select') return renderSelect();
    if (phase === 'finished') return renderFinished();
    return interactionMode === 'voice' ? renderVoiceActive() : renderTapActive();
  }

  function renderSelect() {
    const ready = !!pendingQueue;
    const voiceSupported = speechInputService.isSupported();
    container.innerHTML = `
      <div class="audio-mode pad center-text">
        <p class="hint">Übungsrichtung</p>
        <div class="direction-toggle">
          <button class="btn toggle-btn ${direction === 'en-de' ? 'active' : ''}" id="dir-en-de">${flagGB} → ${flagDE} Englisch → Deutsch</button>
          <button class="btn toggle-btn ${direction === 'de-en' ? 'active' : ''}" id="dir-de-en">${flagDE} → ${flagGB} Deutsch → Englisch</button>
        </div>

        <p class="hint">Eingabeart</p>
        <div class="direction-toggle">
          <button class="btn toggle-btn ${interactionMode === 'tap' ? 'active' : ''}" id="mode-tap"><span class="icon-inline-wrap">${tapIcon}</span> Vorlesen & Nachdenken</button>
          <button class="btn toggle-btn ${interactionMode === 'voice' ? 'active' : ''}" id="mode-voice" ${voiceSupported ? '' : 'disabled'}><span class="icon-inline-wrap">${micIcon}</span> Sprechen</button>
        </div>
        ${voiceSupported ? '' : '<p class="hint">Spracheingabe wird von diesem Browser nicht unterstützt.</p>'}
        ${interactionMode === 'voice' ? `<p class="hint"><span class="icon-inline-wrap">${warningIcon}</span> Funktioniert nur, wenn die Seite direkt in Safari geöffnet ist (nicht das installierte Icon vom Home-Bildschirm).</p>` : ''}
        ${interactionMode === 'tap' && voiceSupported ? `<p class="hint"><span class="icon-inline-wrap">${micIcon}</span> Nach der Lösung: Sag "Stop" zum Pausieren, "Weiter" zum Fortfahren.</p>` : ''}

        <p class="hint">Auto-Modus: pro Karte ein großer Tap. Kein Hinsehen nötig.</p>
        <button class="btn btn-huge mode-choice-btn btn-primary btn-with-icon" id="start-btn" ${ready ? '' : 'disabled'}>
          <span class="icon-inline-wrap icon-lg">${ready ? playIcon : hourglassIcon}</span>
          <span>${ready ? "Los geht's" : 'Lädt …'}</span>
        </button>
      </div>`;
    container.querySelector('#dir-en-de').addEventListener('click', () => setDirection('en-de'));
    container.querySelector('#dir-de-en').addEventListener('click', () => setDirection('de-en'));
    container.querySelector('#mode-tap').addEventListener('click', () => setInteractionMode('tap'));
    container.querySelector('#mode-voice').addEventListener('click', () => setInteractionMode('voice'));
    container.querySelector('#start-btn').addEventListener('click', startSession);
  }

  function renderFinished() {
    const ready = !!pendingQueue;
    container.innerHTML = `
      <div class="audio-mode pad center">
        <h2 class="btn-with-icon"><span class="icon-inline-wrap icon-lg">${starIcon}</span> Runde fertig!</h2>
        <p class="hint">${stats.known} gewusst · ${stats.unknown} nochmal üben</p>
        <button class="btn btn-huge btn-primary btn-with-icon" id="again-btn" ${ready ? '' : 'disabled'}>
          ${ready
            ? `<span class="icon-inline-wrap icon-lg">${refreshIcon}</span> Neue Runde`
            : `<span class="icon-inline-wrap icon-lg">${hourglassIcon}</span> Lädt …`}
        </button>
        <button class="btn btn-secondary" id="switch-btn">Modus wechseln</button>
      </div>`;
    container.querySelector('#again-btn').addEventListener('click', startSession);
    container.querySelector('#switch-btn').addEventListener('click', backToSelect);
  }

  function renderTapActive() {
    const card = currentCard();
    const secondaryHtml = tapRevealed
      ? escapeHtml(secondaryText(card))
      : `<span class="icon-inline-wrap">${thinkingIcon}</span> Zeit zum Nachdenken …`;
    let statusHtml = '';
    if (tapListenState === 'listening-stop') {
      statusHtml = `<p class="hint mic-status btn-with-icon"><span class="icon-inline-wrap">${micIcon}</span> Höre auf "Stop" …</p>`;
    } else if (tapListenState === 'listening-weiter') {
      statusHtml = `<p class="hint mic-status btn-with-icon"><span class="icon-inline-wrap">${micIcon}</span> Pausiert – höre auf "Weiter" …</p>`;
    } else if (tapListenState?.kind === 'heard') {
      statusHtml = `<p class="hint mic-status btn-with-icon"><span class="icon-inline-wrap">${micIcon}</span> Gehört: "${escapeHtml(tapListenState.text) || '–'}"</p>`;
    } else if (tapListenState?.kind === 'silence') {
      statusHtml = `<p class="hint mic-status btn-with-icon"><span class="icon-inline-wrap">${micIcon}</span> Nichts gehört.</p>`;
    } else if (tapListenState?.kind === 'error') {
      statusHtml = `<p class="hint mic-status btn-with-icon"><span class="icon-inline-wrap">${errorIcon}</span> Mikrofon-Fehler: ${escapeHtml(tapListenState.text || '')}</p>`;
    } else if (tapPaused) {
      statusHtml = `<p class="hint mic-status btn-with-icon"><span class="icon-inline-wrap">${micIcon}</span> Pausiert – sag "Weiter" oder tippe eine Antwort.</p>`;
    }
    container.innerHTML = `
      <div class="audio-mode">
        ${progressBarHtml(index, queue.length)}
        <div class="card-display">
          <div class="card-primary">${escapeHtml(primaryText(card))}</div>
          <div class="card-secondary ${tapRevealed ? '' : 'reveal-pending'}">${secondaryHtml}</div>
        </div>
        ${statusHtml}
        <button class="btn btn-secondary btn-with-icon" id="replay-btn"><span class="icon-inline-wrap">${speakerIcon}</span> Nochmal anhören</button>
        <div class="rate-buttons">
          <button class="btn btn-huge btn-danger btn-with-icon" id="unknown-btn"><span class="icon-inline-wrap icon-lg">${xCircleIcon}</span> Nochmal üben</button>
          <button class="btn btn-huge btn-success btn-with-icon" id="known-btn"><span class="icon-inline-wrap icon-lg">${checkCircleIcon}</span> Kannte ich</button>
        </div>
      </div>`;

    container.querySelector('#replay-btn').addEventListener('click', replay);
    container.querySelector('#unknown-btn').addEventListener('click', () => rate(false));
    container.querySelector('#known-btn').addEventListener('click', () => rate(true));
  }

  function renderVoiceActive() {
    const card = currentCard();

    if (voiceState === 'speaking') {
      container.innerHTML = `
        <div class="audio-mode">
          ${progressBarHtml(index, queue.length)}
          <div class="card-display">
            <div class="card-primary">${escapeHtml(primaryText(card))}</div>
          </div>
          <p class="hint mic-status btn-with-icon"><span class="icon-inline-wrap icon-lg">${speakerIcon}</span> Wort wird vorgelesen …</p>
        </div>`;
      return;
    }

    if (voiceState === 'listening') {
      container.innerHTML = `
        <div class="audio-mode">
          ${progressBarHtml(index, queue.length)}
          <div class="card-display">
            <div class="card-primary">${escapeHtml(primaryText(card))}</div>
          </div>
          <p class="hint mic-status btn-with-icon"><span class="icon-inline-wrap icon-lg">${micIcon}</span> Höre zu … jetzt sprechen!</p>
          <button class="btn btn-secondary btn-with-icon" id="skip-btn"><span class="icon-inline-wrap">${skipIcon}</span> Überspringen</button>
        </div>`;
      container.querySelector('#skip-btn').addEventListener('click', skipListening);
      return;
    }

    if (voiceState === 'error') {
      container.innerHTML = `
        <div class="audio-mode">
          ${progressBarHtml(index, queue.length)}
          <div class="card-display">
            <div class="card-primary">${escapeHtml(primaryText(card))}</div>
          </div>
          <p class="hint btn-with-icon"><span class="icon-inline-wrap">${errorIcon}</span> ${escapeHtml(voiceErrorMessage)}</p>
          <button class="btn btn-secondary btn-with-icon" id="retry-btn"><span class="icon-inline-wrap">${micIcon}</span> Erneut versuchen</button>
          <button class="btn btn-huge btn-primary btn-with-icon" id="next-btn">Weiter <span class="icon-inline-wrap icon-lg">${playIcon}</span></button>
        </div>`;
      container.querySelector('#retry-btn').addEventListener('click', retryListening);
      container.querySelector('#next-btn').addEventListener('click', advanceCard);
      return;
    }

    // voiceState === 'result'
    const { transcript, correct, expected } = voiceResult;
    const resultIcon = correct ? checkCircleIcon : xCircleIcon;
    container.innerHTML = `
      <div class="audio-mode">
        ${progressBarHtml(index, queue.length)}
        <div class="card-display ${correct ? 'pulse-correct' : 'shake-incorrect'}">
          <div class="card-primary">${escapeHtml(primaryText(card))}</div>
        </div>
        <p class="typing-answer ${correct ? 'correct' : 'incorrect'}">${escapeHtml(transcript) || '(keine Antwort erkannt)'}</p>
        <p class="hint btn-with-icon"><span class="icon-inline-wrap">${resultIcon}</span> ${correct ? 'Richtig!' : `Richtig wäre: ${escapeHtml(expected)}`}</p>
        <button class="btn btn-secondary btn-with-icon" id="replay-btn"><span class="icon-inline-wrap">${speakerIcon}</span> Antwort anhören</button>
        <button class="btn btn-huge btn-primary btn-with-icon" id="next-btn">Weiter <span class="icon-inline-wrap icon-lg">${playIcon}</span></button>
      </div>`;
    container.querySelector('#replay-btn').addEventListener('click', replay);
    container.querySelector('#next-btn').addEventListener('click', advanceCard);
  }

  prefetchQueue();
  render();

  return () => {
    clearRevealTimer();
    clearPrimarySpeechTimer();
    if (autoAdvanceTimer) clearTimeout(autoAdvanceTimer);
    activeListen?.stop();
    ttsService.stop();
    audioSessionUnlock.stop();
  };
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
