import { vocabStore } from '../data/vocabStore.js';
import { syncService } from '../data/syncService.js';

const SESSION_SIZE = 15;

function shuffle(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}

function normalizeAnswer(str) {
  return str.trim().toLowerCase();
}

export function mount(container) {
  let queue = [];
  let allVocab = [];
  let index = -1;
  let stats = { known: 0, unknown: 0 };
  let phase = 'select'; // 'select' | 'active' | 'finished'
  let quizType = 'choice'; // 'choice' | 'typing'
  let answered = false;

  function currentCard() {
    return index >= 0 && index < queue.length ? queue[index] : null;
  }

  function buildOptions(card) {
    const distractorPool = allVocab.filter((v) => v.id !== card.id);
    const distractors = shuffle(distractorPool).slice(0, 3).map((v) => v.de);
    return shuffle([card.de, ...distractors]);
  }

  async function startSession(type) {
    quizType = type;
    allVocab = await vocabStore.getAll();
    queue = await vocabStore.getDue(SESSION_SIZE);
    index = 0;
    stats = { known: 0, unknown: 0 };
    answered = false;
    phase = queue.length > 0 ? 'active' : 'finished';
    render();
  }

  function backToSelect() {
    phase = 'select';
    render();
  }

  function registerAnswer(correct, card) {
    stats[correct ? 'known' : 'unknown'] += 1;
    vocabStore.markReviewed(card.id, correct);
    syncService.sync();
  }

  function next() {
    index += 1;
    answered = false;
    phase = currentCard() ? 'active' : 'finished';
    render();
  }

  function render() {
    if (phase === 'select') return renderSelect();
    if (phase === 'finished') return renderFinished();
    return quizType === 'typing' ? renderTyping() : renderChoice();
  }

  function renderSelect() {
    container.innerHTML = `
      <div class="quiz-mode pad center">
        <p class="hint">Wie möchtest du üben?</p>
        <button class="btn btn-huge btn-primary" id="start-choice">
          🔤 Multiple Choice
          <span class="hint">Antwort antippen</span>
        </button>
        <button class="btn btn-huge btn-secondary" id="start-typing">
          ⌨️ Eintippen
          <span class="hint">Übersetzung selbst schreiben</span>
        </button>
      </div>`;
    container.querySelector('#start-choice').addEventListener('click', () => startSession('choice'));
    container.querySelector('#start-typing').addEventListener('click', () => startSession('typing'));
  }

  function renderFinished() {
    container.innerHTML = `
      <div class="quiz-mode pad center">
        <h2>Runde fertig! 🎉</h2>
        <p class="hint">${stats.known} richtig · ${stats.unknown} falsch</p>
        <button class="btn btn-huge btn-primary" id="again-btn">🔄 Neue Runde</button>
        <button class="btn btn-secondary" id="switch-btn">Modus wechseln</button>
      </div>`;
    container.querySelector('#again-btn').addEventListener('click', () => startSession(quizType));
    container.querySelector('#switch-btn').addEventListener('click', backToSelect);
  }

  function renderChoice() {
    const card = currentCard();
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
      btn.addEventListener('click', () => {
        if (answered) return;
        answered = true;
        const selected = options[i];
        const correct = selected === card.de;
        registerAnswer(correct, card);
        renderChoiceAnswered(card, options, selected, correct);
      });
    });
  }

  function renderChoiceAnswered(card, options, selected, correct) {
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

  function renderTyping() {
    const card = currentCard();
    container.innerHTML = `
      <div class="quiz-mode">
        <div class="progress">${index + 1} / ${queue.length}</div>
        <div class="quiz-word">${escapeHtml(card.en)}</div>
        <form id="typing-form" class="typing-form">
          <input type="text" id="typing-input" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Deutsche Übersetzung" />
          <button type="submit" class="btn btn-huge btn-primary">Prüfen</button>
        </form>
      </div>`;

    const input = container.querySelector('#typing-input');
    input.focus();
    container.querySelector('#typing-form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (answered) return;
      answered = true;
      const value = input.value;
      const correct = normalizeAnswer(value) === normalizeAnswer(card.de);
      registerAnswer(correct, card);
      renderTypingAnswered(card, value, correct);
    });
  }

  function renderTypingAnswered(card, value, correct) {
    container.innerHTML = `
      <div class="quiz-mode">
        <div class="progress">${index + 1} / ${queue.length}</div>
        <div class="quiz-word">${escapeHtml(card.en)}</div>
        <p class="typing-answer ${correct ? 'correct' : 'incorrect'}">${escapeHtml(value) || '–'}</p>
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
