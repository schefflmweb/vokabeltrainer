import { getNextQuestion } from '../data/challengeQuestions.js';
import { challengeStore } from '../data/challengeStore.js';
import { toneService } from '../audio/toneService.js';
import { progressBarHtml } from '../ui/progressBar.js';
import { answersMatch } from '../util/answerMatch.js';
import {
  playIcon, refreshIcon, starIcon, checkCircleIcon, xCircleIcon, hourglassIcon, warningIcon
} from '../ui/icons.js';

// A full pyramid: seven rows of triangles, from seven at the base to one at
// the top (see TIER_CAPACITIES), which is as wide and as tall as a phone
// screen fits. Every height point is one more triangle, so the last one
// placed completes the tower.
const MAX_HEIGHT = 28;
// One per completed row — a row that's finished is what makes a real tower stable.
const CHECKPOINTS = [7, 13, 18, 22];
const WAGER_UNLOCK_HEIGHT = 11;
const GOLDEN_UNLOCK_HEIGHT = 17;
const TIMER_START_HEIGHT = 14;
const TIMER_HARD_HEIGHT = 21;
// From here on a plain wrong answer costs three coasters instead of two.
const HARSH_PENALTY_HEIGHT = 21;
const TIMER_SECONDS_MEDIUM = 15;
// How long the answer stays coloured on the question screen before the tower page takes over.
const REVEAL_FLASH_MS = 200;
const TIMER_SECONDS_HARD = 10;

// Cannon rounds: no options, type the word yourself. Get it wrong and a
// cannonball takes out a random row — and everything resting on it.
const CANNON_MIN_HEIGHT = 6;
const CANNON_CHANCE = 0.3;
const CANNON_REWARD = 2;
const TIMER_SECONDS_CANNON = 25;
const CANNON_FLIGHT_MS = 550;
const CANNON_IMPACT_MS = 900;

// Gusts: between two questions the tower can be caught by the wind, and only
// a quick right answer keeps the top row on.
const WIND_MIN_HEIGHT = 12;
const WIND_CHANCE = 0.2;
const WIND_SECONDS = 6;

function computeDelta(correct, height, wagerMode) {
  if (wagerMode === 'golden') return correct ? 2 : -5;
  if (wagerMode === 'double') return correct ? 2 : -3;
  if (correct) return 1;
  return height >= HARSH_PENALTY_HEIGHT ? -3 : -2;
}

/** A checkpoint is "reached" once height first exceeds it — from then on, falling back to or below it collapses the tower. 0 counts as the implicit starting checkpoint (the ground), so an early bad run before the first checkpoint can still collapse. */
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
  let phase = 'select'; // 'select' | 'loading' | 'active' | 'revealed' | 'stacking' | 'collapsing' | 'boss' | 'results' | 'empty'
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
  let timerTotal = null;
  // Height before the current answer, so the tower page can animate whatever it just gained.
  let heightBeforeAnswer = 0;
  let stackingHandle = null;
  // Cannon round state: the current question is typed, not picked.
  let cannonQuestion = false;
  let typedAnswer = '';
  let cannonStage = null; // 'incoming' | 'impact'
  let cannonTargetHeight = 0;
  let cannonHandle = null;
  // Gust state
  let windQuestion = null;
  let windSelected = null;
  let windJustHappened = false;
  // Replaces the plain answer feedback on the tower page when a cannon or gust decided the outcome.
  let towerEvent = null;

  function clearCannonTimer() {
    if (cannonHandle) {
      clearTimeout(cannonHandle);
      cannonHandle = null;
    }
  }

  function clearStackingTimer() {
    if (stackingHandle) {
      clearTimeout(stackingHandle);
      stackingHandle = null;
    }
  }

  function clearTimer() {
    if (timerHandle) {
      clearInterval(timerHandle);
      timerHandle = null;
    }
    timerRemaining = null;
    timerTotal = null;
  }

  function startCountdown(seconds, onExpire) {
    clearTimer();
    timerRemaining = seconds;
    timerTotal = seconds;
    timerHandle = setInterval(() => {
      timerRemaining -= 1;
      if (timerRemaining <= 0) {
        clearTimer();
        onExpire();
      } else {
        // Patching the bar in place rather than re-rendering keeps a half-typed
        // cannon answer (and the keyboard focus) alive through every tick.
        updateTimerDisplay();
      }
    }, 1000);
  }

  function updateTimerDisplay() {
    const bar = container.querySelector('.challenge-timer .progress-bar');
    const text = container.querySelector('.challenge-timer .progress-text');
    if (!bar || !text) {
      render();
      return;
    }
    bar.style.width = `${Math.round((timerRemaining / timerTotal) * 100)}%`;
    bar.classList.toggle('timer-urgent', timerRemaining <= 3);
    text.textContent = `${timerRemaining}s`;
  }

  function startTimerIfNeeded() {
    clearTimer();
    if (height < TIMER_START_HEIGHT) return;
    // Typing takes longer than tapping an option, so cannon rounds get their own allowance.
    const seconds = cannonQuestion
      ? TIMER_SECONDS_CANNON
      : (height >= TIMER_HARD_HEIGHT ? TIMER_SECONDS_HARD : TIMER_SECONDS_MEDIUM);
    startCountdown(seconds, () => submitAnswer(-1)); // timeout counts as a wrong answer
  }

  function startSession() {
    clearStackingTimer();
    clearCannonTimer();
    height = 0;
    lastCheckpoint = 0;
    jokerUsed = false;
    goldenUsed = false;
    wagerMode = 'normal';
    cannonQuestion = false;
    typedAnswer = '';
    towerEvent = null;
    windJustHappened = false;
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
    towerEvent = null;
    typedAnswer = '';
    windJustHappened = false;
    // Grammar questions come with their own hand-written options, so only
    // vocab and idioms can be turned into a typed cannon round.
    cannonQuestion = q.pot !== 'grammar'
      && height >= CANNON_MIN_HEIGHT
      && Math.random() < CANNON_CHANCE;
    phase = 'active';
    startTimerIfNeeded();
    render();
  }

  function correctAnswerText(q) {
    return q.options[q.correctIndex];
  }

  /** Cannon rounds are answered by typing; anything close enough counts (same tolerance as Quiz). */
  function submitTypedAnswer(value) {
    if (phase !== 'active') return;
    typedAnswer = value;
    submitAnswer(answersMatch(value, correctAnswerText(currentQuestion)) ? currentQuestion.correctIndex : -1);
  }

  function submitAnswer(index) {
    if (phase !== 'active') return;
    clearTimer();
    selectedIndex = index;
    const correct = index === currentQuestion.correctIndex;
    lastCorrect = correct;
    heightBeforeAnswer = Math.max(height, 0);
    lastDelta = cannonQuestion && correct ? CANNON_REWARD : computeDelta(correct, height, wagerMode);
    sessionStats.questionsAsked += 1;
    if (correct) {
      sessionStats.questionsCorrect += 1;
    } else {
      sessionStats.wrongQuestions.push(currentQuestion);
    }

    // A missed cannon round isn't a plain deduction: the cannonball decides
    // how much of the tower is left, so the height is set when it lands.
    if (cannonQuestion && !correct) {
      lastDelta = null;
      toneService.playIncorrect();
      phase = 'revealed';
      render();
      clearStackingTimer();
      stackingHandle = setTimeout(() => {
        stackingHandle = null;
        if (phase === 'revealed') fireCannon();
      }, REVEAL_FLASH_MS);
      return;
    }

    height += lastDelta;
    lastCheckpoint = updateCheckpoint(lastCheckpoint, height);
    if (correct) toneService.playCoasterPlace(Math.max(height, 0));
    else toneService.playIncorrect();
    // Show the answer colours just long enough to register, then hand the
    // whole screen over to the tower — it needs the room to grow.
    phase = 'revealed';
    render();
    clearStackingTimer();
    stackingHandle = setTimeout(() => {
      stackingHandle = null;
      if (phase !== 'revealed') return;
      phase = 'stacking';
      render();
    }, REVEAL_FLASH_MS);
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

  /** Cumulative heights at which each row of the pyramid is complete, e.g. [7, 13, 18, …]. */
  function rowEnds() {
    const ends = [];
    let sum = 0;
    for (const cap of TIER_CAPACITIES) {
      sum += cap;
      ends.push(sum);
    }
    return ends;
  }

  /** What's left standing when everything from `rowIndex` upward comes off. */
  function heightBelowRow(rowIndex) {
    return rowIndex === 0 ? 0 : rowEnds()[rowIndex - 1];
  }

  /** The row the topmost coaster sits in. */
  function topRowIndex(h) {
    const ends = rowEnds();
    for (let i = 0; i < ends.length; i++) {
      if (h <= ends[i]) return i;
    }
    return ends.length - 1;
  }

  /**
   * A missed cannon round. The ball picks a row at random — checkpoints don't
   * shield it — and everything from there up comes down with it.
   */
  function fireCannon() {
    const standingRows = topRowIndex(Math.max(height, 0)) + 1;
    const hitRow = Math.floor(Math.random() * standingRows);
    cannonTargetHeight = heightBelowRow(hitRow);
    cannonStage = 'incoming';
    phase = 'cannon';
    render();
    clearCannonTimer();
    cannonHandle = setTimeout(() => {
      cannonStage = 'impact';
      toneService.playCollapse();
      render();
      cannonHandle = setTimeout(() => {
        cannonHandle = null;
        const lost = Math.max(height, 0) - cannonTargetHeight;
        heightBeforeAnswer = Math.max(height, 0);
        height = cannonTargetHeight;
        towerEvent = {
          icon: xCircleIcon,
          text: `Volltreffer in Reihe ${hitRow + 1} — ${lost} Deckel weg. Richtig wäre: ${correctAnswerText(currentQuestion)}`
        };
        phase = 'stacking';
        render();
      }, CANNON_IMPACT_MS);
    }, CANNON_FLIGHT_MS);
  }

  function rollWind() {
    return !windJustHappened && height >= WIND_MIN_HEIGHT && Math.random() < WIND_CHANCE;
  }

  async function startWind() {
    windJustHappened = true;
    phase = 'loading';
    render();
    const q = await getNextQuestion(height);
    if (!q) {
      phase = 'loading';
      render();
      loadNextQuestion();
      return;
    }
    windQuestion = q;
    windSelected = null;
    phase = 'wind';
    // Countdown first, so the very first paint already shows the full bar.
    startCountdown(WIND_SECONDS, () => submitWindAnswer(-1));
    render();
  }

  function submitWindAnswer(index) {
    if (phase !== 'wind') return;
    clearTimer();
    windSelected = index;
    heightBeforeAnswer = Math.max(height, 0);
    lastDelta = null;
    if (index === windQuestion.correctIndex) {
      towerEvent = { icon: checkCircleIcon, text: 'Böe überstanden — der Turm hält!' };
    } else {
      const newHeight = heightBelowRow(topRowIndex(Math.max(height, 0)));
      const lost = Math.max(height, 0) - newHeight;
      height = newHeight;
      toneService.playCollapse();
      towerEvent = {
        icon: xCircleIcon,
        text: `Die Böe fegt die oberste Reihe weg — ${lost} Deckel weg. Richtig wäre: ${correctAnswerText(windQuestion)}`
      };
    }
    phase = 'stacking';
    render();
  }

  function proceedAfterReveal() {
    clearStackingTimer();
    towerEvent = null;
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
    if (rollWind()) {
      startWind();
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
    clearStackingTimer();
    clearCannonTimer();
    phase = 'select';
    render();
  }

  // --- Rendering ---

  // A real coaster tower is built from A-frame triangles (two coasters leaned
  // against each other), several triangles side by side per row, with the
  // next (narrower) row resting on a bridge across the row below — a stepped
  // pyramid. TIER_CAPACITIES (bottom to top) sums to exactly MAX_HEIGHT, so
  // every height point maps to one more triangle somewhere in the pyramid.
  const TIER_CAPACITIES = [7, 6, 5, 4, 3, 2, 1];
  const TRIANGLE_H = 40;
  const TIER_GAP = 4;
  const BRIDGE_H = 7;

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
    const justPlaced = opts.newAbove != null && levelIndex > opts.newAbove;
    const cls = [
      'coaster-triangle',
      isCheckpoint && 'coaster-triangle-checkpoint',
      falling && 'coaster-triangle-falling',
      justPlaced && 'coaster-triangle-new'
    ].filter(Boolean).join(' ');
    return `<div class="${cls}">
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
      if (tier.count === tier.cap && !isTopTier) {
        // One flat coaster per triangle of the row above, so each plate lands
        // where a triangle actually rests on it. Before that row exists, a
        // single plate already sits there, ready for the next triangle.
        const plateCount = Math.max(1, tiers[idx + 1]?.count ?? 0);
        const plateFalls = opts.collapseAbove != null && tier.start + tier.cap - 1 >= opts.collapseAbove;
        const plate = `<div class="tier-plate${plateFalls ? ' tier-plate-falling' : ''}"></div>`;
        rows += `<div class="tier-plates">${plate.repeat(plateCount)}</div>`;
      }
    });
    // Only worth drawing while it's still a target ahead — once passed, the
    // line would just cut across the tower it's meant to celebrate.
    const bestMarker = bestHeight > displayHeight && bestHeight <= MAX_HEIGHT
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
        <p class="hint">Jede richtige Antwort legt einen Deckel auf den Turm. Fehler lassen ihn wackeln — jede fertige Reihe (Höhe ${CHECKPOINTS.join('/')}) sichert deinen Stand, darunter stürzt alles ein. Ganz oben wartet die fertige Pyramide mit ${MAX_HEIGHT} Deckeln!</p>
        <p class="hint">Ab Höhe ${CANNON_MIN_HEIGHT} kommen Kanonen-Fragen: Lösung eintippen statt auswählen — daneben, und die Kanone schießt eine zufällige Reihe weg. Ab Höhe ${WIND_MIN_HEIGHT} können Böen an der obersten Reihe zerren.</p>
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
    // Wagers don't mix with a cannon round — the cannon already sets the stakes.
    if (cannonQuestion) {
      return jokerUsed ? '' : `<div class="wager-controls"><button class="btn btn-secondary wager-btn" id="joker-btn">Joker (Frage überspringen)</button></div>`;
    }
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

  function cannonInputHtml(answered) {
    if (answered) {
      const correct = lastCorrect;
      return `
        <div class="cannon-answer ${correct ? 'correct' : 'incorrect'}">${escapeHtml(typedAnswer) || '—'}</div>`;
    }
    return `
      <form id="cannon-form" class="typing-form">
        <input type="text" id="cannon-input" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="send" placeholder="Lösung eintippen" />
        <button type="submit" class="btn btn-huge btn-compact btn-primary btn-with-icon"><span class="icon-inline-wrap">${checkCircleIcon}</span> Abgeben</button>
      </form>`;
  }

  function timerHtml() {
    if (timerRemaining == null) return '';
    const pct = Math.round((timerRemaining / timerTotal) * 100);
    return `
      <div class="challenge-timer">
        <div class="progress-wrap"><div class="progress-bar ${timerRemaining <= 3 ? 'timer-urgent' : ''}" style="width:${pct}%"></div></div>
        <div class="progress-text">${timerRemaining}s</div>
      </div>`;
  }

  /**
   * The question screen. The tower is deliberately absent here — it gets the
   * whole screen to itself once the answer is in (see renderStacking), so it
   * has room to grow. `answered` only recolours the options, keeping the
   * layout identical so nothing shifts during that brief moment.
   */
  function renderQuestion(answered) {
    const q = currentQuestion;
    container.innerHTML = `
      <div class="quiz-mode challenge-mode">
        <div class="quiz-content">
          <p class="hint center-text challenge-height-line">Turmhöhe ${Math.max(heightAtQuestion(answered), 0)}${lastCheckpoint > 0 ? ` · gesichert bei ${lastCheckpoint}` : ''}</p>
          ${timerHtml()}
          ${cannonQuestion ? `<p class="cannon-warning center-text">💥 Kanonen-Frage — tippe die Lösung. Richtig: +${CANNON_REWARD}. Falsch: die Kanone feuert.</p>` : ''}
          <p class="hint center-text">${escapeHtml(q.promptLabel)}</p>
          <div class="quiz-word">${escapeHtml(q.prompt)}</div>
          ${wagerMode !== 'normal' && !cannonQuestion ? `<p class="hint center-text wager-active-hint">${wagerMode === 'golden' ? '🏆 Goldener Deckel aktiv' : '⚡ Doppelt-Einsatz aktiv'}</p>` : ''}
          ${cannonQuestion ? cannonInputHtml(answered) : `
          <div class="quiz-options">
            ${q.options.map((opt, i) => {
              if (!answered) return `<button class="btn btn-option" data-opt="${i}">${escapeHtml(opt)}</button>`;
              let cls = 'btn btn-option disabled';
              if (i === q.correctIndex) cls += ' correct';
              else if (i === selectedIndex) cls += ' incorrect';
              return `<button class="${cls}" disabled>${escapeHtml(opt)}</button>`;
            }).join('')}
          </div>`}
          ${wagerControlsHtml()}
        </div>
        <button class="btn btn-secondary btn-with-icon" id="cashout-btn" ${answered ? 'disabled' : ''}><span class="icon-inline-wrap">${checkCircleIcon}</span> Aufhören &amp; Sichern (Höhe ${Math.max(heightAtQuestion(answered), 0)})</button>
      </div>`;

    if (answered) return;
    if (cannonQuestion) {
      const input = container.querySelector('#cannon-input');
      // preventScroll: this layout positions itself; iOS's own scroll-into-view fights it.
      input.focus({ preventScroll: true });
      container.querySelector('#cannon-form').addEventListener('submit', (e) => {
        e.preventDefault();
        // An accidental empty submit shouldn't be what fires the cannon.
        if (!input.value.trim()) return;
        submitTypedAnswer(input.value);
      });
    }
    container.querySelectorAll('.btn-option').forEach((btn, i) => {
      btn.addEventListener('click', () => submitAnswer(i));
    });
    container.querySelector('#double-btn')?.addEventListener('click', toggleDouble);
    container.querySelector('#golden-btn')?.addEventListener('click', useGolden);
    container.querySelector('#joker-btn')?.addEventListener('click', useJoker);
    container.querySelector('#cashout-btn').addEventListener('click', cashOut);
  }

  /** The height already counts the answer that was just given; the question screen should keep showing the height it was asked at. */
  function heightAtQuestion(answered) {
    return answered ? heightBeforeAnswer : height;
  }

  /** The tower gets the screen to itself here, so it can grow without the question crowding it. */
  function renderStacking() {
    const q = currentQuestion;
    const correctAnswer = q.options[q.correctIndex];
    const towerOpts = lastDelta > 0 ? { newAbove: heightBeforeAnswer } : {};
    const note = towerEvent || {
      icon: lastCorrect ? checkCircleIcon : xCircleIcon,
      text: `${lastCorrect ? 'Richtig!' : `Richtig wäre: ${correctAnswer}`} (${lastDelta > 0 ? '+' : ''}${lastDelta})`
    };
    container.innerHTML = `
      <div class="quiz-mode challenge-mode pad center tower-stage">
        ${towerHtml(Math.max(height, 0), towerOpts)}
        <p class="hint btn-with-icon center-text"><span class="icon-inline-wrap">${note.icon}</span> ${escapeHtml(note.text)}</p>
        ${!towerEvent && q.explanation ? `<p class="grammar-explanation">${escapeHtml(q.explanation)}</p>` : ''}
        <button class="btn btn-huge btn-compact btn-primary btn-with-icon" id="next-btn">Weiter <span class="icon-inline-wrap">${playIcon}</span></button>
      </div>`;
    container.querySelector('#next-btn').addEventListener('click', proceedAfterReveal);
  }

  /** The cannonball flying in, then the rows it took with it. */
  function renderCannon() {
    const hit = cannonStage === 'impact';
    container.innerHTML = `
      <div class="quiz-mode challenge-mode pad center tower-stage cannon-stage">
        <div class="cannon-field">
          ${towerHtml(Math.max(height, 0), hit ? { collapseAbove: cannonTargetHeight } : {})}
          <div class="cannonball${hit ? ' cannonball-hit' : ''}"></div>
        </div>
        <p class="cannon-warning center-text">${hit ? '💥 Volltreffer!' : '💥 Die Kanone feuert …'}</p>
      </div>`;
  }

  /** A gust mid-run: one quick question stands between the top row and the floor. */
  function renderWind() {
    const q = windQuestion;
    container.innerHTML = `
      <div class="quiz-mode challenge-mode">
        <div class="quiz-content">
          <p class="cannon-warning center-text">💨 Eine Böe erfasst den Turm! Schnell richtig antworten, sonst fällt die oberste Reihe.</p>
          ${timerHtml()}
          <p class="hint center-text">${escapeHtml(q.promptLabel)}</p>
          <div class="quiz-word">${escapeHtml(q.prompt)}</div>
          <div class="quiz-options">
            ${q.options.map((opt, i) => `<button class="btn btn-option" data-opt="${i}">${escapeHtml(opt)}</button>`).join('')}
          </div>
        </div>
      </div>`;
    container.querySelectorAll('.btn-option').forEach((btn, i) => {
      btn.addEventListener('click', () => submitWindAnswer(i));
    });
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
    if (phase === 'active') return renderQuestion(false);
    if (phase === 'revealed') return renderQuestion(true);
    if (phase === 'stacking') return renderStacking();
    if (phase === 'cannon') return renderCannon();
    if (phase === 'wind') return renderWind();
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
    clearStackingTimer();
    clearCannonTimer();
  };
}
