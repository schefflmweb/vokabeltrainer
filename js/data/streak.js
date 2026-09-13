import { db } from './db.js';

/**
 * One shared daily practice streak across every practiceable collection
 * (vocab, idioms — grammar doesn't currently touch it) rather than a
 * separate counter per store — the point is "did you practice today at
 * all", not "did you specifically review vocab today".
 */

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Records today as an active practice day, extending the streak if yesterday was also active. */
export async function touchStreak() {
  const today = dateKey(new Date());
  const lastDate = await db.getMeta('streakLastDate');
  if (lastDate === today) return; // already counted today
  const yesterday = dateKey(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const count = (await db.getMeta('streakCount')) || 0;
  await db.setMeta('streakLastDate', today);
  await db.setMeta('streakCount', lastDate === yesterday ? count + 1 : 1);
}

/** Current practice-day streak, accounting for a day having passed without any review since the last one recorded. */
export async function getStreak() {
  const lastDate = await db.getMeta('streakLastDate');
  if (!lastDate) return { count: 0, activeToday: false };
  const today = dateKey(new Date());
  const yesterday = dateKey(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const broken = lastDate !== today && lastDate !== yesterday;
  const count = (await db.getMeta('streakCount')) || 0;
  return { count: broken ? 0 : count, activeToday: lastDate === today };
}
