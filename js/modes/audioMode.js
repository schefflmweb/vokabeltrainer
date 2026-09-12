import { vocabStore } from '../data/vocabStore.js';
import { ttsService } from '../tts/ttsService.js';
import { syncService } from '../data/syncService.js';
import { speechInputService } from '../stt/speechInputService.js';
import { toneService } from '../audio/toneService.js';
import { audioSessionUnlock } from '../audio/audioSessionUnlock.js';
import { progressBarHtml } from '../ui/progressBar.js';
import { flagGB, flagDE } from '../ui/flags.js';
import {
  playIcon, pauseIcon, tapIcon, micIcon, warningIcon, hourglassIcon, refreshIcon, starIcon,
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
// Pause before jumping to the next card, once the translation has finished
// being spoken — and the only window during which the Stopp/Weiter button
// is active (see revealTranslation()/enterStopWindow()).
const STOP_WINDOW_MS = 2500;

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
  // Single Stopp/Weiter button state, replacing manual known/unknown rating
  // (not useful while driving — see enterStopWindow()): 'disabled' outside
  // the post-translation pause window, 'stopp' while the window is counting
  // down toward the next card, 'weiter' once the user has paused it.
  let tapPauseState = 'disabled';
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
    if (mode === 'voice') speechInputService.requestMicPermission();
    render();
  }

  function startSession() {
    if (!pendingQueue) return; // guarded by disabled button; shouldn't fire
    toneService.unlock(); // real tap — unlocks Web Audio for the rest of this session
    audioSessionUnlock.start(); // real tap — nudges iOS toward routing audio to Bluetooth (see module doc)
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
    tapPauseState = 'disabled';
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
      tapPauseState = 'disabled';
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
   * reveal speech ends, the post-translation pause (enterStopWindow) begins.
   */
  function revealTranslation(card) {
    if (currentCard() !== card || interactionMode !== 'tap') return;
    tapRevealed = true;
    render();
    const items = [{ text: secondaryText(card), lang: answerLang() }];
    if (card.example) items.push({ text: card.example, lang: 'en' });
    let windowEntered = false;
    const enterWindowOnce = () => {
      if (windowEntered) return;
      windowEntered = true;
      if (autoAdvanceTimer) {
        clearTimeout(autoAdvanceTimer);
        autoAdvanceTimer = null;
      }
      enterStopWindow(card);
    };
    ttsService.speakSequence(items, enterWindowOnce);
    // Backstop in case none of the onend callbacks fire (speech silently dropped).
    if (autoAdvanceTimer) clearTimeout(autoAdvanceTimer);
    autoAdvanceTimer = setTimeout(enterWindowOnce, TAP_AUTO_ADVANCE_BACKSTOP_MS);
  }

  /**
   * The only window during which the Stopp/Weiter button is active. Starts
   * counting down to the next card immediately; tapping "Stopp" during it
   * cancels that countdown and switches the button to "Weiter", which then
   * jumps to the next card whenever tapped (no time limit once paused).
   */
  function enterStopWindow(card) {
    if (currentCard() !== card) return;
    tapPauseState = 'stopp';
    render();
    autoAdvanceTimer = setTimeout(() => autoAdvanceTap(card), STOP_WINDOW_MS);
  }

  function handlePauseButton() {
    const card = currentCard();
    if (!card) return;
    if (tapPauseState === 'stopp') {
      if (autoAdvanceTimer) {
        clearTimeout(autoAdvanceTimer);
        autoAdvanceTimer = null;
      }
      tapPauseState = 'weiter';
      render();
    } else if (tapPauseState === 'weiter') {
      autoAdvanceTap(card);
    }
    // 'disabled': the button shouldn't be clickable at all outside the window.
  }

  function autoAdvanceTap(card) {
    if (currentCard() !== card) return;
    if (autoAdvanceTimer) {
      clearTimeout(autoAdvanceTimer);
      autoAdvanceTimer = null;
    }
    tapPauseState = 'disabled';
    rate(true); // no rating buttons anymore — every card that plays through (or is manually continued) counts as "kannte ich"
  }

  function beginListening(card) {
    if (currentCard() !== card) return; // card changed while speech was playing
    voiceState = 'listening';
    render();
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
    const expected = secondaryText(card);
    const correct = speechInputService.answersMatchAny(transcripts, expected);
    stats[correct ? 'known' : 'unknown'] += 1;
    vocabStore.markReviewed(card.id, correct);
    syncService.scheduleSync();
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
    stats[known ? 'known' : 'unknown'] += 1;
    vocabStore.markReviewed(card.id, known);
    syncService.scheduleSync();
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
          <button class="btn toggle-btn ${interactionMode === 'tap' ? 'active' : ''}" id="mode-tap"><span class="icon-inline-wrap">${tapIcon}</span> Zuhören</button>
          <button class="btn toggle-btn ${interactionMode === 'voice' ? 'active' : ''}" id="mode-voice" ${voiceSupported ? '' : 'disabled'}><span class="icon-inline-wrap">${micIcon}</span> Sprechen</button>
        </div>
        ${voiceSupported ? '' : '<p class="hint">Spracheingabe wird von diesem Browser nicht unterstützt.</p>'}
        ${interactionMode === 'voice' ? `<p class="hint"><span class="icon-inline-wrap">${warningIcon}</span> Funktioniert nur, wenn die Seite direkt in Safari geöffnet ist (nicht das installierte Icon vom Home-Bildschirm).</p>` : ''}

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
    const pauseLabel = tapPauseState === 'weiter' ? 'Weiter' : 'Stopp';
    const pauseIconHtml = tapPauseState === 'weiter' ? playIcon : pauseIcon;
    container.innerHTML = `
      <div class="audio-mode">
        ${progressBarHtml(index, queue.length)}
        <div class="card-display">
          <div class="card-primary">${escapeHtml(primaryText(card))}</div>
          <div class="card-secondary ${tapRevealed ? '' : 'reveal-pending'}">${secondaryHtml}</div>
        </div>
        <button class="btn btn-secondary btn-with-icon" id="replay-btn"><span class="icon-inline-wrap">${speakerIcon}</span> Nochmal anhören</button>
        <button class="btn btn-huge btn-primary btn-with-icon" id="pause-btn" ${tapPauseState === 'disabled' ? 'disabled' : ''}>
          <span class="icon-inline-wrap icon-lg">${pauseIconHtml}</span> ${pauseLabel}
        </button>
      </div>`;

    container.querySelector('#replay-btn').addEventListener('click', replay);
    container.querySelector('#pause-btn').addEventListener('click', handlePauseButton);
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
