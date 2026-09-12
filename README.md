# Vokabeltrainer

Englisch-Vokabeln lernen als installierbare PWA – Auto-Modus (Sprachausgabe, ein Tap pro Karte) fürs Fahren, Quiz-Modus für zuhause. Läuft komplett offline lokal (IndexedDB); optional Sync über einen privaten GitHub Gist in deinem eigenen GitHub-Account.

## Lokal testen

Kein Build-Schritt nötig, aber ES-Module und der Service Worker brauchen einen echten HTTP-Server (nicht `file://`):

```bash
npx serve .
```

Dann im Browser öffnen (Desktop zum Testen, echtes iPhone für den vollständigen Test inkl. "Zum Home-Bildschirm").

## Sync zwischen Geräten aktivieren

Siehe [SETUP-GITHUB-SYNC.md](SETUP-GITHUB-SYNC.md) – kurze Anleitung zum GitHub-Zugriffstoken. Bis dahin läuft die App normal weiter, nur ohne Geräte-übergreifenden Sync.

## Auf dem iPhone installieren

1. Seite in Safari öffnen (muss über HTTPS gehostet sein, außer bei `localhost`).
2. Teilen-Button → **"Zum Home-Bildschirm"**.
3. App über das neue Icon öffnen (läuft dann im Standalone-Modus, ohne Safari-UI).

## Hinweise für den Auto-Modus

- Handy sichtbar montieren, Display an lassen (automatische Bildschirmsperre in den iOS-Einstellungen ggf. hochsetzen) – iOS stoppt die Sprachausgabe, sobald der Bildschirm gesperrt wird.
- Pro Karte reicht ein Tap auf "✅ Kannte ich" oder "❌ Nochmal üben" – das bewertet die aktuelle Karte und spielt automatisch die nächste ab.
