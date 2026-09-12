import { vocabStore } from '../data/vocabStore.js';
import { syncService } from '../data/syncService.js';
import { ttsService } from '../tts/ttsService.js';
import { progressBarHtml } from '../ui/progressBar.js';
import { flagGB, flagDE } from '../ui/flags.js';
import { checklistIcon, keyboardIcon, speakerIcon, thinkingIcon, starIcon, refreshIcon, checkCircleIcon, xCircleIcon, playIcon } from '../ui/icons.js';
import { answersMatch } from '../util/answerMatch.js';

const SESSION_SIZE = 15;
// "Zuhören" timing — same values/reasoning as Auto mode's "Zuhören",
// copied here as a third Quiz practice type.
const REVEAL_DELAY_MS = 3000;
const PRIMARY_SPEECH_BACKSTOP_MS = 4000;
const TRANSLATION_SPEECH_BACKSTOP_MS = 6000;
// Pause after the translation finishes speaking, before auto-advancing to
// the next card — the only window during which the rate buttons are active.
const STOP_WINDOW_MS = 2500;

function shuffle(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}

export function mount(container) {
  let queue = [];
  let allVocab = [];
  let index = -1;
  let stats = { known: 0, unknown: 0 };
  let phase = 'select'; // 'select' | 'active' | 'finished'
  let quizType = 'choice'; // 'choice' | 'typing' | 'readthink'
  let direction = 'en-de'; // 'en-de' | 'de-en'
  let answered = false;

  // "Zuhören" per-card state (mirrors Auto mode's tap flow).
  let rtRevealed = false;
  let rtRevealTimer = null;
  let rtPrimarySpeechTimer = null;
  let rtAutoAdvanceTimer = null;
  let rtPendingAdvance = false; // guards against double-advance (auto path + manual rate tap racing)
  // True only during the post-translation pause (STOP_WINDOW_MS) — the rate
  // buttons are disabled the rest of the time (primary word speaking,
  // thinking pause, translation speaking).
  let rtButtonsActive = false;
  function clearRtTimers() {
    if (rtRevealTimer) { clearTimeout(rtRevealTimer); rtRevealTimer = null; }
    if (rtPrimarySpeechTimer) { clearTimeout(rtPrimarySpeechTimer); rtPrimarySpeechTimer = null; }
    if (rtAutoAdvanceTimer) { clearTimeout(rtAutoAdvanceTimer); rtAutoAdvanceTimer = null; }
  }

  // iOS Safari only allows speechSynthesis.speak() when called synchronously
  // inside a real tap — so (for "Zuhören" specifically) the next
  // round's due-list is fetched ahead of time, and starting/continuing a
  // round never awaits anything before it calls speakOnce()/speakSequence().
  let pendingQueue = null;
  function prefetchQueue() {
    pendingQueue = null;
    vocabStore.getDue(SESSION_SIZE).then((q) => {
      pendingQueue = q;
      if (phase === 'select' || phase === 'finished') render();
    });
  }

  function promptText(card) {
    return direction === 'en-de' ? card.en : card.de;
  }

  function answerText(card) {
    return direction === 'en-de' ? card.de : card.en;
  }

  function promptLang() {
    return direction === 'en-de' ? 'en' : 'de';
  }

  function answerLang() {
    return direction === 'en-de' ? 'de' : 'en';
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
    stats = { known: 0, unknown: 0 };
    answered = false;

    if (type === 'readthink') {
      if (!pendingQueue) return; // guarded by disabled button; shouldn't fire
      queue = pendingQueue;
      index = 0;
      phase = queue.length > 0 ? 'active' : 'finished';
      prefetchQueue(); // load next round's due-list in the background
      if (phase === 'active') {
        enterReadThink(currentCard()); // real tap — speaks the first card synchronously
      } else {
        render();
      }
      return;
    }

    allVocab = await vocabStore.getAll();
    queue = await vocabStore.getDue(SESSION_SIZE);
    index = 0;
    phase = queue.length > 0 ? 'active' : 'finished';
    render();
  }

  function backToSelect() {
    clearRtTimers();
    rtButtonsActive = false;
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
    if (quizType === 'typing') return renderTyping();
    if (quizType === 'readthink') return renderReadThink();
    return renderChoice();
  }

  function renderSelect() {
    const rtReady = !!pendingQueue;
    container.innerHTML = `
      <div class="quiz-mode pad center-text">
        <p class="hint">Übungsrichtung</p>
        <div class="direction-toggle">
          <button class="btn toggle-btn ${direction === 'en-de' ? 'active' : ''}" id="dir-en-de">${flagGB} → ${flagDE} Englisch → Deutsch</button>
          <button class="btn toggle-btn ${direction === 'de-en' ? 'active' : ''}" id="dir-de-en">${flagDE} → ${flagGB} Deutsch → Englisch</button>
        </div>

        <p class="hint">Wie möchtest du üben?</p>
        <button class="btn btn-huge mode-choice-btn btn-primary btn-with-icon" id="start-choice">
          <span class="icon-inline-wrap icon-lg">${checklistIcon}</span>
          <span>Multiple Choice<span class="hint">Antwort antippen</span></span>
        </button>
        <button class="btn btn-huge mode-choice-btn btn-secondary btn-with-icon" id="start-typing">
          <span class="icon-inline-wrap icon-lg">${keyboardIcon}</span>
          <span>Eintippen<span class="hint">Übersetzung selbst schreiben</span></span>
        </button>
        <button class="btn btn-huge mode-choice-btn btn-secondary btn-with-icon" id="start-readthink" ${rtReady ? '' : 'disabled'}>
          <span class="icon-inline-wrap icon-lg">${speakerIcon}</span>
          <span>Zuhören<span class="hint">${rtReady ? 'Anhören, dann bewerten' : 'Lädt …'}</span></span>
        </button>
      </div>`;
    container.querySelector('#dir-en-de').addEventListener('click', () => setDirection('en-de'));
    container.querySelector('#dir-de-en').addEventListener('click', () => setDirection('de-en'));
    container.querySelector('#start-choice').addEventListener('click', () => startSession('choice'));
    container.querySelector('#start-typing').addEventListener('click', () => startSession('typing'));
    container.querySelector('#start-readthink').addEventListener('click', () => startSession('readthink'));
  }

  function renderFinished() {
    const rtReady = quizType !== 'readthink' || !!pendingQueue;
    container.innerHTML = `
      <div class="quiz-mode pad center">
        <h2 class="btn-with-icon"><span class="icon-inline-wrap icon-lg">${starIcon}</span> Runde fertig!</h2>
        <p class="hint">${stats.known} richtig · ${stats.unknown} falsch</p>
        <button class="btn btn-huge btn-primary btn-with-icon" id="again-btn" ${rtReady ? '' : 'disabled'}>
          ${rtReady
            ? `<span class="icon-inline-wrap icon-lg">${refreshIcon}</span> Neue Runde`
            : `<span class="icon-inline-wrap icon-lg">${refreshIcon}</span> Lädt …`}
        </button>
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

  /** Called synchronously from a tap (start / next-card) — speaks the prompt word, then (after a thinking pause) the translation, then auto-advances. */
  function enterReadThink(card) {
    rtPendingAdvance = false;
    rtButtonsActive = false;
    clearRtTimers();
    rtRevealed = false;
    render();
    // Thinking time starts once the word has actually finished being spoken
    // — not the moment speak() was called, which would cut it short (or
    // start the reveal mid-word) for longer words. onEnd fires when playback
    // genuinely finishes; the backstop covers it silently never firing.
    let revealStarted = false;
    const startReveal = () => {
      if (revealStarted) return;
      revealStarted = true;
      if (rtPrimarySpeechTimer) { clearTimeout(rtPrimarySpeechTimer); rtPrimarySpeechTimer = null; }
      if (currentCard() !== card) return; // card changed while speech was playing
      rtRevealTimer = setTimeout(() => revealReadThink(card), REVEAL_DELAY_MS);
    };
    ttsService.speakOnce(promptText(card), promptLang(), { onEnd: startReveal });
    rtPrimarySpeechTimer = setTimeout(startReveal, PRIMARY_SPEECH_BACKSTOP_MS);
  }

  /**
   * Fires ~3s after a "Zuhören" card starts. This speak call is
   * NOT triggered synchronously from a tap (it's a setTimeout callback),
   * which iOS Safari's autoplay policy can silently drop — best-effort only.
   * The translation is always shown as text regardless, and "Nochmal
   * anhören" lets the user trigger it manually (a real tap) if the
   * auto-speak didn't play. Once it finishes, the post-translation pause
   * (enterReadThinkStopWindow) begins.
   */
  function revealReadThink(card) {
    if (currentCard() !== card) return;
    rtRevealed = true;
    render();
    const items = [{ text: answerText(card), lang: answerLang() }];
    if (card.example) items.push({ text: card.example, lang: 'en' });
    let windowEntered = false;
    const enterWindowOnce = () => {
      if (windowEntered) return;
      windowEntered = true;
      if (rtAutoAdvanceTimer) {
        clearTimeout(rtAutoAdvanceTimer);
        rtAutoAdvanceTimer = null;
      }
      enterReadThinkStopWindow(card);
    };
    ttsService.speakSequence(items, enterWindowOnce);
    // Backstop in case none of the onend callbacks fire (speech silently dropped).
    if (rtAutoAdvanceTimer) clearTimeout(rtAutoAdvanceTimer);
    rtAutoAdvanceTimer = setTimeout(enterWindowOnce, TRANSLATION_SPEECH_BACKSTOP_MS);
  }

  /**
   * The only window during which "Nochmal üben"/"Kannte ich" are active.
   * Tapping either during it rates the card immediately (and advances);
   * letting it run out counts the card as "kannte ich" automatically,
   * matching Auto mode's same default for an unrated card.
   */
  function enterReadThinkStopWindow(card) {
    if (currentCard() !== card) return;
    rtButtonsActive = true;
    render();
    rtAutoAdvanceTimer = setTimeout(() => autoAdvanceReadThink(card), STOP_WINDOW_MS);
  }

  function autoAdvanceReadThink(card) {
    if (currentCard() !== card) return;
    if (rtAutoAdvanceTimer) {
      clearTimeout(rtAutoAdvanceTimer);
      rtAutoAdvanceTimer = null;
    }
    rateReadThink(true); // window ran out without a tap -> counts as "kannte ich" per Auto mode's same choice
  }

  function rateReadThink(known) {
    if (rtPendingAdvance) return; // already advanced (auto path and manual tap raced)
    rtPendingAdvance = true;
    const card = currentCard();
    if (!card) return;
    clearRtTimers();
    registerAnswer(known, card);
    index += 1;
    if (currentCard()) {
      phase = 'active';
      enterReadThink(currentCard()); // resets rtPendingAdvance, speaks synchronously from this tap
    } else {
      phase = 'finished';
      prefetchQueue();
      render();
    }
  }

  function replayReadThink() {
    const card = currentCard();
    if (!card) return;
    if (rtRevealed) {
      ttsService.speakCard(card, direction);
    } else {
      ttsService.speakOnce(promptText(card), promptLang());
    }
  }

  function renderReadThink() {
    const card = currentCard();
    const secondaryHtml = rtRevealed
      ? escapeHtml(answerText(card))
      : `<span class="icon-inline-wrap">${thinkingIcon}</span> Zeit zum Nachdenken …`;
    const rateDisabled = rtButtonsActive ? '' : 'disabled';
    container.innerHTML = `
      <div class="quiz-mode">
        <div class="quiz-content">
          ${progressBarHtml(index, queue.length)}
          <div class="quiz-word">${escapeHtml(promptText(card))}</div>
          <p class="hint quiz-secondary ${rtRevealed ? '' : 'reveal-pending'}">${secondaryHtml}</p>
        </div>
        <button class="btn btn-secondary btn-with-icon" id="replay-btn"><span class="icon-inline-wrap">${speakerIcon}</span> Nochmal anhören</button>
        <div class="rate-buttons">
          <button class="btn btn-huge btn-compact btn-danger btn-with-icon" id="unknown-btn" ${rateDisabled}><span class="icon-inline-wrap">${xCircleIcon}</span> Nochmal üben</button>
          <button class="btn btn-huge btn-compact btn-success btn-with-icon" id="known-btn" ${rateDisabled}><span class="icon-inline-wrap">${checkCircleIcon}</span> Kannte ich</button>
        </div>
      </div>`;
    container.querySelector('#replay-btn').addEventListener('click', replayReadThink);
    container.querySelector('#unknown-btn').addEventListener('click', () => { if (rtButtonsActive) rateReadThink(false); });
    container.querySelector('#known-btn').addEventListener('click', () => { if (rtButtonsActive) rateReadThink(true); });
  }

  prefetchQueue();
  render();

  return () => {
    clearRtTimers();
    ttsService.stop();
  };
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
