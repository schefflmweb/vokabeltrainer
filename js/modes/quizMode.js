import { vocabStore } from '../data/vocabStore.js';
import { syncService } from '../data/syncService.js';

const SESSION_SIZE = 15;

function shuffle(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}

export function mount(container) {
  let queue = [];
  let allVocab = [];
  let index = -1;
  let stats = { known: 0, unknown: 0 };
  let started = false;
  let answered = false;

  function currentCard() {
    return index >= 0 && index < queue.length ? queue[index] : null;
  }

  function buildOptions(card) {
    const distractorPool = allVocab.filter((v) => v.id !== card.id);
    const distractors = shuffle(distractorPool).slice(0, 3).map((v) => v.de);
    return shuffle([card.de, ...distractors]);
  }

  async function startSession() {
    allVocab = await vocabStore.getAll();
    queue = await vocabStore.getDue(SESSION_SIZE);
    index = 0;
    stats = { known: 0, unknown: 0 };
    started = true;
    answered = false;
    render();
  }

  function answer(selected, card, options) {
    if (answered) return;
    answered = true;
    const correct = selected === card.de;
    stats[correct ? 'known' : 'unknown'] += 1;
    vocabStore.markReviewed(card.id, correct);
    syncService.sync();
    renderAnswered(card, options, selected, correct);
  }

  function next() {
    index += 1;
    answered = false;
    render();
  }

  function render() {
    if (!started) {
      container.innerHTML = `
        <div class="quiz-mode pad center">
          <p class="hint">Quiz-Modus: Wort antippen, das passt.</p>
          <button class="btn btn-huge btn-primary" id="start-btn">▶️ Quiz starten</button>
        </div>`;
      container.querySelector('#start-btn').addEventListener('click', startSession);
      return;
    }

    const card = currentCard();
    if (!card) {
      container.innerHTML = `
        <div class="quiz-mode pad center">
          <h2>Runde fertig! 🎉</h2>
          <p class="hint">${stats.known} richtig · ${stats.unknown} falsch</p>
          <button class="btn btn-huge btn-primary" id="again-btn">🔄 Neue Runde</button>
        </div>`;
      container.querySelector('#again-btn').addEventListener('click', startSession);
      return;
    }

    const options = buildOptions(card);
    container.innerHTML = `
      <div class="quiz-mode">
        <div class="progress">${index + 1} / ${queue.length}</div>
        <div class="quiz-word">${escapeHtml(card.en)}</div>
        <div class="quiz-options">
          ${options.map((opt, i) => `<button class="btn btn-option" data-opt="${i}">${escapeHtml(opt)}</button>`).join('')}
        </div>
      </div>`;

    container.querySelectorAll('.btn-option').forEach((btn, i) => {
      btn.addEventListener('click', () => answer(options[i], card, options));
    });
  }

  function renderAnswered(card, options, selected, correct) {
    container.innerHTML = `
      <div class="quiz-mode">
        <div class="progress">${index + 1} / ${queue.length}</div>
        <div class="quiz-word">${escapeHtml(card.en)}</div>
        <div class="quiz-options">
          ${options.map((opt) => {
            let cls = 'btn btn-option disabled';
            if (opt === card.de) cls += ' correct';
            else if (opt === selected) cls += ' incorrect';
            return `<button class="${cls}" disabled>${escapeHtml(opt)}</button>`;
          }).join('')}
        </div>
        <p class="hint">${correct ? '✅ Richtig!' : `❌ Richtig wäre: ${escapeHtml(card.de)}`}</p>
        <button class="btn btn-huge btn-primary" id="next-btn">Weiter ▶️</button>
      </div>`;
    container.querySelector('#next-btn').addEventListener('click', next);
  }

  render();

  return () => {};
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
