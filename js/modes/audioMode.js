import { vocabStore } from '../data/vocabStore.js';
import { ttsService } from '../tts/ttsService.js';
import { syncService } from '../data/syncService.js';

const SESSION_SIZE = 15;

export function mount(container) {
  let direction = 'en-de'; // 'en-de' | 'de-en'
  let phase = 'select'; // 'select' | 'active' | 'finished'
  let queue = [];
  let index = -1;
  let stats = { known: 0, unknown: 0 };

  // iOS Safari only allows speechSynthesis.speak() when called synchronously
  // inside the tap handler — so the next round's due-list is always fetched
  // ahead of time, and the "Los geht's" / "Neue Runde" tap never awaits
  // anything before it calls speakCard().
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

  function setDirection(dir) {
    direction = dir;
    render();
  }

  function startSession() {
    if (!pendingQueue) return; // guarded by disabled button; shouldn't fire
    queue = pendingQueue;
    index = 0;
    stats = { known: 0, unknown: 0 };
    phase = queue.length > 0 ? 'active' : 'finished';
    prefetchQueue(); // load next round's due-list in the background
    render();
    if (currentCard()) ttsService.speakCard(currentCard(), direction);
  }

  function backToSelect() {
    phase = 'select';
    render();
  }

  function rate(known) {
    const card = currentCard();
    if (!card) return;
    stats[known ? 'known' : 'unknown'] += 1;
    vocabStore.markReviewed(card.id, known);
    syncService.sync();
    index += 1;
    phase = currentCard() ? 'active' : 'finished';
    render();
    const next = currentCard();
    if (next) ttsService.speakCard(next, direction); // stays synchronous with this tap
  }

  function replay() {
    const card = currentCard();
    if (card) ttsService.speakCard(card, direction);
  }

  function render() {
    if (!ttsService.isSupported()) {
      container.innerHTML = `<div class="pad"><p class="hint">Sprachausgabe wird auf diesem Gerät nicht unterstützt.</p></div>`;
      return;
    }
    if (phase === 'select') return renderSelect();
    if (phase === 'finished') return renderFinished();
    return renderActive();
  }

  function renderSelect() {
    const ready = !!pendingQueue;
    container.innerHTML = `
      <div class="audio-mode pad center">
        <p class="hint">Übungsrichtung</p>
        <div class="direction-toggle">
          <button class="btn toggle-btn ${direction === 'en-de' ? 'active' : ''}" id="dir-en-de">🇬🇧 → 🇩🇪 Englisch → Deutsch</button>
          <button class="btn toggle-btn ${direction === 'de-en' ? 'active' : ''}" id="dir-de-en">🇩🇪 → 🇬🇧 Deutsch → Englisch</button>
        </div>
        <p class="hint">Auto-Modus: pro Karte ein großer Tap. Kein Hinsehen nötig.</p>
        <button class="btn btn-huge btn-primary" id="start-btn" ${ready ? '' : 'disabled'}>
          ${ready ? "▶️ Los geht's" : '⏳ Lädt …'}
        </button>
      </div>`;
    container.querySelector('#dir-en-de').addEventListener('click', () => setDirection('en-de'));
    container.querySelector('#dir-de-en').addEventListener('click', () => setDirection('de-en'));
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

  function renderActive() {
    const card = currentCard();
    container.innerHTML = `
      <div class="audio-mode">
        <div class="progress">${index + 1} / ${queue.length}</div>
        <div class="card-display">
          <div class="card-primary">${escapeHtml(primaryText(card))}</div>
          <div class="card-secondary">${escapeHtml(secondaryText(card))}</div>
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

  prefetchQueue();
  render();

  return () => {
    ttsService.stop();
  };
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
