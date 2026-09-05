import { vocabStore } from '../data/vocabStore.js';
import { ttsService } from '../tts/ttsService.js';
import { syncService } from '../data/syncService.js';
import { speechInputService } from '../stt/speechInputService.js';

const SESSION_SIZE = 15;
const LISTEN_TIMEOUT_MS = 5000;
const REVEAL_DELAY_MS = 3000;

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
    queue = pendingQueue;
    index = 0;
    stats = { known: 0, unknown: 0 };
    phase = queue.length > 0 ? 'active' : 'finished';
    prefetchQueue(); // load next round's due-list in the background
    enterCard();
  }

  function backToSelect() {
    clearRevealTimer();
    activeListen?.stop();
    activeListen = null;
    phase = 'select';
    render();
  }

  /** Called synchronously from a tap (start / next-card button) — speaks the current card and, in voice mode, chains into listening once speech ends. */
  function enterCard() {
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
   * Fires ~4s after a tap-mode card starts. This speak call is NOT triggered
   * synchronously from a tap (it's a setTimeout callback), which iOS Safari's
   * autoplay policy can silently drop — best-effort only. The translation is
   * always shown as text regardless, and "Nochmal anhören" lets the user
   * trigger it manually (a real tap) if the auto-speak didn't play.
   */
  function revealTranslation(card) {
    if (currentCard() !== card || interactionMode !== 'tap') return;
    tapRevealed = true;
    render();
    const items = [{ text: secondaryText(card), lang: answerLang() }];
    if (card.example) items.push({ text: card.example, lang: 'en' });
    ttsService.speakChain(items);
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
    if (!correct) {
      // Best-effort — the correct answer is also always shown as text regardless.
      ttsService.speakOnce(expected, answerLang());
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
    index += 1;
    phase = currentCard() ? 'active' : 'finished';
    if (phase === 'active') {
      enterCard();
    } else {
      prefetchQueue();
      render();
    }
  }

  function rate(known) {
    const card = currentCard();
    if (!card) return;
    clearRevealTimer();
    stats[known ? 'known' : 'unknown'] += 1;
    vocabStore.markReviewed(card.id, known);
    syncService.sync();
    index += 1;
    if (currentCard()) {
      phase = 'active';
      enterCard(); // stays synchronous with this tap
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
          <button class="btn toggle-btn ${direction === 'en-de' ? 'active' : ''}" id="dir-en-de">🇬🇧 → 🇩🇪 Englisch → Deutsch</button>
          <button class="btn toggle-btn ${direction === 'de-en' ? 'active' : ''}" id="dir-de-en">🇩🇪 → 🇬🇧 Deutsch → Englisch</button>
        </div>

        <p class="hint">Eingabeart</p>
        <div class="direction-toggle">
          <button class="btn toggle-btn ${interactionMode === 'tap' ? 'active' : ''}" id="mode-tap">👆 Antippen</button>
          <button class="btn toggle-btn ${interactionMode === 'voice' ? 'active' : ''}" id="mode-voice" ${voiceSupported ? '' : 'disabled'}>🎤 Sprechen</button>
        </div>
        ${voiceSupported ? '' : '<p class="hint">Spracheingabe wird von diesem Browser nicht unterstützt.</p>'}
        ${interactionMode === 'voice' ? '<p class="hint">⚠️ Funktioniert nur, wenn die Seite direkt in Safari geöffnet ist (nicht das installierte Icon vom Home-Bildschirm).</p>' : ''}

        <p class="hint">Auto-Modus: pro Karte ein großer Tap. Kein Hinsehen nötig.</p>
        <button class="btn btn-huge btn-primary" id="start-btn" ${ready ? '' : 'disabled'}>
          ${ready ? "▶️ Los geht's" : '⏳ Lädt …'}
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
        <h2>Runde fertig! 🎉</h2>
        <p class="hint">${stats.known} gewusst · ${stats.unknown} nochmal üben</p>
        <button class="btn btn-huge btn-primary" id="again-btn" ${ready ? '' : 'disabled'}>
          ${ready ? '🔄 Neue Runde' : '⏳ Lädt …'}
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
      : '🤔 Zeit zum Nachdenken …';
    container.innerHTML = `
      <div class="audio-mode">
        <div class="progress">${index + 1} / ${queue.length}</div>
        <div class="card-display">
          <div class="card-primary">${escapeHtml(primaryText(card))}</div>
          <div class="card-secondary ${tapRevealed ? '' : 'reveal-pending'}">${secondaryHtml}</div>
        </div>
        <button class="btn btn-secondary" id="replay-btn">🔊 Nochmal anhören</button>
        <div class="rate-buttons">
          <button class="btn btn-huge btn-danger" id="unknown-btn">❌ Nochmal üben</button>
          <button class="btn btn-huge btn-success" id="known-btn">✅ Kannte ich</button>
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
          <div class="progress">${index + 1} / ${queue.length}</div>
          <div class="card-display">
            <div class="card-primary">${escapeHtml(primaryText(card))}</div>
          </div>
          <p class="hint mic-status">🔊 Wort wird vorgelesen …</p>
        </div>`;
      return;
    }

    if (voiceState === 'listening') {
      container.innerHTML = `
        <div class="audio-mode">
          <div class="progress">${index + 1} / ${queue.length}</div>
          <div class="card-display">
            <div class="card-primary">${escapeHtml(primaryText(card))}</div>
          </div>
          <p class="hint mic-status">🎙️ Höre zu … jetzt sprechen!</p>
          <button class="btn btn-secondary" id="skip-btn">⏭️ Überspringen</button>
        </div>`;
      container.querySelector('#skip-btn').addEventListener('click', skipListening);
      return;
    }

    if (voiceState === 'error') {
      container.innerHTML = `
        <div class="audio-mode">
          <div class="progress">${index + 1} / ${queue.length}</div>
          <div class="card-display">
            <div class="card-primary">${escapeHtml(primaryText(card))}</div>
          </div>
          <p class="hint">🚫 ${escapeHtml(voiceErrorMessage)}</p>
          <button class="btn btn-secondary" id="retry-btn">🎤 Erneut versuchen</button>
          <button class="btn btn-huge btn-primary" id="next-btn">Weiter ▶️</button>
        </div>`;
      container.querySelector('#retry-btn').addEventListener('click', retryListening);
      container.querySelector('#next-btn').addEventListener('click', advanceCard);
      return;
    }

    // voiceState === 'result'
    const { transcript, correct, expected } = voiceResult;
    container.innerHTML = `
      <div class="audio-mode">
        <div class="progress">${index + 1} / ${queue.length}</div>
        <div class="card-display">
          <div class="card-primary">${escapeHtml(primaryText(card))}</div>
        </div>
        <p class="typing-answer ${correct ? 'correct' : 'incorrect'}">${escapeHtml(transcript) || '(keine Antwort erkannt)'}</p>
        <p class="hint">${correct ? '✅ Richtig!' : `❌ Richtig wäre: ${escapeHtml(expected)}`}</p>
        <button class="btn btn-secondary" id="replay-btn">🔊 Antwort anhören</button>
        <button class="btn btn-huge btn-primary" id="next-btn">Weiter ▶️</button>
      </div>`;
    container.querySelector('#replay-btn').addEventListener('click', replay);
    container.querySelector('#next-btn').addEventListener('click', advanceCard);
  }

  prefetchQueue();
  render();

  return () => {
    clearRevealTimer();
    activeListen?.stop();
    ttsService.stop();
  };
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
