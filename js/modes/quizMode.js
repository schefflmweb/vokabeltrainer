import { vocabStore } from '../data/vocabStore.js';
import { syncService } from '../data/syncService.js';
import { progressBarHtml } from '../ui/progressBar.js';
import { flagGB, flagDE } from '../ui/flags.js';
import { checklistIcon, keyboardIcon, starIcon, refreshIcon, checkCircleIcon, xCircleIcon, playIcon } from '../ui/icons.js';
import { answersMatch } from '../util/answerMatch.js';

const SESSION_SIZE = 15;

function shuffle(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}

export function mount(container) {
  let queue = [];
  let allVocab = [];
  let index = -1;
  let stats = { known: 0, unknown: 0 };
  let phase = 'select'; // 'select' | 'active' | 'finished'
  let quizType = 'choice'; // 'choice' | 'typing'
  let direction = 'en-de'; // 'en-de' | 'de-en'
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
        <p class="hint">Übungsrichtung</p>
        <div class="direction-toggle">
          <button class="btn toggle-btn ${direction === 'en-de' ? 'active' : ''}" id="dir-en-de">${flagGB} → ${flagDE} Englisch → Deutsch</button>
          <button class="btn toggle-btn ${direction === 'de-en' ? 'active' : ''}" id="dir-de-en">${flagDE} → ${flagGB} Deutsch → Englisch</button>
        </div>

        <p class="hint">Wie möchtest du üben?</p>
        <button class="btn btn-huge quiz-choice-btn btn-primary btn-with-icon" id="start-choice">
          <span class="icon-inline-wrap icon-lg">${checklistIcon}</span>
          <span>Multiple Choice<span class="hint">Antwort antippen</span></span>
        </button>
        <button class="btn btn-huge quiz-choice-btn btn-secondary btn-with-icon" id="start-typing">
          <span class="icon-inline-wrap icon-lg">${keyboardIcon}</span>
          <span>Eintippen<span class="hint">Übersetzung selbst schreiben</span></span>
        </button>
      </div>`;
    container.querySelector('#dir-en-de').addEventListener('click', () => setDirection('en-de'));
    container.querySelector('#dir-de-en').addEventListener('click', () => setDirection('de-en'));
    container.querySelector('#start-choice').addEventListener('click', () => startSession('choice'));
    container.querySelector('#start-typing').addEventListener('click', () => startSession('typing'));
  }

  function renderFinished() {
    container.innerHTML = `
      <div class="quiz-mode pad center">
        <h2 class="btn-with-icon"><span class="icon-inline-wrap icon-lg">${starIcon}</span> Runde fertig!</h2>
        <p class="hint">${stats.known} richtig · ${stats.unknown} falsch</p>
        <button class="btn btn-huge btn-primary btn-with-icon" id="again-btn"><span class="icon-inline-wrap icon-lg">${refreshIcon}</span> Neue Runde</button>
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
        <div class="quiz-content">
          ${progressBarHtml(index, queue.length)}
          <div class="quiz-word">${escapeHtml(promptText(card))}</div>
          <div class="quiz-options">
            ${options.map((opt, i) => `<button class="btn btn-option" data-opt="${i}">${escapeHtml(opt)}</button>`).join('')}
          </div>
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
        <div class="quiz-content">
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
          <p class="hint btn-with-icon"><span class="icon-inline-wrap">${correct ? checkCircleIcon : xCircleIcon}</span> ${correct ? 'Richtig!' : `Richtig wäre: ${escapeHtml(correctAnswer)}`}</p>
        </div>
        <button class="btn btn-huge btn-compact btn-primary btn-with-icon" id="next-btn">Weiter <span class="icon-inline-wrap">${playIcon}</span></button>
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
          <button type="submit" class="btn btn-huge btn-compact btn-primary btn-with-icon"><span class="icon-inline-wrap">${checkCircleIcon}</span> Prüfen</button>
        </form>
      </div>`;

    const input = container.querySelector('#typing-input');
    // preventScroll: without it, iOS Safari's own "scroll focused input into
    // view" heuristic fights with this layout's own flex-based positioning —
    // it was scrolling the page even though the input/button already sit
    // correctly on screen, which is exactly the extra scroll being reported.
    input.focus({ preventScroll: true });
    container.scrollTo(0, 0); // container === #view, the scrolling ancestor
    container.querySelector('#typing-form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (answered) return;
      answered = true;
      const value = input.value;
      const correct = answersMatch(value, answerText(card));
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
        <p class="hint typing-result btn-with-icon"><span class="icon-inline-wrap">${correct ? checkCircleIcon : xCircleIcon}</span> ${correct ? 'Richtig!' : `Richtig wäre: ${escapeHtml(correctAnswer)}`}</p>
        <button class="btn btn-huge btn-compact btn-primary btn-with-icon" id="next-btn">Weiter <span class="icon-inline-wrap">${playIcon}</span></button>
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
