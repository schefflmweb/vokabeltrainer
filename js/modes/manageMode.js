import { vocabStore } from '../data/vocabStore.js';
import { parseCsv } from '../csv/csvImport.js';
import { authService } from '../auth/authService.js';
import { syncService } from '../data/syncService.js';

function filterVocab(list, query) {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((v) => v.en.toLowerCase().includes(q) || v.de.toLowerCase().includes(q));
}

function renderVocabRowsHtml(list) {
  if (list.length === 0) {
    return `<p class="hint">Keine Treffer.</p>`;
  }
  const byCategory = {};
  for (const v of list) {
    (byCategory[v.category] ||= []).push(v);
  }
  const categories = Object.keys(byCategory).sort();
  return categories.map((cat) => `
    <div class="vocab-category">
      <h4>${escapeHtml(cat)}</h4>
      ${byCategory[cat].map((v) => `
        <div class="vocab-row" data-id="${v.id}">
          <span>${escapeHtml(v.en)} – ${escapeHtml(v.de)}</span>
          <button class="btn btn-icon delete-btn" data-id="${v.id}" aria-label="Löschen">🗑️</button>
        </div>
      `).join('')}
    </div>
  `).join('');
}

export function mount(container) {
  let unsubscribeStatus = null;
  let csvStatusMessage = '';
  let searchQuery = '';
  let vocabCache = [];

  function bindDeleteButtons(scopeEl) {
    scopeEl.querySelectorAll('.delete-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await vocabStore.remove(btn.dataset.id);
        syncService.sync();
        render();
      });
    });
  }

  /** Re-renders only the list + count, leaving the search input itself untouched so it never loses focus while typing. */
  function updateVocabListOnly() {
    const input = container.querySelector('#vocab-search');
    searchQuery = input ? input.value : searchQuery;
    const filtered = filterVocab(vocabCache, searchQuery);
    const listEl = container.querySelector('#vocab-list-container');
    listEl.innerHTML = renderVocabRowsHtml(filtered);
    bindDeleteButtons(listEl);
    const countEl = container.querySelector('#vocab-count');
    if (countEl) countEl.textContent = filtered.length;
  }

  async function render() {
    vocabCache = await vocabStore.getAll();
    const filtered = filterVocab(vocabCache, searchQuery);

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
          <p id="csv-status" class="hint">${escapeHtml(csvStatusMessage)}</p>
        </section>

        <section>
          <h3>Vokabeln (<span id="vocab-count">${filtered.length}</span>)</h3>
          <input type="text" id="vocab-search" class="search-input" placeholder="🔍 Suchen (Englisch oder Deutsch) …" value="${escapeHtml(searchQuery)}" />
          <div class="vocab-list" id="vocab-list-container">${renderVocabRowsHtml(filtered)}</div>
        </section>

        <section>
          <h3>Alle Vokabeln löschen</h3>
          <p class="hint">Löscht deine komplette Vokabelliste unwiderruflich (inkl. Lernfortschritt) — z. B. um danach nur eine eigene CSV frisch zu importieren.</p>
          <button class="btn btn-danger" id="delete-all-btn">🗑️ Alle Vokabeln löschen</button>
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

    bindDeleteButtons(container.querySelector('#vocab-list-container'));

    container.querySelector('#vocab-search').addEventListener('input', updateVocabListOnly);

    container.querySelector('#delete-all-btn').addEventListener('click', async () => {
      const count = vocabCache.length;
      if (!confirm(`Wirklich alle ${count} Vokabeln und deinen Lernfortschritt unwiderruflich löschen?`)) return;
      await vocabStore.removeAll();
      syncService.sync();
      searchQuery = '';
      render();
    });

    container.querySelector('#csv-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      container.querySelector('#csv-text').value = await file.text();
    });

    container.querySelector('#csv-import-btn').addEventListener('click', async () => {
      const text = container.querySelector('#csv-text').value;
      const entries = parseCsv(text);
      if (entries.length === 0) {
        csvStatusMessage = 'Keine gültigen Zeilen gefunden.';
        container.querySelector('#csv-status').textContent = csvStatusMessage;
        return;
      }
      const { added, updated } = await vocabStore.addMany(entries);
      syncService.sync();
      csvStatusMessage = updated.length > 0
        ? `${added.length} neu hinzugefügt, ${updated.length} bereits vorhandene aktualisiert.`
        : `${added.length} Vokabeln importiert.`;
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
