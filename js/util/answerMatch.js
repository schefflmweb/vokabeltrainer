/**
 * Many vocab translations list several valid synonyms in one field, separated
 * by "/" or "," (e.g. "spröde/brüchig", "Eher, sondern, vielmehr, ziemlich").
 * A typed or spoken answer should count as correct if it matches any single
 * one of them (or the whole field verbatim), not only the literal full text.
 */

export function normalize(str) {
  return str.trim().toLowerCase().replace(/[.,!?;:]+$/g, '');
}

/** The full field plus each individual "/"- or ","-separated synonym, normalized and de-duplicated. */
export function getAlternatives(expected) {
  const whole = normalize(expected);
  const parts = expected.split(/[/,]/).map(normalize).filter(Boolean);
  return [...new Set([whole, ...parts])];
}

export function answersMatch(userAnswer, expected) {
  if (!userAnswer || !expected) return false;
  return getAlternatives(expected).includes(normalize(userAnswer));
}
