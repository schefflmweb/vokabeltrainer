/**
 * Curated English confusion pairs, used by the Bierdeckel-Challenge from
 * height 10 onward to build genuinely tricky DE→EN multiple-choice options
 * instead of random unrelated words — real discrimination ("affect" vs
 * "effect"), not just recall. Only applies to English-language answer
 * options (DE→EN direction); there's no equivalent German confusion list,
 * so EN→DE/EN→Bedeutung always uses random distractors. Bidirectional: each
 * pair is listed both ways so either member can serve as the "known" word.
 *
 * Starter set — meant to grow over time (see spec's own "Offene Punkte").
 */
const RAW_PAIRS = [
  ['affect', 'effect'],
  ['borrow', 'lend'],
  ['since', 'for'],
  ['say', 'tell'],
  ['make', 'do'],
  ['bring', 'take'],
  ['raise', 'rise'],
  ['lie', 'lay'],
  ['hear', 'listen'],
  ['see', 'watch'],
  ['watch', 'look'],
  ['remember', 'remind'],
  ['expect', 'wait'],
  ['travel', 'trip'],
  ['trip', 'journey'],
  ['learn', 'teach'],
  ['speak', 'talk'],
  ['job', 'work'],
  ['fun', 'funny'],
  ['economic', 'economical'],
  ['sensible', 'sensitive'],
  ['historic', 'historical'],
  ['continual', 'continuous'],
  ['principal', 'principle'],
  ['stationary', 'stationery'],
  ['complement', 'compliment'],
  ['desert', 'dessert'],
  ['advice', 'advise'],
  ['accept', 'except'],
  ['adopt', 'adapt'],
  ['among', 'between'],
  ['beside', 'besides'],
  ['classic', 'classical'],
  ['comprehensible', 'comprehensive'],
  ['considerable', 'considerate'],
  ['childish', 'childlike'],
  ['imaginary', 'imaginative'],
  ['respectful', 'respective'],
  ['especially', 'specially'],
  ['lose', 'loose']
];

const DISTRACTOR_PAIRS = {};
for (const [a, b] of RAW_PAIRS) {
  (DISTRACTOR_PAIRS[a] ||= new Set()).add(b);
  (DISTRACTOR_PAIRS[b] ||= new Set()).add(a);
}

/** Curated confusable English words for `word`, if any are known — empty array otherwise, so callers can fall straight through to a random-distractor fallback. */
export function getCuratedDistractors(word) {
  const set = DISTRACTOR_PAIRS[word.trim().toLowerCase()];
  return set ? [...set] : [];
}
