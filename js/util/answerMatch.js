/**
 * Many vocab translations list several valid synonyms in one field, separated
 * by "/" or "," (e.g. "spröde/brüchig", "Eher, sondern, vielmehr, ziemlich").
 * A typed or spoken answer should count as correct if it matches any single
 * one of them (or the whole field verbatim), not only the literal full text.
 *
 * Matching also tolerates small mistakes: a standard umlaut transliteration
 * (see foldUmlauts), a transposed pair of letters (the classic fat-finger
 * typo, e.g. "Apfle"), or — beyond a length-dependent zero-tolerance floor —
 * a single missing/extra/wrong letter (typo or, for speech, a mishearing).
 */

/** ä/ö/ü/ß -> ae/oe/ue/ss, the standard German transliteration used when
 *  umlauts aren't easy to type. Only folds actual umlaut characters, so it
 *  never conflates two different real words that merely look similar (e.g.
 *  "schon"/"schön" stay distinct — only "schoen" would match "schön"). */
function foldUmlauts(str) {
  return str
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss');
}

export function normalize(str) {
  return foldUmlauts(str.trim().toLowerCase().replace(/[.,!?;:]+$/g, ''));
}

/** The full field plus each individual "/"- or ","-separated synonym, normalized and de-duplicated. */
export function getAlternatives(expected) {
  const whole = normalize(expected);
  const parts = expected.split(/[/,]/).map(normalize).filter(Boolean);
  return [...new Set([whole, ...parts])];
}

export function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  return dp[n];
}

/**
 * True if `a`/`b` are identical except for exactly one adjacent pair of
 * letters swapped (e.g. "Apfle" vs "Apfel") — the single most common typing
 * typo. Accepted at any word length, unlike the general edit-distance
 * tolerance below: a transposition essentially never turns a word into a
 * different unrelated real word the way a substitution can (Haus/Maus).
 */
function isAdjacentTransposition(a, b) {
  if (a.length !== b.length || a === b) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (i >= a.length - 1) return false;
  if (a[i] !== b[i + 1] || a[i + 1] !== b[i]) return false;
  return a.slice(i + 2) === b.slice(i + 2);
}

/**
 * How many single-letter edits (missing/extra/wrong) still count as "close
 * enough" for a word of this length. Kept at zero for short words — German
 * has plenty of minimal pairs a single edit apart (Haus/Maus, schon/schön,
 * ...), so being lenient there risks accepting a genuinely wrong but
 * similar-looking/sounding word. Longer words get progressively more slack,
 * since a stray extra letter or one substitution there is much more likely
 * to be a real typo/mishearing than a flip to a different real word.
 */
export function fuzzyThreshold(word) {
  if (word.length <= 6) return 0;
  return word.length <= 10 ? 1 : 2;
}

/** True if `word` matches any of `alternatives` within the tolerances above. */
export function fuzzyMatchesAny(word, alternatives) {
  return alternatives.some(
    (alt) => isAdjacentTransposition(word, alt) || levenshtein(word, alt) <= fuzzyThreshold(alt)
  );
}

/** Accepts a match against any one of several synonyms listed in `expected` (see getAlternatives), first exact, then with the small tolerances above. */
export function answersMatch(userAnswer, expected) {
  if (!userAnswer || !expected) return false;
  const alternatives = getAlternatives(expected);
  const given = normalize(userAnswer);
  if (alternatives.includes(given)) return true;
  return fuzzyMatchesAny(given, alternatives);
}
