/**
 * Which half of the sync a device is allowed to do.
 *
 * The vocab/grammar/idiom collections are master data: they're built once on
 * the stationary Windows PC (CSV import, manual edits, deletions) and every
 * other device only consumes them. Without that rule a phone could quietly
 * push a half-finished edit — or, far worse, its own stale copy of a record —
 * back over the list the PC just imported.
 *
 * So each device has a role:
 *   master — may create, edit and delete master data, and push all of it.
 *   reader — pulls master data and may push nothing but its own learning
 *            progress (see syncService's progress-only push).
 *
 * The default is derived from the user agent rather than asked for, because
 * the interesting case is the one that must never happen by accident: an
 * iPhone or iPad promoting itself. Neither can — iOS reports "iPhone"/"iPad"
 * and iPadOS Safari in desktop mode reports "Macintosh", so neither ever
 * matches "Windows NT". The stored override exists for the cases a UA string
 * can't know (a second Windows machine that should stay read-only, or a Mac
 * that should take over), and is deliberately per-device: it lives in
 * localStorage, never in IndexedDB, so it can't travel through the sync and
 * turn a phone into a master device from afar.
 */

const STORAGE_KEY = 'vocab-device-role';
const ROLES = ['master', 'reader'];

let listeners = [];

function detectRole() {
  const ua = navigator.userAgent || '';
  const isWindows = /Windows NT/i.test(ua);
  const isMobile = /Windows Phone|Mobile|Android|iPhone|iPad|iPod/i.test(ua);
  return isWindows && !isMobile ? 'master' : 'reader';
}

function readOverride() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return ROLES.includes(stored) ? stored : null;
  } catch {
    // Private mode / blocked storage: fall back to detection rather than
    // throwing. Detection alone still keeps phones out.
    return null;
  }
}

export const deviceRole = {
  /** What this device was detected as, ignoring any manual override. */
  detected: detectRole(),

  /** The role actually in force: the manual override if one is set, otherwise the detected one. */
  get() {
    return readOverride() || detectRole();
  },

  /** True when this device may change master data (add/edit/delete/import) and push it. */
  isMaster() {
    return this.get() === 'master';
  },

  /** True while the role comes from detection alone — i.e. the user hasn't overridden it. */
  isAuto() {
    return readOverride() === null;
  },

  /** Sets a manual override, or clears it with null to go back to detection. */
  set(role) {
    try {
      if (role === null) localStorage.removeItem(STORAGE_KEY);
      else if (ROLES.includes(role)) localStorage.setItem(STORAGE_KEY, role);
    } catch {
      // Nothing to do — get() keeps returning the detected role.
    }
    const current = this.get();
    listeners.forEach((fn) => fn(current));
  },

  onChange(fn) {
    listeners.push(fn);
    return () => {
      listeners = listeners.filter((l) => l !== fn);
    };
  }
};
