import { vocabStore } from '../data/vocabStore.js';
import { parseCsv } from '../csv/csvImport.js';
import { authService } from '../auth/authService.js';
import { syncService } from '../data/syncService.js';

export function mount(container) {
  let unsubscribeStatus = null;

  async function render() {
    const all = await vocabStore.getAll();
    const byCategory = {};
    for (const v of all) {
      (byCategory[v.category] ||= []).push(v);
    }
    const categories = Object.keys(byCategory).sort();

    container.innerHTML = `
      <div class="manage-mode pad">
        <section class="account-box" id="account-box"></section>

        <section>
          <h3>Neue Vokabel</h3>
          <form id="add-form" class="add-form">
            <input type="text" name="en" placeholder="Englisch" required />
            <input type="text" name="de" placeholder="Deutsch" required />
            <input type="text" name="category" placeholder="Kategorie (optional)" />
            <input type="text" name="example" placeholder="Beispielsatz (optional)" />
            <button type="submit" class="btn btn-primary">Hinzufügen</button>
          </form>
        </section>

        <section>
          <h3>CSV-Import</h3>
          <p class="hint">Spalten: Englisch, Deutsch, Kategorie (optional), Beispiel (optional)</p>
          <input type="file" id="csv-file" accept=".csv,text/csv" />
          <textarea id="csv-text" rows="4" placeholder="cat,Katze&#10;dog,Hund"></textarea>
          <button class="btn btn-secondary" id="csv-import-btn">Importieren</button>
          <p id="csv-status" class="hint"></p>
        </section>

        <section>
          <h3>Vokabeln (${all.length})</h3>
          <div class="vocab-list">
            ${categories.map((cat) => `
              <div class="vocab-category">
                <h4>${escapeHtml(cat)}</h4>
                ${byCategory[cat].map((v) => `
                  <div class="vocab-row" data-id="${v.id}">
                    <span>${escapeHtml(v.en)} – ${escapeHtml(v.de)}</span>
                    <button class="btn btn-icon delete-btn" data-id="${v.id}" aria-label="Löschen">🗑️</button>
                  </div>
                `).join('')}
              </div>
            `).join('')}
          </div>
        </section>
      </div>`;

    container.querySelector('#add-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const data = Object.fromEntries(new FormData(form).entries());
      if (!data.en.trim() || !data.de.trim()) return;
      await vocabStore.add(data);
      syncService.sync();
      render();
    });

    container.querySelectorAll('.delete-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await vocabStore.remove(btn.dataset.id);
        syncService.sync();
        render();
      });
    });

    container.querySelector('#csv-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      container.querySelector('#csv-text').value = await file.text();
    });

    container.querySelector('#csv-import-btn').addEventListener('click', async () => {
      const text = container.querySelector('#csv-text').value;
      const entries = parseCsv(text);
      const status = container.querySelector('#csv-status');
      if (entries.length === 0) {
        status.textContent = 'Keine gültigen Zeilen gefunden.';
        return;
      }
      await vocabStore.addMany(entries);
      syncService.sync();
      status.textContent = `${entries.length} Vokabeln importiert.`;
      render();
    });

    renderAccountBox();
  }

  function renderAccountBox() {
    const box = container.querySelector('#account-box');
    if (!box) return;

    if (!authService.isConfigured()) {
      box.innerHTML = `
        <h3>OneDrive-Sync</h3>
        <p class="hint">Noch nicht eingerichtet. Siehe SETUP-ONEDRIVE.md für die Anleitung. Bis dahin läuft alles lokal auf diesem Gerät.</p>`;
      return;
    }

    const signedIn = authService.isSignedIn();
    box.innerHTML = `
      <h3>OneDrive-Sync</h3>
      <p class="hint" id="sync-status-text">–</p>
      ${signedIn
        ? `<button class="btn btn-secondary" id="signout-btn">Abmelden</button>
           <button class="btn btn-secondary" id="sync-now-btn">Jetzt synchronisieren</button>`
        : `<button class="btn btn-primary" id="signin-btn">Mit Microsoft anmelden</button>`}
    `;

    box.querySelector('#signin-btn')?.addEventListener('click', () => authService.login());
    box.querySelector('#signout-btn')?.addEventListener('click', () => authService.logout());
    box.querySelector('#sync-now-btn')?.addEventListener('click', () => syncService.sync());

    unsubscribeStatus?.();
    unsubscribeStatus = syncService.onStatusChange((status) => {
      const el = container.querySelector('#sync-status-text');
      if (el) el.textContent = status.message;
    });
  }

  render();

  return () => {
    unsubscribeStatus?.();
  };
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
