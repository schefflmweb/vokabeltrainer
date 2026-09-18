import { getNextQuestion } from '../data/challengeQuestions.js';
import { challengeStore } from '../data/challengeStore.js';
import { toneService } from '../audio/toneService.js';
import { progressBarHtml } from '../ui/progressBar.js';
import { answersMatch } from '../util/answerMatch.js';
import {
  playIcon, refreshIcon, starIcon, checkCircleIcon, xCircleIcon, hourglassIcon, warningIcon
} from '../ui/icons.js';

// The finished tower: rows of leaning triangles with flat coasters bridging
// each adjacent pair, narrowing to a single triangle at the top. Seven
// triangles at the base is as wide as a phone screen fits. UNITS below decides
// the order they actually go up in.
const TIER_CAPACITIES = [7, 6, 5, 4, 3, 2, 1];

/** Every band of coasters, bottom to top — the rows the tower is laid out in. */
const BANDS = [];
TIER_CAPACITIES.forEach((cap, i) => {
  BANDS.push({ kind: 'triangles', count: cap });
  // One flat coaster per pair of neighbours — that's what the next row rests on.
  if (i < TIER_CAPACITIES.length - 1) BANDS.push({ kind: 'plates', count: cap - 1 });
});

const triangleBand = (level) => level * 2;
const plateBand = (level) => level * 2 + 1;

/**
 * The order the coasters go up in — not row by row, but the way you'd really
 * build it: two coasters leaned into a triangle, a flat one across their top,
 * a triangle on that, and then on up as far as the tower allows, one level per
 * round. Only when nothing more can go on top does the next base start to the
 * right — and since a flat coaster needs two triangles under it, each new base
 * lets the stack climb exactly one level higher than the last.
 */
const UNITS = [];
/** The level of the highest coaster in each unit, and which climb it belongs to. */
const UNIT_LEVELS = [];
const CLIMBS = [];
{
  const triangles = TIER_CAPACITIES.map(() => 0);
  const plates = TIER_CAPACITIES.slice(0, -1).map(() => 0);
  for (let base = 0; base < TIER_CAPACITIES[0] - 1; base++) {
    const firstUnit = UNITS.length;
    // A new base on the right: the first one needs two coasters, every later
    // one leans on its neighbour and needs just one.
    const baseSlots = [];
    for (let n = 0; n < (base === 0 ? 2 : 1); n++) {
      baseSlots.push({ band: triangleBand(0), index: triangles[0] });
      triangles[0] += 1;
    }
    UNITS.push(baseSlots);
    UNIT_LEVELS.push(0);
    // Then upward while two neighbouring triangles are free to be bridged.
    for (let level = 0; level < TIER_CAPACITIES.length - 1; level++) {
      if (triangles[level] < plates[level] + 2) break;
      UNITS.push([
        { band: plateBand(level), index: plates[level] },
        { band: triangleBand(level + 1), index: triangles[level + 1] }
      ]);
      UNIT_LEVELS.push(level + 1);
      plates[level] += 1;
      triangles[level + 1] += 1;
    }
    CLIMBS.push({ firstUnit, lastUnit: UNITS.length - 1 });
  }
}

/** Which round each coaster of the tower is placed in, keyed "band:index". */
const STEP_OF_SLOT = new Map();
/** The height at which each unit is finished. */
const UNIT_ENDS = [];
UNITS.forEach((slots, unitIndex) => {
  let step = UNIT_ENDS[unitIndex - 1] || 0;
  slots.forEach((slot) => {
    step += 1;
    STEP_OF_SLOT.set(`${slot.band}:${slot.index}`, step);
  });
  UNIT_ENDS.push(step);
});

const MAX_HEIGHT = UNIT_ENDS[UNIT_ENDS.length - 1];
/**
 * Safe points: a finished climb leaves the tower at rest, so that's where they
 * sit — plus one part-way up the longer climbs, which would otherwise leave a
 * dozen rounds without a net.
 */
const CHECKPOINTS = [];
CLIMBS.forEach(({ firstUnit, lastUnit }) => {
  const start = firstUnit === 0 ? 0 : UNIT_ENDS[firstUnit - 1];
  const end = UNIT_ENDS[lastUnit];
  if (end - start > 6) {
    const middle = (start + end) / 2;
    let nearest = null;
    for (let u = firstUnit; u < lastUnit; u++) {
      if (nearest === null || Math.abs(UNIT_ENDS[u] - middle) < Math.abs(nearest - middle)) nearest = UNIT_ENDS[u];
    }
    CHECKPOINTS.push(nearest);
  }
  if (end < MAX_HEIGHT) CHECKPOINTS.push(end);
});
const WAGER_UNLOCK_HEIGHT = 19;
const GOLDEN_UNLOCK_HEIGHT = 30;
const TIMER_START_HEIGHT = 24;
const TIMER_HARD_HEIGHT = 37;
// From here on a plain wrong answer costs three coasters instead of two.
const HARSH_PENALTY_HEIGHT = 37;

/** The unit that height `h` falls in — the one currently being built. */
function unitIndexOf(h) {
  for (let i = 0; i < UNIT_ENDS.length; i++) {
    if (h <= UNIT_ENDS[i]) return i;
  }
  return UNIT_ENDS.length - 1;
}

/** What's left standing when the given unit, and everything built after it, comes down. */
function heightBelowUnit(unitIndex) {
  return unitIndex === 0 ? 0 : UNIT_ENDS[unitIndex - 1];
}
const TIMER_SECONDS_MEDIUM = 15;
// How long the answer stays coloured on the question screen before the tower page takes over.
const REVEAL_FLASH_MS = 200;
// Matches the falling animation in the stylesheet.
const TOPPLE_MS = 700;
const TIMER_SECONDS_HARD = 10;

// Cannon rounds: no options, type the word yourself. Get it wrong and a
// cannonball takes out a random unit — and everything resting on it.
const CANNON_MIN_HEIGHT = 10;
const CANNON_CHANCE = 0.3;
const CANNON_REWARD = 2;
const TIMER_SECONDS_CANNON = 25;
const CANNON_FLIGHT_MS = 550;
const CANNON_IMPACT_MS = 900;

// Gusts: between two questions the tower can be caught by the wind, and only
// a quick right answer keeps the top row on.
const WIND_MIN_HEIGHT = 21;
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
  // The height the tower is falling back from, while its lost coasters tumble off.
  let topplingFrom = 0;
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
    lastZoom = null; // a new tower starts with the camera close in again
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
      showTowerUpdate();
    }, REVEAL_FLASH_MS);
  }

  /**
   * Hands the screen to the tower. Coasters the answer cost are still drawn,
   * tumbling off, before the tower settles at its new height — losing them
   * should be as visible as placing them.
   */
  function showTowerUpdate(lostFrom = heightBeforeAnswer) {
    const settled = Math.max(height, 0);
    if (lostFrom <= settled) {
      phase = 'stacking';
      render();
      return;
    }
    topplingFrom = lostFrom;
    phase = 'toppling';
    render();
    clearStackingTimer();
    stackingHandle = setTimeout(() => {
      stackingHandle = null;
      if (phase !== 'toppling') return;
      phase = 'stacking';
      render();
    }, TOPPLE_MS);
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

  /**
   * A missed cannon round. The ball picks one of the tower's units at random —
   * checkpoints don't shield it — and that unit, plus everything built on and
   * after it, comes down.
   */
  function fireCannon() {
    const standingUnits = unitIndexOf(Math.max(height, 0)) + 1;
    const hitUnit = Math.floor(Math.random() * standingUnits);
    const hitLevel = UNIT_LEVELS[hitUnit] + 1;
    cannonTargetHeight = heightBelowUnit(hitUnit);
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
          text: `Volltreffer in Ebene ${hitLevel} — ${lost} Deckel weg. Richtig wäre: ${correctAnswerText(currentQuestion)}`
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
      const newHeight = heightBelowUnit(unitIndexOf(Math.max(height, 0)));
      const lost = Math.max(height, 0) - newHeight;
      height = newHeight;
      toneService.playCollapse();
      towerEvent = {
        icon: xCircleIcon,
        text: `Die Böe weht den obersten Abschnitt weg — ${lost} Deckel weg. Richtig wäre: ${correctAnswerText(windQuestion)}`
      };
    }
    showTowerUpdate();
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

  /** The round the first coaster of this band goes up in — the band exists from then on. */
  function bandFirstStep(bandIndex) {
    let earliest = Infinity;
    for (let i = 0; i < BANDS[bandIndex].count; i++) {
      earliest = Math.min(earliest, STEP_OF_SLOT.get(`${bandIndex}:${i}`));
    }
    return earliest;
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
      ${coasterSvg('left')}
      ${coasterSvg('right')}
    </div>`;
  }

  function plateEl(levelIndex, opts = {}) {
    const falling = opts.collapseAbove != null && levelIndex > opts.collapseAbove;
    const justPlaced = opts.newAbove != null && levelIndex > opts.newAbove;
    return plateSvg(`${falling ? ' tier-plate-falling' : ''}${justPlaced ? ' tier-plate-new' : ''}`);
  }

  /**
   * Every band is laid out at its finished width, with the coasters that
   * aren't placed yet left as invisible slots. That keeps each flat coaster on
   * the two triangles it bridges and the row above exactly on those, whichever
   * order they went up in.
   */
  function bandHtml(bandIndex, opts) {
    const band = BANDS[bandIndex];
    let items = '';
    for (let i = 0; i < band.count; i++) {
      const step = STEP_OF_SLOT.get(`${bandIndex}:${i}`);
      if (step > opts.displayHeight) {
        items += band.kind === 'triangles'
          ? '<div class="coaster-triangle coaster-slot"></div>'
          : '<div class="tier-plate coaster-slot"></div>';
        continue;
      }
      items += band.kind === 'triangles' ? triangleEl(step, opts) : plateEl(step, opts);
    }
    return `<div class="${band.kind === 'triangles' ? 'coaster-tier' : 'tier-plates'}">${items}</div>`;
  }

  /**
   * One coaster, drawn rather than boxed. Since the tower is turned slightly
   * (see --tower-turn), a leaning coaster shows two planes: the thin strip of
   * cardboard thickness facing the viewer, and the much wider face running
   * away from it. Drawing it that way is what makes it read as a coaster on
   * edge rather than a block. Colours come from CSS custom properties so
   * checkpoints and the shaded side of each pair restyle the same drawing.
   */
  function coasterSvg(side) {
    return `<svg class="coaster-leg ${side}" viewBox="0 0 11 40" preserveAspectRatio="none" aria-hidden="true">
      <path class="coaster-face" d="M2.6 1.4 10.1 3.5 10.4 35.8 3.1 38.2Z"/>
      ${side === 'left'
        // The inner face carries the print and nothing else; the hatching sits
        // on its partner, which is the face turned away from the light anyway.
        ? coasterLogoSvg()
        : '<path class="coaster-shade" d="M2.6 1.4 10.1 3.5 10.4 35.8 3.1 38.2Z"/>'}
      <path class="coaster-edge" d="M0.9 2 2.6 1.4 3.1 38.2 1.4 38.8Z"/>
      <path class="coaster-sketch" d="M1.5 4.6 1.8 36.4M3.5 2.1 9.5 3.8"/>
    </svg>`;
  }

  /**
   * The print on the coaster's face: a double ring. Seen this far off-axis a
   * round logo reads as a narrow oval, and the skew matches the face it sits
   * on. Only the left coaster of a pair shows it — that's the one whose drawn
   * face is the inner one, facing its partner.
   */
  function coasterLogoSvg() {
    return `<g class="coaster-logo" transform="translate(6.5 19.8) skewY(15.6) translate(-6.5 -19.8)">
      <ellipse cx="6.5" cy="19.8" rx="2" ry="8.4"/>
      <ellipse cx="6.5" cy="19.8" rx="1.25" ry="5.4"/>
    </g>`;
  }

  /**
   * The flat coaster bridging two triangles: a sliver of its top surface, and
   * its edge below. Drawn a little wider than the gap between two apexes so it
   * visibly lies across them instead of ending exactly on them.
   */
  function plateSvg(extraClass = '') {
    return `<svg class="tier-plate${extraClass}" viewBox="0 0 48 5" preserveAspectRatio="none" aria-hidden="true">
      <path class="coaster-face" d="M4.6 0.7 46.5 0.6 43.7 2.3 1.9 2.4Z"/>
      <path class="coaster-shade" d="M4.6 0.7 46.5 0.6 43.7 2.3 1.9 2.4Z"/>
      <path class="coaster-edge" d="M1.9 2.4 43.7 2.3 43.8 3.7 2 3.8Z"/>
      <path class="coaster-sketch" d="M3.7 2.9 42.1 2.8"/>
    </svg>`;
  }

  /** Hatching is defined once per tower and referenced by every coaster drawing. */
  function inkDefsSvg() {
    return `<svg class="tower-ink-defs" aria-hidden="true">
      <defs>
        <pattern id="coasterHatch" width="2.6" height="2.6" patternUnits="userSpaceOnUse" patternTransform="rotate(38)">
          <line x1="0" y1="0" x2="0" y2="2.6" stroke="currentColor" stroke-width="0.55" />
        </pattern>
      </defs>
    </svg>`;
  }

  function towerHtml(displayHeight, opts = {}) {
    const wobbleClass = displayHeight >= 30 ? 'wobble-strong' : displayHeight >= 20 ? 'wobble-medium' : displayHeight >= 10 ? 'wobble-light' : '';
    const towerOpts = { ...opts, displayHeight };
    let rows = '';
    BANDS.forEach((band, b) => {
      if (bandFirstStep(b) > displayHeight) return; // nothing of this band stands yet
      rows += bandHtml(b, towerOpts);
    });
    return `
      <div class="tower-wrap">
        ${inkDefsSvg()}
        <div class="tower-zoom">
          <div class="tower ${wobbleClass}">${rows}</div>
          <div class="tower-ground"></div>
        </div>
      </div>
      <p class="hint center-text tower-height-label">Höhe ${displayHeight}${bestHeight > 0 ? ` · Bestwert ${bestHeight}` : ''}</p>`;
  }

  // How much of the frame the tower should fill, and how far it may be
  // magnified when only a few coasters are standing.
  const ZOOM_FILL = 0.94;
  const ZOOM_MAX = 2.6;
  let lastZoom = null;

  /**
   * Frames whatever is standing: the camera sits close on the first few
   * coasters and pulls back as the tower grows, so the drawing always fills
   * the page. Measured rather than calculated, since unplaced coasters still
   * hold their slots in the layout.
   */
  function fitTowerZoom() {
    const zoom = container.querySelector('.tower-zoom');
    const stage = container.querySelector('.tower-wrap');
    if (!zoom || !stage) return;
    const drawn = zoom.querySelectorAll('.coaster-triangle:not(.coaster-slot), svg.tier-plate');
    if (!drawn.length) return;

    zoom.style.transition = 'none';
    zoom.style.transform = 'none';
    zoom.style.transformOrigin = '50% 50%';
    const zoomBox = zoom.getBoundingClientRect();
    const stageBox = stage.getBoundingClientRect();
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
    drawn.forEach((el) => {
      const r = el.getBoundingClientRect();
      left = Math.min(left, r.left);
      right = Math.max(right, r.right);
      top = Math.min(top, r.top);
      bottom = Math.max(bottom, r.bottom);
    });

    // The table line is placed under whatever actually stands, rather than
    // under the (always full-width) rows — otherwise it drifts out of frame
    // while the camera is still close in on the first few coasters.
    const ground = zoom.querySelector('.tower-ground');
    if (ground) {
      ground.style.left = `${left - zoomBox.left - 9}px`;
      ground.style.top = `${bottom - zoomBox.top + 1}px`;
      ground.style.width = `${right - left + 18}px`;
    }

    const scale = Math.min(
      ZOOM_MAX,
      (stageBox.width * ZOOM_FILL) / (right - left),
      (stageBox.height * ZOOM_FILL) / (bottom - top)
    );
    const next = {
      // The origin sits on the drawing's centre, so scaling holds it in place
      // and the translate only has to move it to the middle of the frame.
      originX: (left + right) / 2 - zoomBox.left,
      originY: (top + bottom) / 2 - zoomBox.top,
      dx: (stageBox.left + stageBox.width / 2) - (left + right) / 2,
      dy: (stageBox.top + stageBox.height / 2) - (top + bottom) / 2,
      scale
    };
    const apply = (z) => {
      zoom.style.transformOrigin = `${next.originX}px ${next.originY}px`;
      zoom.style.transform = `translate(${z.dx}px, ${z.dy}px) scale(${z.scale})`;
    };

    // Start from the previous framing so the camera glides to the new one
    // instead of jumping — every round re-renders the tower from scratch.
    apply(lastZoom || next);
    lastZoom = next;
    requestAnimationFrame(() => {
      zoom.style.transition = 'transform 0.45s ease';
      apply(next);
    });
  }

  function renderSelect() {
    container.innerHTML = `
      <div class="quiz-mode challenge-mode pad center-text">
        <h2>🍺 Bierdeckel-Challenge</h2>
        <p class="hint">Jede richtige Antwort legt genau einen Deckel — gebaut wird wie in echt: zwei Deckel als Dreieck, ein flacher Deckel darüber, ein Dreieck darauf, und so weiter nach oben, so hoch es geht. Erst dann beginnt rechts eine neue Basis, die den Turm eine Ebene höher klettern lässt. Fehler lassen ihn wackeln, jeder gesicherte Stand hält ihn — darunter stürzt alles ein. Ganz oben wartet die fertige Pyramide aus ${MAX_HEIGHT} Deckeln!</p>
        <p class="hint">Ab Höhe ${CANNON_MIN_HEIGHT} kommen Kanonen-Fragen: Lösung eintippen statt auswählen — daneben, und die Kanone reißt einen zufälligen Abschnitt samt allem darüber weg. Ab Höhe ${WIND_MIN_HEIGHT} können Böen am obersten Abschnitt zerren.</p>
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
    const toppling = phase === 'toppling';
    // While toppling, the tower is still drawn at its old height with the lost
    // coasters falling off it; it settles at the new height a moment later.
    const displayHeight = toppling ? topplingFrom : Math.max(height, 0);
    const towerOpts = toppling
      ? { collapseAbove: Math.max(height, 0) }
      : (lastDelta > 0 ? { newAbove: heightBeforeAnswer } : {});
    const note = towerEvent || {
      icon: lastCorrect ? checkCircleIcon : xCircleIcon,
      text: `${lastCorrect ? 'Richtig!' : `Richtig wäre: ${correctAnswer}`} (${lastDelta > 0 ? '+' : ''}${lastDelta})`
    };
    container.innerHTML = `
      <div class="quiz-mode challenge-mode pad center tower-stage">
        ${towerHtml(displayHeight, towerOpts)}
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
          <p class="cannon-warning center-text">💨 Eine Böe erfasst den Turm! Schnell richtig antworten, sonst fällt der oberste Abschnitt.</p>
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

  function renderPhase() {
    if (phase === 'select') return renderSelect();
    if (phase === 'empty') return renderEmpty();
    if (phase === 'loading') return renderLoading();
    if (phase === 'active') return renderQuestion(false);
    if (phase === 'revealed') return renderQuestion(true);
    if (phase === 'stacking' || phase === 'toppling') return renderStacking();
    if (phase === 'cannon') return renderCannon();
    if (phase === 'wind') return renderWind();
    if (phase === 'collapsing') return renderCollapsing();
    if (phase === 'boss') return renderBoss();
    if (phase === 'results') return renderResults();
  }

  function render() {
    renderPhase();
    fitTowerZoom();
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
