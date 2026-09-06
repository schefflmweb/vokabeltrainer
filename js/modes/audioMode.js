import { vocabStore } from '../data/vocabStore.js';
import { ttsService } from '../tts/ttsService.js';
import { syncService } from '../data/syncService.js';
import { speechInputService } from '../stt/speechInputService.js';
import { toneService } from '../audio/toneService.js';
import { progressBarHtml } from '../ui/progressBar.js';
import { flagGB, flagDE } from '../ui/flags.js';
import {
  playIcon, tapIcon, micIcon, warningIcon, hourglassIcon, refreshIcon, starIcon,
  thinkingIcon, speakerIcon, xCircleIcon, checkCircleIcon, errorIcon, skipIcon
} from '../ui/icons.js';

const SESSION_SIZE = 15;
const LISTEN_TIMEOUT_MS = 5000;
const REVEAL_DELAY_MS = 3000;
const AUTO_ADVANCE_DELAY_MS = 800;
const TAP_AUTO_ADVANCE_BACKSTOP_MS = 6000;

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
  function clearRevealTimer() {
    if (tapRevealTimer) {
      clearTimeout(tapRevealTimer);
      tapRevealTimer = null;
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
    queue = pendingQueue;
    index = 0;
    stats = { known: 0, unknown: 0 };
    phase = queue.length > 0 ? 'active' : 'finished';
    prefetchQueue(); // load next round's due-list in the background
    enterCard();
  }

  function backToSelect() {
    clearRevealTimer();
    if (autoAdvanceTimer) {
      clearTimeout(autoAdvanceTimer);
      autoAdvanceTimer = null;
    }
    activeListen?.stop();
    activeListen = null;
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
      render();
      ttsService.speakOnce(primaryText(card), promptLang()); // only the source word for now
      clearRevealTimer();
      tapRevealTimer = setTimeout(() => revealTranslation(card), REVEAL_DELAY_MS);
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
    ttsService.speakSequence(items, () => autoAdvanceTap(card));
    // Backstop in case none of the onend callbacks fire (speech silently dropped).
    if (autoAdvanceTimer) clearTimeout(autoAdvanceTimer);
    autoAdvanceTimer = setTimeout(() => autoAdvanceTap(card), TAP_AUTO_ADVANCE_BACKSTOP_MS);
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
    activeListen = speechInputService.listen({
      lang: answerLang() === 'de' ? 'de-DE' : 'en-US',
      timeoutMs: LISTEN_TIMEOUT_MS,
      onResult: (transcript) => handleVoiceResult(card, transcript),
      onTimeout: () => handleVoiceResult(card, ''),
      onError: (err) => handleVoiceError(card, err)
    });
  }

  function handleVoiceResult(card, transcript) {
    if (currentCard() !== card) return;
    activeListen = null;
    const expected = secondaryText(card);
    const correct = speechInputService.answersMatch(transcript, expected);
    stats[correct ? 'known' : 'unknown'] += 1;
    vocabStore.markReviewed(card.id, correct);
    syncService.sync();
    voiceResult = { transcript, correct, expected };
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
      handleVoiceResult(card, '');
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
    if (autoAdvanceTimer) {
      clearTimeout(autoAdvanceTimer);
      autoAdvanceTimer = null;
    }
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
      <div class="audio-mode pad center">
        <p class="hint">Übungsrichtung</p>
        <div class="direction-toggle">
          <button class="btn toggle-btn ${direction === 'en-de' ? 'active' : ''}" id="dir-en-de">${flagGB} → ${flagDE} Englisch → Deutsch</button>
          <button class="btn toggle-btn ${direction === 'de-en' ? 'active' : ''}" id="dir-de-en">${flagDE} → ${flagGB} Deutsch → Englisch</button>
        </div>

        <p class="hint">Eingabeart</p>
        <div class="direction-toggle">
          <button class="btn toggle-btn ${interactionMode === 'tap' ? 'active' : ''}" id="mode-tap"><span class="icon-inline-wrap">${tapIcon}</span> Antippen</button>
          <button class="btn toggle-btn ${interactionMode === 'voice' ? 'active' : ''}" id="mode-voice" ${voiceSupported ? '' : 'disabled'}><span class="icon-inline-wrap">${micIcon}</span> Sprechen</button>
        </div>
        ${voiceSupported ? '' : '<p class="hint">Spracheingabe wird von diesem Browser nicht unterstützt.</p>'}
        ${interactionMode === 'voice' ? `<p class="hint"><span class="icon-inline-wrap">${warningIcon}</span> Funktioniert nur, wenn die Seite direkt in Safari geöffnet ist (nicht das installierte Icon vom Home-Bildschirm).</p>` : ''}

        <p class="hint">Auto-Modus: pro Karte ein großer Tap. Kein Hinsehen nötig.</p>
        <button class="btn btn-huge btn-primary btn-with-icon" id="start-btn" ${ready ? '' : 'disabled'}>
          ${ready
            ? `<span class="icon-inline-wrap icon-lg">${playIcon}</span> Los geht's`
            : `<span class="icon-inline-wrap icon-lg">${hourglassIcon}</span> Lädt …`}
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
    container.innerHTML = `
      <div class="audio-mode">
        ${progressBarHtml(index, queue.length)}
        <div class="card-display">
          <div class="card-primary">${escapeHtml(primaryText(card))}</div>
          <div class="card-secondary ${tapRevealed ? '' : 'reveal-pending'}">${secondaryHtml}</div>
        </div>
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
    if (autoAdvanceTimer) clearTimeout(autoAdvanceTimer);
    activeListen?.stop();
    ttsService.stop();
  };
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
