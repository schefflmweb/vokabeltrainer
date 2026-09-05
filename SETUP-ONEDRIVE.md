# OneDrive-Sync einrichten

Die App funktioniert von Anfang an vollständig lokal (offline, IndexedDB). Für Sync zwischen Geräten über dein OneDrive-Konto brauchst du eine eigene, kostenlose Azure-App-Registrierung (kein Azure-Abo nötig).

## Schritte

1. Gehe auf [portal.azure.com](https://portal.azure.com) und melde dich mit deinem Microsoft-Konto an (privates Konto reicht, z. B. dasselbe wie für OneDrive).
2. Suche oben nach **"App registrations"** (App-Registrierungen) → **"New registration"**.
3. Ausfüllen:
   - **Name**: z. B. `Vokabeltrainer`
   - **Supported account types**: **"Personal Microsoft accounts only"**
   - **Redirect URI**: Typ **"Single-page application (SPA)"**, URL = die Adresse, unter der die App später läuft (z. B. `https://deine-domain.de/` oder für lokale Tests `http://localhost:3000/`)
4. Nach dem Erstellen: **Overview**-Seite → **"Application (client) ID"** kopieren.
5. Links im Menü **"API permissions"** → **"Add a permission"** → **"Microsoft Graph"** → **"Delegated permissions"** → `Files.ReadWrite.AppFolder` suchen und hinzufügen (`offline_access` fügt MSAL automatisch hinzu). Admin-Zustimmung ist bei persönlichen Konten nicht nötig.
6. Trage die Client-ID in [js/auth/authConfig.js](js/auth/authConfig.js) ein: ersetze `REPLACE_WITH_YOUR_AZURE_APP_CLIENT_ID` mit deiner ID.

## Wichtig

- Falls du die App später unter einer anderen URL hostest, musst du in Azure unter **Authentication** eine weitere Redirect-URI (Typ SPA) für diese Adresse hinzufügen.
- Der erste Anmeldeversuch kann kurz nach dem Erstellen der Registrierung mit einem Fehler fehlschlagen (Microsoft braucht manchmal ein paar Minuten, bis die neue App aktiv ist) — einfach etwas warten und erneut versuchen.
- Die App legt in deinem OneDrive einen sichtbaren Ordner `Apps/Vokabeltrainer` an (App Folder). Bitte nicht manuell löschen, sonst wird er beim nächsten Sync leer neu angelegt.
- Beim Redirect-Login öffnet iOS Safari kurz einen normalen Browser-Tab statt der App selbst — nach der Anmeldung einfach zurück zum Home-Bildschirm-Icon wechseln.
