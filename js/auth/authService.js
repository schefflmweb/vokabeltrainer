import { authConfig, GRAPH_SCOPES, CLIENT_ID } from './authConfig.js';

let msalInstance = null;
let account = null;
let initPromise = null;

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
    await msalInstance.loginRedirect({ scopes: GRAPH_SCOPES });
  },

  async logout() {
    if (!msalInstance || !account) return;
    await msalInstance.logoutRedirect({ account });
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
