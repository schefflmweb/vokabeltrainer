import { vocabStore } from '../data/vocabStore.js';
import { ttsService } from '../tts/ttsService.js';
import { syncService } from '../data/syncService.js';

const SESSION_SIZE = 15;

export function mount(container) {
  let queue = [];
  let index = -1;
  let stats = { known: 0, unknown: 0 };
  let started = false;

  function currentCard() {
    return index >= 0 && index < queue.length ? queue[index] : null;
  }

  async function startSession() {
    queue = await vocabStore.getDue(SESSION_SIZE);
    index = 0;
    stats = { known: 0, unknown: 0 };
    started = true;
    render();
    if (currentCard()) ttsService.speakCard(currentCard());
  }

  function rate(known) {
    const card = currentCard();
    if (!card) return;
    stats[known ? 'known' : 'unknown'] += 1;
    vocabStore.markReviewed(card.id, known);
    syncService.sync();
    index += 1;
    render();
    const next = currentCard();
    if (next) ttsService.speakCard(next); // must stay synchronous with this tap
  }

  function replay() {
    const card = currentCard();
    if (card) ttsService.speakCard(card);
  }

  function render() {
    if (!ttsService.isSupported()) {
      container.innerHTML = `<div class="pad"><p class="hint">Sprachausgabe wird auf diesem Gerät nicht unterstützt.</p></div>`;
      return;
    }

    if (!started) {
      container.innerHTML = `
        <div class="audio-mode pad center">
          <p class="hint">Auto-Modus: pro Karte ein großer Tap. Kein Hinsehen nötig.</p>
          <button class="btn btn-huge btn-primary" id="start-btn">▶️ Los geht's</button>
        </div>`;
      container.querySelector('#start-btn').addEventListener('click', startSession);
      return;
    }

    const card = currentCard();
    if (!card) {
      container.innerHTML = `
        <div class="audio-mode pad center">
          <h2>Runde fertig! 🎉</h2>
          <p class="hint">${stats.known} gewusst · ${stats.unknown} nochmal üben</p>
          <button class="btn btn-huge btn-primary" id="again-btn">🔄 Neue Runde</button>
        </div>`;
      container.querySelector('#again-btn').addEventListener('click', startSession);
      return;
    }

    container.innerHTML = `
      <div class="audio-mode">
        <div class="progress">${index + 1} / ${queue.length}</div>
        <div class="card-display">
          <div class="card-en">${escapeHtml(card.en)}</div>
          <div class="card-de">${escapeHtml(card.de)}</div>
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
