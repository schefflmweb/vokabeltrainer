// Fill in CLIENT_ID after creating your own Azure App Registration
// (see SETUP-ONEDRIVE.md in the project root for step-by-step instructions).
// Until a real value is set, OneDrive sync stays disabled and the app runs
// fully offline from local storage only.
export const CLIENT_ID = 'REPLACE_WITH_YOUR_AZURE_APP_CLIENT_ID';

export const authConfig = {
  auth: {
    clientId: CLIENT_ID,
    authority: 'https://login.microsoftonline.com/consumers',
    redirectUri: window.location.origin + window.location.pathname
  },
  cache: {
    // Redirect flow opens Safari outside the standalone PWA context, so the
    // MSAL cache must survive across that tab switch — sessionStorage would
    // lose the in-flight login state.
    cacheLocation: 'localStorage',
    storeAuthStateInCookie: false
  }
};

export const GRAPH_SCOPES = ['Files.ReadWrite.AppFolder'];
