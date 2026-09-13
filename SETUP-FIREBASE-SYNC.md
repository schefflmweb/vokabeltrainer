# Sync zwischen Geräten einrichten

Die App funktioniert von Anfang an vollständig lokal (offline, IndexedDB). Für Sync zwischen Geräten (z. B. Handy und PC) speichert sie deine Vokabeln in einer eigenen, kostenlosen [Firebase](https://firebase.google.com) Firestore-Datenbank — dafür brauchst du ein Google-Konto (kein Azure/GitHub nötig) und legst ein kleines, eigenes Firebase-Projekt an.

## Schritte

1. **Projekt anlegen**: [console.firebase.google.com](https://console.firebase.google.com) öffnen, mit einem Google-Konto anmelden, **„Projekt hinzufügen"** → Name frei wählbar (z. B. `vokabeltrainer`) → Google Analytics kann deaktiviert bleiben.
2. **Web-App registrieren**: Auf der Projekt-Übersicht das Web-Symbol (`</>`) anklicken, einen Spitznamen vergeben, „Firebase Hosting" NICHT ankreuzen (die App läuft ja schon über GitHub Pages). Firebase zeigt danach einen `firebaseConfig`-Block (apiKey, projectId, appId, …) — diese Werte stehen bereits fest in [js/data/firebaseClient.js](js/data/firebaseClient.js) eingetragen; bei einem eigenen, neuen Projekt müssten sie dort ausgetauscht werden.
3. **Firestore aktivieren**: Menü → **Build → Firestore Database** → „Datenbank erstellen" → Standort wählen (z. B. `eur3` für Europa) → **„Im Produktionsmodus starten"** (nicht Testmodus).
4. **Anmeldeverfahren aktivieren**: Menü → **Build → Authentication** → „Los geht's" → Reiter „Sign-in method" → **„E-Mail/Passwort"** aktivieren.
5. **Genau einen Nutzer anlegen**: Reiter „Users" → „Add user" → eine beliebige E-Mail-Adresse (muss nicht echt sein, dient nur als Login-Name) + ein Passwort. Das wird der Sync-Login für alle Geräte.
6. Die **User UID** aus der Nutzerliste kopieren und in die Firestore-Regeln eintragen (Firestore Database → Reiter „Rules"):

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /{document=**} {
         allow read, write: if request.auth != null && request.auth.uid == "DEINE-UID-HIER";
       }
     }
   }
   ```

7. In der App unter **Verwalten** → **„Cloud-Sync"** → die E-Mail und das Passwort aus Schritt 5 eingeben → **„Verbinden"**.

Auf jedem weiteren Gerät dieselben Zugangsdaten eingeben.

## Wichtig

- Der `apiKey` in `js/data/firebaseClient.js` ist **kein Geheimnis** — er identifiziert nur das Projekt, nicht die Berechtigung. Die eigentliche Absicherung sind die Firestore-Regeln (Schritt 6), die den Zugriff fest auf eine einzige, bekannte User-UID beschränken. Ohne diesen Login kommt niemand an die Daten heran, selbst wenn der `apiKey` (er steht im öffentlichen Quellcode) bekannt ist.
- Firebase legt keinen öffentlichen Zugang für Selbstregistrierung offen — die App ruft nur die Anmeldung auf, nie eine Kontoerstellung. Der einzige Nutzer ist der, den du manuell in Schritt 5 angelegt hast.
- Kostenlose Firebase-Stufe („Spark"): 1 GiB Speicher, 50.000 Lesevorgänge und 20.000 Schreibvorgänge pro Tag — für eine private Vokabelliste auch bei täglicher, mehrfacher Synchronisation weit ausreichend.
