import { db } from './db.js';
import { getFirebase } from './firebaseClient.js';
import { firebaseAuth } from '../auth/firebaseAuth.js';

const BEST_HEIGHT_META_KEY = 'challengeBestHeight';

/**
 * Deliberately NOT wired into syncService's incremental multi-device sync —
 * that machinery exists for bidirectional merge of editable collections
 * (vocab/grammar/idioms) that change constantly in the background. A
 * finished Challenge session is a one-off event: read the best height once
 * when the tab opens, write once when a session ends. No pull, no cursor,
 * no automatic background reads — this only ever touches Firestore in
 * direct response to something the user just did (playing a round).
 */
export const challengeStore = {
  async getBestHeight() {
    return (await db.getMeta(BEST_HEIGHT_META_KEY)) || 0;
  },

  async _setLocalBestHeight(height) {
    await db.setMeta(BEST_HEIGHT_META_KEY, height);
  },

  /**
   * Writes the finished session and updates the best-height stat, both in
   * one go. Best-effort: if Firestore is unreachable or the user isn't
   * signed in, the session result still shows locally (results screen
   * doesn't depend on this succeeding) — it just doesn't make it to the
   * cloud that time.
   */
  async recordSession({ startedAt, finalHeight, endReason, questionsAsked, questionsCorrect, wrongItemIds }) {
    const previousBest = await this.getBestHeight();
    const newBest = Math.max(previousBest, finalHeight);
    if (newBest > previousBest) await this._setLocalBestHeight(newBest);

    await firebaseAuth.ready();
    if (!firebaseAuth.isConfigured()) return { bestHeight: newBest, synced: false };

    try {
      const { db: firestoreDb, dbFns } = await getFirebase();
      const sessionId = `s${Date.now()}`;
      await dbFns.setDoc(dbFns.doc(firestoreDb, 'challengeSessions', sessionId), {
        startedAt,
        finalHeight,
        endReason,
        questionsAsked,
        questionsCorrect,
        wrongItemIds
      });
      await dbFns.setDoc(dbFns.doc(firestoreDb, 'challengeStats', 'stats'), {
        bestHeight: newBest,
        totalSessions: dbFns.increment(1),
        lastPlayedAt: Date.now()
      }, { merge: true });
      return { bestHeight: newBest, synced: true };
    } catch {
      // Local result already stands regardless — see doc comment above.
      return { bestHeight: newBest, synced: false };
    }
  }
};
