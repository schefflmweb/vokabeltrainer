import { grammarStore } from '../data/grammarStore.js';
import { progressBarHtml } from '../ui/progressBar.js';
import { bookIcon, refreshIcon, starIcon, checkCircleIcon, xCircleIcon, playIcon } from '../ui/icons.js';

const SESSION_SIZE = 12;

function shuffle(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}

export function mount(container) {
  let queue = [];
  let index = -1;
  let stats = { known: 0, unknown: 0 };
  let phase = 'select'; // 'select' | 'active' | 'finished'
  let topics = [];
  let selectedTopic = '';
  let answered = false;

  function currentItem() {
    return index >= 0 && index < queue.length ? queue[index] : null;
  }

  async function startSession() {
    queue = await grammarStore.getSession(SESSION_SIZE, selectedTopic || null);
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

  function registerAnswer(correct, item) {
    stats[correct ? 'known' : 'unknown'] += 1;
    grammarStore.markReviewed(item.id, correct);
  }

  function next() {
    index += 1;
    answered = false;
    phase = currentItem() ? 'active' : 'finished';
    render();
  }

  function render() {
    if (phase === 'select') return renderSelect();
    if (phase === 'finished') return renderFinished();
    return renderQuestion();
  }

  function renderSelect() {
    container.innerHTML = `
      <div class="quiz-mode pad center">
        <p class="hint">Thema</p>
        <select class="field-select" id="topic-select">
          <option value="">Alle Themen (gemischt)</option>
          ${topics.map((t) => `<option value="${escapeHtml(t)}" ${t === selectedTopic ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}
        </select>
        <button class="btn btn-huge quiz-choice-btn btn-primary btn-with-icon" id="start-btn">
          <span class="icon-inline-wrap icon-lg">${bookIcon}</span>
          <span>Übung starten<span class="hint">Multiple Choice</span></span>
        </button>
      </div>`;
    container.querySelector('#topic-select').addEventListener('change', (e) => {
      selectedTopic = e.target.value;
    });
    container.querySelector('#start-btn').addEventListener('click', startSession);
  }

  function renderFinished() {
    container.innerHTML = `
      <div class="quiz-mode pad center">
        <h2 class="btn-with-icon"><span class="icon-inline-wrap icon-lg">${starIcon}</span> Runde fertig!</h2>
        <p class="hint">${stats.known} richtig · ${stats.unknown} falsch</p>
        <button class="btn btn-huge btn-primary btn-with-icon" id="again-btn"><span class="icon-inline-wrap icon-lg">${refreshIcon}</span> Neue Runde</button>
        <button class="btn btn-secondary" id="switch-btn">Thema wechseln</button>
      </div>`;
    container.querySelector('#again-btn').addEventListener('click', startSession);
    container.querySelector('#switch-btn').addEventListener('click', backToSelect);
  }

  function renderQuestion() {
    const item = currentItem();
    const options = item.options;
    container.innerHTML = `
      <div class="quiz-mode">
        <div class="quiz-content">
          ${progressBarHtml(index, queue.length)}
          <p class="hint">${escapeHtml(item.topic)}</p>
          <div class="quiz-word grammar-sentence">${escapeHtml(item.question)}</div>
          <div class="quiz-options">
            ${options.map((opt, i) => `<button class="btn btn-option" data-opt="${i}">${escapeHtml(opt)}</button>`).join('')}
          </div>
        </div>
      </div>`;

    container.querySelectorAll('.btn-option').forEach((btn, i) => {
      btn.addEventListener('click', () => {
        if (answered) return;
        answered = true;
        const correct = i === item.correctIndex;
        registerAnswer(correct, item);
        renderAnswered(item, i, correct);
      });
    });
  }

  function renderAnswered(item, selectedIndex, correct) {
    container.innerHTML = `
      <div class="quiz-mode">
        <div class="quiz-content">
          ${progressBarHtml(index, queue.length)}
          <p class="hint">${escapeHtml(item.topic)}</p>
          <div class="quiz-word grammar-sentence">${escapeHtml(item.question)}</div>
          <div class="quiz-options">
            ${item.options.map((opt, i) => {
              let cls = 'btn btn-option disabled';
              if (i === item.correctIndex) cls += ' correct';
              else if (i === selectedIndex) cls += ' incorrect';
              return `<button class="${cls}" disabled>${escapeHtml(opt)}</button>`;
            }).join('')}
          </div>
          <p class="hint typing-result btn-with-icon"><span class="icon-inline-wrap">${correct ? checkCircleIcon : xCircleIcon}</span> ${correct ? 'Richtig!' : `Richtig wäre: ${escapeHtml(item.options[item.correctIndex])}`}</p>
          ${item.explanation ? `<p class="hint grammar-explanation">${escapeHtml(item.explanation)}</p>` : ''}
        </div>
        <button class="btn btn-huge btn-compact btn-primary btn-with-icon" id="next-btn">Weiter <span class="icon-inline-wrap">${playIcon}</span></button>
      </div>`;
    container.querySelector('#next-btn').addEventListener('click', next);
  }

  (async () => {
    await grammarStore.ready();
    topics = await grammarStore.getTopics();
    render();
  })();

  return () => {};
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
