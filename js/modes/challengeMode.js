import { getNextQuestion } from '../data/challengeQuestions.js';
import { challengeStore } from '../data/challengeStore.js';
import { toneService } from '../audio/toneService.js';
import { progressBarHtml } from '../ui/progressBar.js';
import {
  playIcon, refreshIcon, starIcon, checkCircleIcon, xCircleIcon, hourglassIcon, warningIcon
} from '../ui/icons.js';

const MAX_HEIGHT = 20;
const CHECKPOINTS = [5, 10, 15];
const WAGER_UNLOCK_HEIGHT = 8;
const GOLDEN_UNLOCK_HEIGHT = 12;
const TIMER_START_HEIGHT = 10;
const TIMER_HARD_HEIGHT = 15;
const TIMER_SECONDS_MEDIUM = 15;
const TIMER_SECONDS_HARD = 10;

function computeDelta(correct, height, wagerMode) {
  if (wagerMode === 'golden') return correct ? 2 : -5;
  if (wagerMode === 'double') return correct ? 2 : -3;
  if (correct) return 1;
  return height >= 15 ? -3 : -2;
}

/** A checkpoint at 5/10/15 is "reached" once height first exceeds it — from then on, falling back to or below it collapses the tower. 0 counts as the implicit starting checkpoint (the ground), so an early bad run before reaching height 5 can still collapse. */
function updateCheckpoint(lastCheckpoint, height) {
  let next = lastCheckpoint;
  for (const c of CHECKPOINTS) {
    if (height > c && next < c) next = c;
  }
  return next;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function mount(container) {
  let phase = 'select'; // 'select' | 'loading' | 'active' | 'revealed' | 'boss' | 'results' | 'empty'
  let bestHeight = 0;
  let height = 0;
  let lastCheckpoint = 0;
  let jokerUsed = false;
  let goldenUsed = false;
  let wagerMode = 'normal'; // 'normal' | 'double' | 'golden' — resets every question
  let currentQuestion = null;
  let selectedIndex = null;
  let lastCorrect = null;
  let lastDelta = null;
  let endReason = null; // 'collapse' | 'cashout' | 'maxHeight'
  let sessionStats = { questionsAsked: 0, questionsCorrect: 0, wrongQuestions: [] };
  let sessionStartedAt = null;
  let bossQueue = [];
  let bossIndex = 0;
  let bossAnswered = false;
  let bossCorrect = null;
  let timerHandle = null;
  let timerRemaining = null;

  function clearTimer() {
    if (timerHandle) {
      clearInterval(timerHandle);
      timerHandle = null;
    }
    timerRemaining = null;
  }

  function startTimerIfNeeded() {
    clearTimer();
    if (height < TIMER_START_HEIGHT) return;
    timerRemaining = height >= TIMER_HARD_HEIGHT ? TIMER_SECONDS_HARD : TIMER_SECONDS_MEDIUM;
    timerHandle = setInterval(() => {
      timerRemaining -= 1;
      if (timerRemaining <= 0) {
        submitAnswer(-1); // timeout counts as a wrong answer
      } else {
        render();
      }
    }, 1000);
  }

  function startSession() {
    height = 0;
    lastCheckpoint = 0;
    jokerUsed = false;
    goldenUsed = false;
    wagerMode = 'normal';
    sessionStats = { questionsAsked: 0, questionsCorrect: 0, wrongQuestions: [] };
    sessionStartedAt = Date.now();
    endReason = null;
    phase = 'loading';
    render();
    loadNextQuestion();
  }

  async function loadNextQuestion() {
    const q = await getNextQuestion(height);
    if (!q) {
      phase = 'empty';
      render();
      return;
    }
    currentQuestion = q;
    selectedIndex = null;
    lastCorrect = null;
    lastDelta = null;
    phase = 'active';
    startTimerIfNeeded();
    render();
  }

  function submitAnswer(index) {
    if (phase !== 'active') return;
    clearTimer();
    selectedIndex = index;
    const correct = index === currentQuestion.correctIndex;
    lastCorrect = correct;
    lastDelta = computeDelta(correct, height, wagerMode);
    height += lastDelta;
    lastCheckpoint = updateCheckpoint(lastCheckpoint, height);
    sessionStats.questionsAsked += 1;
    if (correct) {
      sessionStats.questionsCorrect += 1;
      toneService.playCoasterPlace(Math.max(height, 0));
    } else {
      sessionStats.wrongQuestions.push(currentQuestion);
      toneService.playIncorrect();
    }
    phase = 'revealed';
    render();
  }

  function useJoker() {
    if (jokerUsed || phase !== 'active') return;
    jokerUsed = true;
    clearTimer();
    wagerMode = 'normal';
    phase = 'loading';
    render();
    loadNextQuestion();
  }

  function toggleDouble() {
    if (phase !== 'active' || height < WAGER_UNLOCK_HEIGHT) return;
    wagerMode = wagerMode === 'double' ? 'normal' : 'double';
    render();
  }

  function useGolden() {
    if (goldenUsed || phase !== 'active' || height < GOLDEN_UNLOCK_HEIGHT) return;
    wagerMode = 'golden';
    goldenUsed = true;
    render();
  }

  function cashOut() {
    if (phase !== 'active') return;
    clearTimer();
    endReason = 'cashout';
    endSession();
  }

  function proceedAfterReveal() {
    wagerMode = 'normal';
    if (height >= MAX_HEIGHT) {
      endReason = 'maxHeight';
      height = MAX_HEIGHT;
      endSession();
      return;
    }
    if (height <= lastCheckpoint) {
      endReason = 'collapse';
      height = lastCheckpoint;
      toneService.playCollapse();
      phase = 'collapsing';
      render();
      setTimeout(() => endSession(), 700);
      return;
    }
    phase = 'loading';
    render();
    loadNextQuestion();
  }

  function endSession() {
    if (sessionStats.wrongQuestions.length > 0) {
      phase = 'boss';
      bossQueue = sessionStats.wrongQuestions;
      bossIndex = 0;
      bossAnswered = false;
      bossCorrect = null;
      render();
    } else {
      finalizeResults();
    }
  }

  function submitBossAnswer(index) {
    if (bossAnswered) return;
    bossAnswered = true;
    bossCorrect = index === bossQueue[bossIndex].correctIndex;
    render();
  }

  function nextBossQuestion() {
    bossIndex += 1;
    bossAnswered = false;
    bossCorrect = null;
    if (bossIndex >= bossQueue.length) {
      finalizeResults();
    } else {
      render();
    }
  }

  async function finalizeResults() {
    phase = 'results';
    render();
    const result = await challengeStore.recordSession({
      startedAt: sessionStartedAt,
      finalHeight: height,
      endReason,
      questionsAsked: sessionStats.questionsAsked,
      questionsCorrect: sessionStats.questionsCorrect,
      wrongItemIds: sessionStats.wrongQuestions.map((q) => q.itemId)
    });
    bestHeight = result.bestHeight;
    render();
  }

  function backToSelect() {
    clearTimer();
    phase = 'select';
    render();
  }

  // --- Rendering ---

  // A real coaster tower is built from A-frame triangles (two coasters leaned
  // against each other), several triangles side by side per row, with the
  // next (narrower) row resting on a bridge across the row below — a stepped
  // pyramid. TIER_CAPACITIES (bottom to top) sums to exactly MAX_HEIGHT, so
  // every height point maps to one more triangle somewhere in the pyramid.
  const TIER_CAPACITIES = [6, 5, 4, 3, 2];
  const TRIANGLE_H = 44;
  const TIER_GAP = 6;
  const BRIDGE_H = 8;

  function buildTiers(displayHeight) {
    const tiers = [];
    let consumed = 0;
    for (const cap of TIER_CAPACITIES) {
      const count = Math.max(0, Math.min(cap, displayHeight - consumed));
      tiers.push({ cap, count, start: consumed + 1 });
      consumed += cap;
      if (displayHeight <= consumed) break;
    }
    return tiers;
  }

  function bestLineOffset(height) {
    let consumed = 0;
    let offsetPx = 0;
    for (let idx = 0; idx < TIER_CAPACITIES.length; idx++) {
      const cap = TIER_CAPACITIES[idx];
      if (height <= consumed + cap) return offsetPx;
      offsetPx += TRIANGLE_H + TIER_GAP;
      if (idx < TIER_CAPACITIES.length - 1) offsetPx += BRIDGE_H + TIER_GAP;
      consumed += cap;
    }
    return offsetPx;
  }

  function triangleEl(levelIndex, opts = {}) {
    const isCheckpoint = CHECKPOINTS.includes(levelIndex);
    const falling = opts.collapseAbove != null && levelIndex > opts.collapseAbove;
    const jitter = ((levelIndex * 47) % 7) - 3;
    const cls = ['coaster-triangle', isCheckpoint && 'coaster-triangle-checkpoint', falling && 'coaster-triangle-falling']
      .filter(Boolean).join(' ');
    return `<div class="${cls}" style="--jitter:${jitter}deg">
      <div class="coaster-leg left"></div>
      <div class="coaster-leg right"></div>
    </div>`;
  }

  function towerHtml(displayHeight, opts = {}) {
    const wobbleClass = displayHeight >= 15 ? 'wobble-strong' : displayHeight >= 10 ? 'wobble-medium' : displayHeight >= 5 ? 'wobble-light' : '';
    const tiers = buildTiers(displayHeight);
    let rows = '';
    tiers.forEach((tier, idx) => {
      if (tier.count <= 0) return;
      let triangles = '';
      for (let i = 0; i < tier.count; i++) triangles += triangleEl(tier.start + i, opts);
      rows += `<div class="coaster-tier">${triangles}</div>`;
      const isTopTier = idx === TIER_CAPACITIES.length - 1;
      if (tier.count === tier.cap && !isTopTier) rows += `<div class="tier-bridge"></div>`;
    });
    const bestMarker = bestHeight > 0 && bestHeight <= MAX_HEIGHT
      ? `<div class="tower-best-line" style="bottom:${bestLineOffset(bestHeight)}px"><span>Bestwert ${bestHeight}</span></div>`
      : '';
    return `
      <div class="tower-wrap">
        ${bestMarker}
        <div class="tower ${wobbleClass}">${rows}</div>
        <div class="tower-ground"></div>
      </div>
      <p class="hint center-text tower-height-label">Höhe ${displayHeight}</p>`;
  }

  function renderSelect() {
    container.innerHTML = `
      <div class="quiz-mode challenge-mode pad center-text">
        <h2>🍺 Bierdeckel-Challenge</h2>
        <p class="hint">Jede richtige Antwort legt einen Deckel auf den Turm. Fehler lassen ihn wackeln — ab Höhe 5/10/15 ist der Stand gesichert, darunter stürzt alles ein. Hör rechtzeitig auf, um deinen Stand zu sichern!</p>
        <p class="hint">Aktueller Bestwert: <strong>${bestHeight}</strong></p>
        <button class="btn btn-huge mode-choice-btn btn-primary btn-with-icon" id="start-btn">
          <span class="icon-inline-wrap icon-lg">${playIcon}</span>
          <span>Challenge starten</span>
        </button>
      </div>`;
    container.querySelector('#start-btn').addEventListener('click', startSession);
  }

  function renderEmpty() {
    container.innerHTML = `
      <div class="quiz-mode challenge-mode pad center">
        <h2 class="btn-with-icon"><span class="icon-inline-wrap icon-lg">${warningIcon}</span> Nichts zum Üben</h2>
        <p class="hint">Für die Challenge braucht es Vokabeln, Idioms oder Grammatikübungen — importiere welche unter Verwalten.</p>
        <button class="btn btn-secondary" id="back-btn">Zurück</button>
      </div>`;
    container.querySelector('#back-btn').addEventListener('click', backToSelect);
  }

  function renderLoading() {
    container.innerHTML = `
      <div class="quiz-mode challenge-mode pad center">
        ${towerHtml(Math.max(height, 0))}
        <p class="hint btn-with-icon"><span class="icon-inline-wrap">${hourglassIcon}</span> Nächste Frage …</p>
      </div>`;
  }

  function wagerControlsHtml() {
    const doubleAvailable = height >= WAGER_UNLOCK_HEIGHT;
    const goldenAvailable = height >= GOLDEN_UNLOCK_HEIGHT && !goldenUsed;
    if (!doubleAvailable && !goldenAvailable && jokerUsed) return '';
    return `
      <div class="wager-controls">
        ${doubleAvailable ? `<button class="btn btn-secondary wager-btn ${wagerMode === 'double' ? 'active' : ''}" id="double-btn">Doppelt-Einsatz${wagerMode === 'double' ? ' ✓' : ''} (+2 / −3)</button>` : ''}
        ${height >= GOLDEN_UNLOCK_HEIGHT ? `<button class="btn btn-secondary wager-btn golden-btn ${wagerMode === 'golden' ? 'active' : ''}" id="golden-btn" ${goldenUsed ? 'disabled' : ''}>${wagerMode === 'golden' ? 'Goldener Deckel aktiv ✓' : 'Goldener Deckel (+2 / −5)'}</button>` : ''}
        ${!jokerUsed ? `<button class="btn btn-secondary wager-btn" id="joker-btn">Joker (Frage überspringen)</button>` : ''}
      </div>`;
  }

  function timerHtml() {
    if (timerRemaining == null) return '';
    const total = height >= TIMER_HARD_HEIGHT ? TIMER_SECONDS_HARD : TIMER_SECONDS_MEDIUM;
    const pct = Math.round((timerRemaining / total) * 100);
    return `
      <div class="challenge-timer">
        <div class="progress-wrap"><div class="progress-bar ${timerRemaining <= 3 ? 'timer-urgent' : ''}" style="width:${pct}%"></div></div>
        <div class="progress-text">${timerRemaining}s</div>
      </div>`;
  }

  function renderActive() {
    const q = currentQuestion;
    container.innerHTML = `
      <div class="quiz-mode challenge-mode">
        ${towerHtml(Math.max(height, 0))}
        <div class="quiz-content">
          ${timerHtml()}
          <p class="hint center-text">${escapeHtml(q.promptLabel)}</p>
          <div class="quiz-word">${escapeHtml(q.prompt)}</div>
          ${wagerMode !== 'normal' ? `<p class="hint center-text wager-active-hint">${wagerMode === 'golden' ? '🏆 Goldener Deckel aktiv' : '⚡ Doppelt-Einsatz aktiv'}</p>` : ''}
          <div class="quiz-options">
            ${q.options.map((opt, i) => `<button class="btn btn-option" data-opt="${i}">${escapeHtml(opt)}</button>`).join('')}
          </div>
          ${wagerControlsHtml()}
        </div>
        <button class="btn btn-secondary btn-with-icon" id="cashout-btn"><span class="icon-inline-wrap">${checkCircleIcon}</span> Aufhören &amp; Sichern (Höhe ${Math.max(height, 0)})</button>
      </div>`;

    container.querySelectorAll('.btn-option').forEach((btn, i) => {
      btn.addEventListener('click', () => submitAnswer(i));
    });
    container.querySelector('#double-btn')?.addEventListener('click', toggleDouble);
    container.querySelector('#golden-btn')?.addEventListener('click', useGolden);
    container.querySelector('#joker-btn')?.addEventListener('click', useJoker);
    container.querySelector('#cashout-btn').addEventListener('click', cashOut);
  }

  function renderRevealed() {
    const q = currentQuestion;
    const correctAnswer = q.options[q.correctIndex];
    container.innerHTML = `
      <div class="quiz-mode challenge-mode">
        ${towerHtml(Math.max(height, 0))}
        <div class="quiz-content">
          <div class="quiz-word">${escapeHtml(q.prompt)}</div>
          <div class="quiz-options">
            ${q.options.map((opt, i) => {
              let cls = 'btn btn-option disabled';
              if (i === q.correctIndex) cls += ' correct';
              else if (i === selectedIndex) cls += ' incorrect';
              return `<button class="${cls}" disabled>${escapeHtml(opt)}</button>`;
            }).join('')}
          </div>
          <p class="hint btn-with-icon"><span class="icon-inline-wrap">${lastCorrect ? checkCircleIcon : xCircleIcon}</span> ${lastCorrect ? 'Richtig!' : `Richtig wäre: ${escapeHtml(correctAnswer)}`} (${lastDelta > 0 ? '+' : ''}${lastDelta})</p>
          ${q.example ? `<p class="example-sentence">${escapeHtml(q.example)}</p>` : ''}
          ${q.explanation ? `<p class="grammar-explanation">${escapeHtml(q.explanation)}</p>` : ''}
        </div>
        <button class="btn btn-huge btn-compact btn-primary btn-with-icon" id="next-btn">Weiter <span class="icon-inline-wrap">${playIcon}</span></button>
      </div>`;
    container.querySelector('#next-btn').addEventListener('click', proceedAfterReveal);
  }

  function renderCollapsing() {
    container.innerHTML = `
      <div class="quiz-mode challenge-mode pad center">
        ${towerHtml(lastCheckpoint > 0 ? lastCheckpoint + 3 : 3, { collapseAbove: lastCheckpoint })}
        <p class="hint center-text">Der Turm stürzt ein …</p>
      </div>`;
  }

  function renderBoss() {
    const q = bossQueue[bossIndex];
    const correctAnswer = q.options[q.correctIndex];
    container.innerHTML = `
      <div class="quiz-mode challenge-mode pad">
        <h3>Endgegner-Runde</h3>
        ${progressBarHtml(bossIndex, bossQueue.length)}
        <p class="hint center-text">Kein Timer, kein Turm-Effekt — reiner Lernteil für deine Fehler.</p>
        <div class="quiz-word">${escapeHtml(q.prompt)}</div>
        <div class="quiz-options">
          ${q.options.map((opt, i) => {
            if (!bossAnswered) return `<button class="btn btn-option" data-opt="${i}">${escapeHtml(opt)}</button>`;
            const cls = `btn btn-option disabled${i === q.correctIndex ? ' correct' : ''}`;
            return `<button class="${cls}" disabled>${escapeHtml(opt)}</button>`;
          }).join('')}
        </div>
        ${bossAnswered ? `
          <p class="hint btn-with-icon"><span class="icon-inline-wrap">${bossCorrect ? checkCircleIcon : xCircleIcon}</span> ${bossCorrect ? 'Richtig!' : `Richtig wäre: ${escapeHtml(correctAnswer)}`}</p>
          ${q.example ? `<p class="example-sentence">${escapeHtml(q.example)}</p>` : ''}
          ${q.explanation ? `<p class="grammar-explanation">${escapeHtml(q.explanation)}</p>` : ''}
          <button class="btn btn-huge btn-compact btn-primary btn-with-icon" id="boss-next-btn">Weiter <span class="icon-inline-wrap">${playIcon}</span></button>
        ` : ''}
      </div>`;
    if (!bossAnswered) {
      container.querySelectorAll('.btn-option').forEach((btn, i) => {
        btn.addEventListener('click', () => submitBossAnswer(i));
      });
    } else {
      container.querySelector('#boss-next-btn').addEventListener('click', nextBossQuestion);
    }
  }

  function endReasonLabel() {
    if (endReason === 'collapse') return 'Turm eingestürzt';
    if (endReason === 'cashout') return 'Rechtzeitig aufgehört';
    if (endReason === 'maxHeight') return 'Maximalhöhe erreicht!';
    return '';
  }

  function renderResults() {
    const accuracy = sessionStats.questionsAsked > 0
      ? Math.round((sessionStats.questionsCorrect / sessionStats.questionsAsked) * 100)
      : 0;
    const isNewBest = height >= bestHeight && height > 0 && sessionStats.questionsAsked > 0;
    container.innerHTML = `
      <div class="quiz-mode challenge-mode pad center">
        <h2 class="btn-with-icon"><span class="icon-inline-wrap icon-lg">${starIcon}</span> ${endReasonLabel()}</h2>
        ${towerHtml(Math.max(height, 0))}
        ${isNewBest ? `<p class="hint center-text new-best-hint">🎉 Neuer Bestwert!</p>` : ''}
        <p class="hint">Erreichte Höhe: <strong>${Math.max(height, 0)}</strong> · Bestwert: <strong>${bestHeight}</strong></p>
        <p class="hint">${sessionStats.questionsCorrect} von ${sessionStats.questionsAsked} richtig (${accuracy}%)</p>
        ${sessionStats.wrongQuestions.length > 0 ? `
          <div class="challenge-error-list">
            <p class="hint">Fehler in dieser Runde:</p>
            <ul>
              ${sessionStats.wrongQuestions.map((q) => `<li>${escapeHtml(q.prompt)} → ${escapeHtml(q.options[q.correctIndex])}</li>`).join('')}
            </ul>
          </div>` : ''}
        <button class="btn btn-huge btn-primary btn-with-icon" id="again-btn"><span class="icon-inline-wrap icon-lg">${refreshIcon}</span> Neue Runde</button>
        <button class="btn btn-secondary" id="switch-btn">Zurück</button>
      </div>`;
    container.querySelector('#again-btn').addEventListener('click', startSession);
    container.querySelector('#switch-btn').addEventListener('click', backToSelect);
  }

  function render() {
    if (phase === 'select') return renderSelect();
    if (phase === 'empty') return renderEmpty();
    if (phase === 'loading') return renderLoading();
    if (phase === 'active') return renderActive();
    if (phase === 'revealed') return renderRevealed();
    if (phase === 'collapsing') return renderCollapsing();
    if (phase === 'boss') return renderBoss();
    if (phase === 'results') return renderResults();
  }

  (async () => {
    bestHeight = await challengeStore.getBestHeight();
    if (phase === 'select') render();
  })();

  render();

  return () => {
    clearTimer();
  };
}
