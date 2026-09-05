const DAY_MS = 24 * 60 * 60 * 1000;

export function defaultSrs() {
  return { ease: 2.5, interval: 0, repetitions: 0, dueDate: Date.now(), lastReviewed: null };
}

/**
 * Simplified SM-2-style scheduler. `known` is the only signal we collect
 * (large-tap UI, no graded 0-5 recall quality) since finer grading isn't usable
 * while driving or in a quick tap-quiz.
 */
export function schedule(srs, known) {
  const prev = srs || defaultSrs();
  let { ease, interval, repetitions } = prev;
  const now = Date.now();

  if (!known) {
    repetitions = 0;
    interval = 1;
    ease = Math.max(1.3, ease - 0.2);
  } else {
    repetitions += 1;
    if (repetitions === 1) interval = 1;
    else if (repetitions === 2) interval = 3;
    else interval = Math.round(interval * ease);
    ease = Math.min(3.0, ease + 0.05);
  }

  return {
    ease,
    interval,
    repetitions,
    dueDate: now + interval * DAY_MS,
    lastReviewed: now
  };
}

export function isDue(srs, now = Date.now()) {
  return !srs || srs.dueDate <= now;
}
