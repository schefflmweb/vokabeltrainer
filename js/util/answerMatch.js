/**
 * Many vocab translations list several valid synonyms in one field, separated
 * by "/" or "," (e.g. "spröde/brüchig", "Eher, sondern, vielmehr, ziemlich").
 * A typed or spoken answer should count as correct if it matches any single
 * one of them (or the whole field verbatim), not only the literal full text.
 */

function normalize(str) {
  return str.trim().toLowerCase().replace(/[.,!?;:]+$/g, '');
}

export function answersMatch(userAnswer, expected) {
  if (!userAnswer || !expected) return false;
  const given = normalize(userAnswer);
  if (given === normalize(expected)) return true;
  const alternatives = expected.split(/[/,]/).map(normalize).filter(Boolean);
  return alternatives.includes(given);
}
