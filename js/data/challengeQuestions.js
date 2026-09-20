import { vocabStore } from './vocabStore.js';
import { idiomStore } from './idiomStore.js';
import { grammarStore } from './grammarStore.js';
import { practiceFilter } from './practiceFilter.js';
import { getCuratedDistractors } from './distractorPairs.js';

/**
 * Question pot weights (Vokabel/Idiom/Grammatik). Grammar questions reuse
 * their own pre-authored options/correctIndex as-is (curated distractors,
 * not generated) rather than being forced into the height-based 3/4/5
 * option count below, which only applies to the vocab/idiom questions this
 * module builds itself.
 */
const POT_WEIGHTS = { vocab: 0.4, idiom: 0.3, grammar: 0.3 };

const SAMPLE_CAP = 30;

function shuffle(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}

function optionCountForHeight(height) {
  if (height < 24) return 3;
  if (height < 37) return 4;
  return 5;
}

async function fetchPotSamples() {
  const filter = practiceFilter.isActive() ? practiceFilter.get() : null;
  const [vocab, idiom, grammar] = await Promise.all([
    vocabStore.getSample(SAMPLE_CAP, filter),
    idiomStore.getSample(SAMPLE_CAP, filter),
    // Grammar exercises carry neither a word type nor a category, so once
    // either is picked they can't satisfy it — the pot sits out that round.
    filter ? Promise.resolve([]) : grammarStore.getSample(SAMPLE_CAP)
  ]);
  return { vocab, idiom, grammar };
}

function pickPot(samples) {
  const available = Object.entries(POT_WEIGHTS).filter(([key]) => samples[key].length > 0);
  if (available.length === 0) return null;
  const total = available.reduce((sum, [, w]) => sum + w, 0);
  let r = Math.random() * total;
  for (const [key, w] of available) {
    if (r < w) return key;
    r -= w;
  }
  return available[available.length - 1][0];
}

/**
 * DE→EN / EN→DE / EN→Bedeutung weights (50/30/20) apply as specified for
 * idioms, which is the only pot where "EN→Bedeutung" makes sense as a
 * distinct framing (idioms only have one German field — their meaning —
 * so EN→DE and EN→Bedeutung are the same lookup, just phrased
 * differently). For vocab, only DE→EN/EN→DE apply, renormalized to the
 * same 50:30 ratio (62.5%/37.5%).
 */
function pickDirection(pot) {
  if (pot === 'idiom') {
    const r = Math.random();
    if (r < 0.5) return 'de-en';
    if (r < 0.8) return 'en-de';
    return 'en-meaning';
  }
  return Math.random() < 0.625 ? 'de-en' : 'en-de';
}

function buildWordQuestion(pot, item, pool, height) {
  const direction = pickDirection(pot);
  const isDeToEn = direction === 'de-en';
  const prompt = isDeToEn ? item.de : item.en;
  const correctAnswer = isDeToEn ? item.en : item.de;
  const distractorField = isDeToEn ? 'en' : 'de';

  const optionCount = Math.min(optionCountForHeight(height), pool.length);
  const usedTexts = new Set([correctAnswer.toLowerCase()]);
  const distractors = [];

  // Curated confusion pairs only apply to English answer options (DE→EN), and only once the challenge gets hard enough to want real discrimination instead of just recall.
  if (isDeToEn && height >= 24) {
    for (const candidate of getCuratedDistractors(item.en)) {
      if (distractors.length >= optionCount - 1) break;
      if (usedTexts.has(candidate.toLowerCase())) continue;
      distractors.push(candidate);
      usedTexts.add(candidate.toLowerCase());
    }
  }

  // Fill any remaining slots with random distractors from the same pot's sample pool.
  for (const candidate of shuffle(pool.filter((o) => o.id !== item.id))) {
    if (distractors.length >= optionCount - 1) break;
    const text = candidate[distractorField];
    if (!text || usedTexts.has(text.toLowerCase())) continue;
    distractors.push(text);
    usedTexts.add(text.toLowerCase());
  }

  const options = shuffle([correctAnswer, ...distractors]);
  const promptLabel = direction === 'en-meaning'
    ? 'Was bedeutet …?'
    : (isDeToEn ? 'Übersetze ins Englische:' : 'Übersetze ins Deutsche:');

  return {
    pot,
    direction,
    promptLabel,
    prompt,
    options,
    correctIndex: options.indexOf(correctAnswer),
    itemId: item.id,
    example: item.example || null,
    explanation: null
  };
}

function buildGrammarQuestion(item) {
  return {
    pot: 'grammar',
    direction: null,
    promptLabel: item.topic || 'Grammatik',
    prompt: item.question,
    options: item.options,
    correctIndex: item.correctIndex,
    itemId: item.id,
    example: null,
    explanation: item.explanation || null
  };
}

/**
 * The picked word always comes from the chosen types/categories, but its
 * wrong options may not have to: a selection narrower than the option
 * count would otherwise leave a question with no wrong answer at all.
 */
async function topUpPool(pot, pool, needed) {
  if (pool.length >= needed) return pool;
  const store = pot === 'vocab' ? vocabStore : idiomStore;
  const extra = await store.getSample(SAMPLE_CAP);
  const seen = new Set(pool.map((item) => item.id));
  return [...pool, ...extra.filter((item) => !seen.has(item.id))];
}

/** Resolves a fresh challenge question, or null if there's nothing in any of the three pots to draw from. */
export async function getNextQuestion(height) {
  const samples = await fetchPotSamples();
  const pot = pickPot(samples);
  if (!pot) return null;
  if (pot === 'grammar') {
    const item = samples.grammar[Math.floor(Math.random() * samples.grammar.length)];
    return buildGrammarQuestion(item);
  }
  const picked = samples[pot];
  const item = picked[Math.floor(Math.random() * picked.length)];
  const pool = await topUpPool(pot, picked, optionCountForHeight(height));
  return buildWordQuestion(pot, item, pool, height);
}
