# Sync zwischen Geräten einrichten

Die App funktioniert von Anfang an vollständig lokal (offline, IndexedDB). Für Sync zwischen Geräten (z. B. Handy und PC) speichert sie deine Vokabeln als privaten [GitHub Gist](https://gist.github.com) in deinem eigenen GitHub-Account — dafür brauchst du nur ein persönliches Zugriffstoken, keine App-Registrierung.

## Schritte

1. Auf **[github.com/settings/tokens](https://github.com/settings/tokens)** gehen (mit deinem GitHub-Konto angemeldet).
2. **"Generate new token"** → **"Generate new token (classic)"** wählen (nicht "Fine-grained" — die unterstützen aktuell keine Gists).
3. Ausfüllen:
   - **Note**: z. B. `Vokabeltrainer Sync`
   - **Expiration**: nach Wunsch (z. B. "No expiration" für dauerhaften Zugriff ohne erneutes Erstellen)
   - **Scopes**: nur **`gist`** ankreuzen — sonst nichts. Das Token kann damit ausschließlich (private) Gists lesen/schreiben, nichts anderes in deinem Account.
4. **"Generate token"** klicken, das Token kopieren (wird nur einmal angezeigt).
5. In der App unter **Verwalten** → **"Sync über GitHub"** → Token einfügen → **"Verbinden"**.

Auf jedem weiteren Gerät denselben Token einfügen — die App findet den bereits angelegten Gist automatisch wieder (erkennbar an der Beschreibung "Vokabeltrainer-Daten").

## Wichtig

- Die App legt einen **privaten** Gist namens "Vokabeltrainer-Daten (bitte nicht löschen)" in deinem GitHub-Account an ([gist.github.com](https://gist.github.com/) → "Your gists" zeigt ihn). Bitte nicht manuell löschen, sonst wird beim nächsten Sync ein neuer, leerer angelegt.
- Das Token wird nur lokal im Browser gespeichert, nie an einen anderen Server als `api.github.com` gesendet.
- Wenn du den Zugriff später entziehen willst: entweder in der App auf "Trennen" tippen, oder das Token direkt auf github.com/settings/tokens löschen/widerrufen.
