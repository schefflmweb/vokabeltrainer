# Vokabeltrainer

Englisch-Vokabeln lernen als installierbare PWA – Auto-Modus (Sprachausgabe, ein Tap pro Karte) fürs Fahren, Quiz-Modus für zuhause. Läuft komplett offline lokal (IndexedDB); optional Sync über dein eigenes OneDrive-Konto.

## Lokal testen

Kein Build-Schritt nötig, aber ES-Module und der Service Worker brauchen einen echten HTTP-Server (nicht `file://`):

```bash
npx serve .
```

Dann im Browser öffnen (Desktop zum Testen, echtes iPhone für den vollständigen Test inkl. "Zum Home-Bildschirm").

## OneDrive-Sync aktivieren

Siehe [SETUP-ONEDRIVE.md](SETUP-ONEDRIVE.md) – kurze Anleitung zur kostenlosen Azure-App-Registrierung. Bis dahin läuft die App normal weiter, nur ohne Geräte-übergreifenden Sync.

## Auf dem iPhone installieren

1. Seite in Safari öffnen (muss über HTTPS gehostet sein, außer bei `localhost`).
2. Teilen-Button → **"Zum Home-Bildschirm"**.
3. App über das neue Icon öffnen (läuft dann im Standalone-Modus, ohne Safari-UI).

## Hinweise für den Auto-Modus

- Handy sichtbar montieren, Display an lassen (automatische Bildschirmsperre in den iOS-Einstellungen ggf. hochsetzen) – iOS stoppt die Sprachausgabe, sobald der Bildschirm gesperrt wird.
- Pro Karte reicht ein Tap auf "✅ Kannte ich" oder "❌ Nochmal üben" – das bewertet die aktuelle Karte und spielt automatisch die nächste ab.
