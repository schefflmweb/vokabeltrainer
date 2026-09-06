import { authConfig, GRAPH_SCOPES, CLIENT_ID } from './authConfig.js';

let msalInstance = null;
let account = null;
let initPromise = null;

// Remembers an explicit "Abmelden" tap so automatic re-login (see
// ensureSignedIn below) doesn't immediately sign the user back in against
// their wishes on the next app launch.
const LOGGED_OUT_KEY = 'vocab-signed-out-intentionally';

function isConfigured() {
  return CLIENT_ID && CLIENT_ID !== 'REPLACE_WITH_YOUR_AZURE_APP_CLIENT_ID';
}

async function init() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (!isConfigured() || typeof msal === 'undefined') return false;
    msalInstance = new msal.PublicClientApplication(authConfig);
    await msalInstance.initialize();
    const result = await msalInstance.handleRedirectPromise().catch(() => null);
    if (result?.account) {
      account = result.account;
    } else {
      const accounts = msalInstance.getAllAccounts();
      if (accounts.length > 0) account = accounts[0];
    }
    return true;
  })();
  return initPromise;
}

export const authService = {
  isConfigured,

  async ready() {
    return init();
  },

  isSignedIn() {
    return !!account;
  },

  getAccount() {
    return account;
  },

  async login() {
    const ok = await init();
    if (!ok) throw new Error('OneDrive-Sync ist noch nicht eingerichtet (Client-ID fehlt).');
    try { localStorage.removeItem(LOGGED_OUT_KEY); } catch {}
    await msalInstance.loginRedirect({ scopes: GRAPH_SCOPES });
  },

  async logout() {
    try { localStorage.setItem(LOGGED_OUT_KEY, '1'); } catch {}
    if (!msalInstance || !account) return;
    await msalInstance.logoutRedirect({ account });
  },

  /**
   * Makes sure the app has a *working* OneDrive session, re-authenticating
   * interactively (a brief redirect to Microsoft's login and back) if needed
   * — so the user never has to open "Verwalten" and tap "Anmelden" by hand.
   * Azure AD caps refresh tokens for single-page apps at ~24h, so silent
   * renewal (acquireToken) alone stops working after that; this is the
   * automatic fallback for exactly that case.
   *
   * Deliberately called only once, at cold app start (see app.js) — never
   * from the periodic/background sync triggers — because it can navigate
   * the whole page away. Doing that mid-session (e.g. while driving in Auto
   * mode) would be disruptive and could hang if there's no signal, so it
   * must stay confined to the moment right before the user picks a mode.
   */
  async ensureSignedIn() {
    if (!isConfigured()) return;
    let loggedOut = false;
    try { loggedOut = localStorage.getItem(LOGGED_OUT_KEY) === '1'; } catch {}
    if (loggedOut) return; // respect an explicit sign-out — don't force it back on
    if (!navigator.onLine) return; // no point starting a redirect with no connection

    const token = await this.acquireToken();
    if (token) return; // silent renewal already works, nothing to do

    try {
      await this.login();
    } catch {
      // Stay on the local-only fallback rather than blocking app start.
    }
  },

  /**
   * Returns an access token, or null if the user isn't signed in / silent
   * renewal failed (e.g. iOS Safari's ~24h refresh-token window lapsed).
   * Never throws and never triggers an interactive prompt — sync must stay
   * non-blocking and fall back to "working from local cache".
   */
  async acquireToken() {
    const ok = await init();
    if (!ok || !account) return null;
    try {
      const result = await msalInstance.acquireTokenSilent({ scopes: GRAPH_SCOPES, account });
      return result.accessToken;
    } catch {
      return null;
    }
  }
};
