import { vocabStore } from '../data/vocabStore.js';
import { syncService } from '../data/syncService.js';
import { progressBarHtml } from '../ui/progressBar.js';
import { flagGB, flagDE } from '../ui/flags.js';

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
  let direction = 'en-de'; // 'en-de' | 'de-en'
  let category = 'all'; // 'all' or an exact category name
  let categories = [];
  let answered = false;

  function promptText(card) {
    return direction === 'en-de' ? card.en : card.de;
  }

  function answerText(card) {
    return direction === 'en-de' ? card.de : card.en;
  }

  function currentCard() {
    return index >= 0 && index < queue.length ? queue[index] : null;
  }

  function buildOptions(card) {
    const distractorPool = allVocab.filter((v) => v.id !== card.id);
    const distractors = shuffle(distractorPool).slice(0, 3).map((v) => answerText(v));
    return shuffle([answerText(card), ...distractors]);
  }

  function setDirection(dir) {
    direction = dir;
    renderSelect();
  }

  function setCategory(cat) {
    category = cat;
    renderSelect();
  }

  function loadCategories() {
    vocabStore.getCategories().then((cats) => {
      categories = cats;
      if (phase === 'select') renderSelect();
    });
  }

  async function startSession(type) {
    quizType = type;
    const fullVocab = await vocabStore.getAll();
    const scoped = category === 'all' ? fullVocab : fullVocab.filter((v) => v.category === category);
    // Distractors come from the same category when there are enough to build
    // options from — falls back to the full list if the category is too small.
    allVocab = scoped.length >= 4 ? scoped : fullVocab;
    queue = await vocabStore.getDue(SESSION_SIZE, Date.now(), category === 'all' ? null : category);
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
        <p class="hint">Übungsrichtung</p>
        <div class="direction-toggle">
          <button class="btn toggle-btn ${direction === 'en-de' ? 'active' : ''}" id="dir-en-de">${flagGB} → ${flagDE} Englisch → Deutsch</button>
          <button class="btn toggle-btn ${direction === 'de-en' ? 'active' : ''}" id="dir-de-en">${flagDE} → ${flagGB} Deutsch → Englisch</button>
        </div>

        <p class="hint">Kategorie</p>
        <select class="category-select" id="category-select">
          <option value="all" ${category === 'all' ? 'selected' : ''}>Alle Kategorien</option>
          ${categories.map((c) => `<option value="${escapeHtml(c)}" ${c === category ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
        </select>

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
    container.querySelector('#dir-en-de').addEventListener('click', () => setDirection('en-de'));
    container.querySelector('#dir-de-en').addEventListener('click', () => setDirection('de-en'));
    container.querySelector('#category-select').addEventListener('change', (e) => setCategory(e.target.value));
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
        ${progressBarHtml(index, queue.length)}
        <div class="quiz-word">${escapeHtml(promptText(card))}</div>
        <div class="quiz-options">
          ${options.map((opt, i) => `<button class="btn btn-option" data-opt="${i}">${escapeHtml(opt)}</button>`).join('')}
        </div>
      </div>`;

    container.querySelectorAll('.btn-option').forEach((btn, i) => {
      btn.addEventListener('click', () => {
        if (answered) return;
        answered = true;
        const selected = options[i];
        const correct = selected === answerText(card);
        registerAnswer(correct, card);
        renderChoiceAnswered(card, options, selected, correct);
      });
    });
  }

  function renderChoiceAnswered(card, options, selected, correct) {
    const correctAnswer = answerText(card);
    container.innerHTML = `
      <div class="quiz-mode">
        ${progressBarHtml(index, queue.length)}
        <div class="quiz-word">${escapeHtml(promptText(card))}</div>
        <div class="quiz-options">
          ${options.map((opt) => {
            let cls = 'btn btn-option disabled';
            if (opt === correctAnswer) cls += ' correct';
            else if (opt === selected) cls += ' incorrect';
            return `<button class="${cls}" disabled>${escapeHtml(opt)}</button>`;
          }).join('')}
        </div>
        <p class="hint">${correct ? '✅ Richtig!' : `❌ Richtig wäre: ${escapeHtml(correctAnswer)}`}</p>
        <button class="btn btn-huge btn-primary" id="next-btn">Weiter ▶️</button>
      </div>`;
    container.querySelector('#next-btn').addEventListener('click', next);
  }

  function renderTyping() {
    const card = currentCard();
    const placeholder = direction === 'en-de' ? 'Deutsche Übersetzung' : 'Englische Übersetzung';
    container.innerHTML = `
      <div class="quiz-mode">
        ${progressBarHtml(index, queue.length)}
        <div class="quiz-word">${escapeHtml(promptText(card))}</div>
        <form id="typing-form" class="typing-form">
          <input type="text" id="typing-input" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="${placeholder}" />
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
      const correct = normalizeAnswer(value) === normalizeAnswer(answerText(card));
      registerAnswer(correct, card);
      renderTypingAnswered(card, value, correct);
    });
  }

  function renderTypingAnswered(card, value, correct) {
    const correctAnswer = answerText(card);
    container.innerHTML = `
      <div class="quiz-mode">
        ${progressBarHtml(index, queue.length)}
        <div class="quiz-word">${escapeHtml(promptText(card))}</div>
        <p class="typing-answer ${correct ? 'correct' : 'incorrect'}">${escapeHtml(value) || '–'}</p>
        <p class="hint">${correct ? '✅ Richtig!' : `❌ Richtig wäre: ${escapeHtml(correctAnswer)}`}</p>
        <button class="btn btn-huge btn-primary" id="next-btn">Weiter ▶️</button>
      </div>`;
    container.querySelector('#next-btn').addEventListener('click', next);
  }

  loadCategories();
  render();

  return () => {};
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
