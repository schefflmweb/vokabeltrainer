import { vocabStore } from '../data/vocabStore.js';
import { grammarStore } from '../data/grammarStore.js';
import { idiomStore } from '../data/idiomStore.js';
import { parseCsv, toCsv, parseGrammarCsv, grammarToCsv } from '../csv/csvImport.js';
import { firebaseAuth, authErrorMessage } from '../auth/firebaseAuth.js';
import { syncService } from '../data/syncService.js';
import { deviceRole } from '../data/deviceRole.js';
import { ttsService } from '../tts/ttsService.js';
import { trashIcon, searchIcon, editIcon, checkCircleIcon, xCircleIcon, downloadIcon, chartIcon, flameIcon, speakerIcon, bookIcon, quoteIcon, checklistIcon } from '../ui/icons.js';
import { APP_VERSION } from '../version.js';

const VOICE_SAMPLES = { en: 'This is what I sound like.', de: 'So höre ich mich an.' };

function filterVocab(list, query) {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((v) => v.en.toLowerCase().includes(q) || v.de.toLowerCase().includes(q));
}

const WORTART_OPTIONS = ['Nomen', 'Verb', 'Adjektiv', 'Adverb', 'Präposition', 'Redewendung', 'Pronomen', 'Konjunktion'];

function wortartDatalistHtml() {
  return `<datalist id="wortart-list">${WORTART_OPTIONS.map((w) => `<option value="${w}"></option>`).join('')}</datalist>`;
}

function renderEditRowHtml(v) {
  return `
    <form class="vocab-row vocab-row-editing edit-form" data-id="${v.id}">
      <input type="text" name="en" value="${escapeHtml(v.en)}" placeholder="Englisch" required />
      <input type="text" name="de" value="${escapeHtml(v.de)}" placeholder="Deutsch" required />
      <input type="text" name="category" value="${escapeHtml(v.category)}" placeholder="Kategorie" />
      <input type="text" name="example" value="${escapeHtml(v.example || '')}" placeholder="Beispielsatz (optional)" />
      <input type="text" name="type" value="${escapeHtml(v.type || '')}" placeholder="Wortart (optional)" list="wortart-list" />
      <div class="edit-actions">
        <button type="submit" class="btn btn-icon btn-primary" aria-label="Speichern"><span class="icon-inline-wrap">${checkCircleIcon}</span></button>
        <button type="button" class="btn btn-icon cancel-edit-btn" aria-label="Abbrechen"><span class="icon-inline-wrap">${xCircleIcon}</span></button>
      </div>
    </form>`;
}

const VOCAB_PAGE_SIZE = 150;

/**
 * Only the first `visibleCount` entries are turned into DOM — with large
 * imported lists (thousands of words), rendering every row at once made
 * opening/searching "Verwalten" very slow. A "Mehr anzeigen" button reveals
 * more in pages instead.
 */
function renderVocabRowsHtml(list, editingId, visibleCount, canEdit) {
  if (list.length === 0) {
    return `<p class="hint">Keine Treffer.</p>`;
  }
  const page = list.slice(0, visibleCount);
  const byCategory = {};
  for (const v of page) {
    (byCategory[v.category] ||= []).push(v);
  }
  const categories = Object.keys(byCategory).sort();
  const rowsHtml = categories.map((cat) => `
    <div class="vocab-category">
      <h4>${escapeHtml(cat)}</h4>
      ${byCategory[cat].map((v) => v.id === editingId ? renderEditRowHtml(v) : `
        <div class="vocab-row" data-id="${v.id}">
          <span>${escapeHtml(v.en)} – ${escapeHtml(v.de)}${v.type ? ` <span class="word-type-badge">${escapeHtml(v.type)}</span>` : ''}</span>
          ${canEdit ? `<span class="row-actions">
            <button class="btn btn-icon edit-btn" data-id="${v.id}" aria-label="Bearbeiten"><span class="icon-inline-wrap">${editIcon}</span></button>
            <button class="btn btn-icon delete-btn" data-id="${v.id}" aria-label="Löschen"><span class="icon-inline-wrap">${trashIcon}</span></button>
          </span>` : ''}
        </div>
      `).join('')}
    </div>
  `).join('');

  const remaining = list.length - page.length;
  const moreHtml = remaining > 0
    ? `<button type="button" class="btn btn-secondary" id="vocab-load-more-btn">Weitere ${Math.min(remaining, VOCAB_PAGE_SIZE)} anzeigen (${remaining} übrig)</button>`
    : '';

  return rowsHtml + moreHtml;
}

export function mount(container) {
  let unsubscribeStatus = null;
  let unsubscribeVoices = null;
  let csvStatusMessage = '';
  let grammarCsvStatusMessage = '';
  let idiomCsvStatusMessage = '';
  let searchQuery = '';
  let vocabCache = [];
  let grammarAllCache = [];
  let grammarCount = 0;
  let idiomAllCache = [];
  let idiomCount = 0;
  let editingId = null;
  let lastSyncState = null;
  let visibleCount = VOCAB_PAGE_SIZE;

  function bindRowActions(scopeEl) {
    scopeEl.querySelectorAll('.delete-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        await vocabStore.remove(id);
        syncService.sync();
        vocabCache = vocabCache.filter((v) => v.id !== id);
        updateStatsUI();
        updateVocabListOnly();
      });
    });

    scopeEl.querySelectorAll('.edit-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        editingId = btn.dataset.id;
        updateVocabListOnly();
      });
    });

    scopeEl.querySelectorAll('.cancel-edit-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        editingId = null;
        updateVocabListOnly();
      });
    });

    scopeEl.querySelectorAll('.edit-form').forEach((form) => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(form).entries());
        if (!data.en.trim() || !data.de.trim()) return;
        const updated = await vocabStore.update(form.dataset.id, data);
        syncService.sync();
        const idx = vocabCache.findIndex((v) => v.id === updated.id);
        if (idx !== -1) vocabCache[idx] = updated;
        editingId = null;
        updateStatsUI();
        updateVocabListOnly();
      });
    });

    scopeEl.querySelector('#vocab-load-more-btn')?.addEventListener('click', () => {
      visibleCount += VOCAB_PAGE_SIZE;
      updateVocabListOnly();
    });
  }

  /** Re-renders only the list + count, leaving the search input itself untouched so it never loses focus while typing. */
  function updateVocabListOnly() {
    const listEl = container.querySelector('#vocab-list-container');
    if (!listEl) return; // Verwalten isn't the visible screen anymore (e.g. a sync callback resolving after navigating away) — nothing to update.
    const input = container.querySelector('#vocab-search');
    const newQuery = input ? input.value : searchQuery;
    if (newQuery !== searchQuery) visibleCount = VOCAB_PAGE_SIZE; // fresh search — start paging from the top again
    searchQuery = newQuery;
    const filtered = filterVocab(vocabCache, searchQuery);
    listEl.innerHTML = renderVocabRowsHtml(filtered, editingId, visibleCount, deviceRole.isMaster());
    bindRowActions(listEl);
    const countEl = container.querySelector('#vocab-count');
    if (countEl) countEl.textContent = filtered.length;
  }

  function exportCsv() {
    const csv = toCsv(vocabCache);
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const dateStr = new Date().toISOString().slice(0, 10);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vokabeltrainer-export-${dateStr}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function exportIdiomCsv(list) {
    const csv = toCsv(list);
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const dateStr = new Date().toISOString().slice(0, 10);
    const a = document.createElement('a');
    a.href = url;
    a.download = `idioms-export-${dateStr}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function exportGrammarCsv(list) {
    const csv = grammarToCsv(list);
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const dateStr = new Date().toISOString().slice(0, 10);
    const a = document.createElement('a');
    a.href = url;
    a.download = `grammatik-export-${dateStr}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /** Re-reads just the (small) grammar collection and refreshes its count — used after a grammar-only edit, so it doesn't also pay for reloading the whole (possibly much larger) vocab collection like a full render() would. */
  async function updateGrammarUI() {
    if (!container.querySelector('.manage-mode')) return;
    grammarAllCache = await grammarStore.getAll();
    grammarCount = grammarAllCache.length;
    const el = container.querySelector('#grammar-count');
    if (el) el.textContent = grammarCount;
  }

  /** Same as updateGrammarUI(), for the idioms collection. */
  async function updateIdiomUI() {
    if (!container.querySelector('.manage-mode')) return;
    idiomAllCache = await idiomStore.getAll();
    idiomCount = idiomAllCache.length;
    const el = container.querySelector('#idiom-count');
    if (el) el.textContent = idiomCount;
  }

  /** Recomputes the stat tiles from the in-memory vocabCache — no DB read, so it's cheap to call after every local edit. */
  async function updateStatsUI() {
    if (!container.querySelector('.manage-mode')) return; // Verwalten isn't the visible screen anymore.
    const now = Date.now();
    const dueToday = vocabCache.filter((v) => v.srs.dueDate <= now).length;
    const learned = vocabCache.filter((v) => v.srs.repetitions >= 2).length;
    const streak = await vocabStore.getStreak();
    const statTiles = container.querySelectorAll('.stat-value');
    if (statTiles[0]) statTiles[0].textContent = vocabCache.length;
    if (statTiles[1]) statTiles[1].textContent = dueToday;
    if (statTiles[2]) statTiles[2].textContent = learned;
    if (statTiles[3]) statTiles[3].innerHTML = `<span class="icon-inline-wrap">${flameIcon}</span> ${streak.count}`;
  }

  /**
   * Re-reads counts/lists after a sync pulls in changes from another device
   * (a CSV imported there, progress reviewed there, ...) — without a full
   * render(), which would disrupt an in-progress edit or search. This is the
   * one path that must re-fetch from IndexedDB, since remote changes aren't
   * reflected in the in-memory vocabCache yet.
   */
  async function refreshAfterSync() {
    if (!container.querySelector('.manage-mode')) return; // Verwalten isn't the visible screen anymore.

    vocabCache = await vocabStore.getAll();
    updateVocabListOnly();
    await updateGrammarUI();
    await updateIdiomUI();
    await updateStatsUI();
  }

  async function render() {
    // Loading a large collection can take a moment — show something
    // immediately instead of leaving the screen blank while it loads.
    if (!container.querySelector('.manage-mode')) {
      container.innerHTML = `<div class="manage-mode pad"><p class="hint">Lädt …</p></div>`;
    }
    await firebaseAuth.ready();
    vocabCache = await vocabStore.getAll();
    const filtered = filterVocab(vocabCache, searchQuery);
    grammarAllCache = await grammarStore.getAll();
    grammarCount = grammarAllCache.length;
    idiomAllCache = await idiomStore.getAll();
    idiomCount = idiomAllCache.length;

    const now = Date.now();
    const dueToday = vocabCache.filter((v) => v.srs.dueDate <= now).length;
    const learned = vocabCache.filter((v) => v.srs.repetitions >= 2).length;
    const streak = await vocabStore.getStreak();
    // Master data is only editable on the master device (see deviceRole.js) —
    // everything that would change or delete a record is left out entirely on
    // a reader rather than shown and then refused.
    const isMaster = deviceRole.isMaster();

    container.innerHTML = `
      <div class="manage-mode pad">
        <section class="progress-box">
          <h3><span class="icon-inline-wrap">${chartIcon}</span> Fortschritt</h3>
          <div class="stats-grid">
            <div class="stat-tile">
              <div class="stat-value">${vocabCache.length}</div>
              <div class="stat-label">Vokabeln gesamt</div>
            </div>
            <div class="stat-tile">
              <div class="stat-value">${dueToday}</div>
              <div class="stat-label">Heute fällig</div>
            </div>
            <div class="stat-tile">
              <div class="stat-value">${learned}</div>
              <div class="stat-label">Gelernt</div>
            </div>
            <div class="stat-tile">
              <div class="stat-value stat-with-icon"><span class="icon-inline-wrap">${flameIcon}</span> ${streak.count}</div>
              <div class="stat-label">Tage in Folge</div>
            </div>
          </div>
        </section>

        <section class="account-box" id="device-role-box"></section>

        <section class="account-box" id="account-box"></section>

        <section class="voice-box" id="voice-box"></section>

        ${isMaster ? `
        <section>
          <h3>Neue Vokabel</h3>
          <form id="add-form" class="add-form">
            <input type="text" name="en" placeholder="Englisch" required />
            <input type="text" name="de" placeholder="Deutsch" required />
            <input type="text" name="category" placeholder="Kategorie (optional)" />
            <input type="text" name="example" placeholder="Beispielsatz (optional)" />
            <input type="text" name="type" placeholder="Wortart (optional)" list="wortart-list" />
            <button type="submit" class="btn btn-primary">Hinzufügen</button>
          </form>
          ${wortartDatalistHtml()}
        </section>` : ''}

        <section>
          <h3>CSV-${isMaster ? 'Import &amp; Export' : 'Export'}</h3>
          ${isMaster ? `
          <p class="hint">Spalten: Englisch, Deutsch, Kategorie (optional), Beispiel (optional), Wortart (optional)</p>
          <input type="file" id="csv-file" accept=".csv,text/csv" />
          <textarea id="csv-text" rows="4" placeholder="cat,Katze&#10;dog,Hund"></textarea>
          <button class="btn btn-secondary" id="csv-import-btn">Importieren</button>
          <p id="csv-status" class="hint">${escapeHtml(csvStatusMessage)}</p>` : ''}
          <button class="btn btn-secondary btn-with-icon" id="csv-export-btn"><span class="icon-inline-wrap">${downloadIcon}</span> Als CSV exportieren</button>
        </section>

        <section>
          <h3>Vokabeln (<span id="vocab-count">${filtered.length}</span>)</h3>
          <div class="search-wrap">
            <span class="icon-inline-wrap search-icon">${searchIcon}</span>
            <input type="text" id="vocab-search" class="search-input" placeholder="Suchen (Englisch oder Deutsch) …" value="${escapeHtml(searchQuery)}" />
          </div>
          <div class="vocab-list" id="vocab-list-container">${renderVocabRowsHtml(filtered, editingId, visibleCount, isMaster)}</div>
        </section>

        ${isMaster ? `
        <section>
          <h3>Alle Vokabeln löschen</h3>
          <p class="hint">Löscht deine komplette Vokabelliste unwiderruflich — lokal <strong>und in der Cloud</strong>, inklusive Lernfortschritt. Es bleibt nichts zum Wiederherstellen übrig. Die anderen Geräte leeren ihre Liste ebenfalls, sobald sie das nächste Mal synchronisieren.</p>
          <button class="btn btn-danger btn-with-icon" id="delete-all-btn"><span class="icon-inline-wrap">${trashIcon}</span> Alle Vokabeln löschen (lokal + Cloud)</button>
        </section>` : ''}

        <section>
          <h3><span class="icon-inline-wrap">${bookIcon}</span> Grammatik (<span id="grammar-count">${grammarCount}</span>)</h3>
          ${isMaster ? `
          <p class="hint">Übungen per CSV importieren. Spalten: Thema, Frage (___ für die Lücke), Option1, Option2, Option3, Option4, Richtig (1-4), Erklärung (optional)</p>
          <input type="file" id="grammar-csv-file" accept=".csv,text/csv" />
          <textarea id="grammar-csv-text" rows="4" placeholder="Präpositionen,I was born ___ 1995.,in,on,at,since,1,Jahre: in"></textarea>
          <button class="btn btn-secondary" id="grammar-csv-import-btn">Importieren</button>
          <p id="grammar-csv-status" class="hint">${escapeHtml(grammarCsvStatusMessage)}</p>` : ''}
          <button class="btn btn-secondary btn-with-icon" id="grammar-csv-export-btn"><span class="icon-inline-wrap">${downloadIcon}</span> Als CSV exportieren</button>
          ${isMaster ? `<button class="btn btn-danger btn-with-icon" id="grammar-delete-all-btn"><span class="icon-inline-wrap">${trashIcon}</span> Alle Grammatikübungen löschen (lokal + Cloud)</button>` : ''}
        </section>

        <section>
          <h3><span class="icon-inline-wrap">${quoteIcon}</span> Idioms (<span id="idiom-count">${idiomCount}</span>)</h3>
          <p class="hint">Eigene Sammlung, getrennt von den Vokabeln — in Auto- und Quiz-Modus per Umschalter "Vokabeln / Idioms / Beide" wählbar.</p>
          ${isMaster ? `
          <p class="hint">Per CSV importieren. Spalten: Englisch (die Redewendung), Deutsch (Bedeutung), Kategorie (optional), Beispielsatz (optional), Wortart (optional)</p>
          <input type="file" id="idiom-csv-file" accept=".csv,text/csv" />
          <textarea id="idiom-csv-text" rows="4" placeholder="break the ice,das Eis brechen"></textarea>
          <button class="btn btn-secondary" id="idiom-csv-import-btn">Importieren</button>
          <p id="idiom-csv-status" class="hint">${escapeHtml(idiomCsvStatusMessage)}</p>` : ''}
          <button class="btn btn-secondary btn-with-icon" id="idiom-csv-export-btn"><span class="icon-inline-wrap">${downloadIcon}</span> Als CSV exportieren</button>
          ${isMaster ? `<button class="btn btn-danger btn-with-icon" id="idiom-delete-all-btn"><span class="icon-inline-wrap">${trashIcon}</span> Alle Idioms löschen (lokal + Cloud)</button>` : ''}
        </section>

        <p class="hint center-text app-version">App-Version ${APP_VERSION}</p>
      </div>`;

    container.querySelector('#add-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const data = Object.fromEntries(new FormData(form).entries());
      if (!data.en.trim() || !data.de.trim()) return;
      const record = await vocabStore.add(data, vocabCache);
      syncService.sync();
      form.reset();
      const idx = vocabCache.findIndex((v) => v.id === record.id);
      if (idx !== -1) vocabCache[idx] = record; else vocabCache.push(record);
      updateStatsUI();
      updateVocabListOnly();
    });

    bindRowActions(container.querySelector('#vocab-list-container'));

    container.querySelector('#vocab-search').addEventListener('input', updateVocabListOnly);

    container.querySelector('#csv-export-btn').addEventListener('click', exportCsv);

    container.querySelector('#delete-all-btn')?.addEventListener('click', async () => {
      const count = vocabCache.length;
      if (!confirm(`Wirklich alle ${count} Vokabeln und deinen Lernfortschritt unwiderruflich löschen?`)) return;
      await vocabStore.removeAll();
      syncService.sync();
      vocabCache = [];
      searchQuery = '';
      visibleCount = VOCAB_PAGE_SIZE;
      const searchInput = container.querySelector('#vocab-search');
      if (searchInput) searchInput.value = '';
      updateStatsUI();
      updateVocabListOnly();
    });

    container.querySelector('#csv-file')?.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      container.querySelector('#csv-text').value = await file.text();
    });

    container.querySelector('#csv-import-btn')?.addEventListener('click', async () => {
      const text = container.querySelector('#csv-text').value;
      const entries = parseCsv(text);
      if (entries.length === 0) {
        csvStatusMessage = 'Keine gültigen Zeilen gefunden.';
        container.querySelector('#csv-status').textContent = csvStatusMessage;
        return;
      }
      const { added, updated } = await vocabStore.addMany(entries, vocabCache);
      syncService.sync();
      const changedIds = new Set([...added, ...updated].map((v) => v.id));
      vocabCache = vocabCache.filter((v) => !changedIds.has(v.id)).concat(added, updated);
      csvStatusMessage = updated.length > 0
        ? `${added.length} neu hinzugefügt, ${updated.length} bereits vorhandene aktualisiert.`
        : `${added.length} Vokabeln importiert.`;
      container.querySelector('#csv-status').textContent = csvStatusMessage;
      container.querySelector('#csv-text').value = '';
      updateStatsUI();
      updateVocabListOnly();
    });

    container.querySelector('#grammar-csv-file')?.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      container.querySelector('#grammar-csv-text').value = await file.text();
    });

    container.querySelector('#grammar-csv-import-btn')?.addEventListener('click', async () => {
      const text = container.querySelector('#grammar-csv-text').value;
      const entries = parseGrammarCsv(text);
      if (entries.length === 0) {
        grammarCsvStatusMessage = 'Keine gültigen Zeilen gefunden.';
        container.querySelector('#grammar-csv-status').textContent = grammarCsvStatusMessage;
        return;
      }
      const { added, updated } = await grammarStore.addMany(entries);
      syncService.sync();
      grammarCsvStatusMessage = updated.length > 0
        ? `${added.length} neu hinzugefügt, ${updated.length} bereits vorhandene aktualisiert.`
        : `${added.length} Übungen importiert.`;
      container.querySelector('#grammar-csv-status').textContent = grammarCsvStatusMessage;
      container.querySelector('#grammar-csv-text').value = '';
      updateGrammarUI();
    });

    container.querySelector('#grammar-csv-export-btn').addEventListener('click', () => exportGrammarCsv(grammarAllCache));

    container.querySelector('#grammar-delete-all-btn')?.addEventListener('click', async () => {
      if (!confirm(`Wirklich alle ${grammarCount} Grammatikübungen (inkl. Fortschritt) unwiderruflich löschen?`)) return;
      await grammarStore.removeAll();
      syncService.sync();
      updateGrammarUI();
    });

    container.querySelector('#idiom-csv-file')?.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      container.querySelector('#idiom-csv-text').value = await file.text();
    });

    container.querySelector('#idiom-csv-import-btn')?.addEventListener('click', async () => {
      const text = container.querySelector('#idiom-csv-text').value;
      const entries = parseCsv(text);
      if (entries.length === 0) {
        idiomCsvStatusMessage = 'Keine gültigen Zeilen gefunden.';
        container.querySelector('#idiom-csv-status').textContent = idiomCsvStatusMessage;
        return;
      }
      const { added, updated } = await idiomStore.addMany(entries, idiomAllCache);
      syncService.sync();
      idiomCsvStatusMessage = updated.length > 0
        ? `${added.length} neu hinzugefügt, ${updated.length} bereits vorhandene aktualisiert.`
        : `${added.length} Idioms importiert.`;
      container.querySelector('#idiom-csv-status').textContent = idiomCsvStatusMessage;
      container.querySelector('#idiom-csv-text').value = '';
      updateIdiomUI();
    });

    container.querySelector('#idiom-csv-export-btn').addEventListener('click', () => exportIdiomCsv(idiomAllCache));

    container.querySelector('#idiom-delete-all-btn')?.addEventListener('click', async () => {
      if (!confirm(`Wirklich alle ${idiomCount} Idioms (inkl. Lernfortschritt) unwiderruflich löschen?`)) return;
      await idiomStore.removeAll();
      syncService.sync();
      updateIdiomUI();
    });

    renderDeviceRoleBox();
    renderAccountBox();
    renderVoiceBox();
  }

  /**
   * Shows what this device is allowed to do and lets it be overridden. The
   * detected role already does the right thing for the PC and the iPhone/
   * iPad, so this is for the cases detection can't know about — a second
   * Windows machine that should stay read-only, or a different computer
   * taking over as the one that maintains the lists.
   */
  function renderDeviceRoleBox() {
    const box = container.querySelector('#device-role-box');
    if (!box) return;

    const isMaster = deviceRole.isMaster();
    box.innerHTML = `
      <h3><span class="icon-inline-wrap">${checklistIcon}</span> Dieses Gerät</h3>
      <p class="hint">${isMaster
        ? 'Hauptgerät: Hier werden Vokabeln, Idioms und Grammatik gepflegt (hinzufügen, bearbeiten, importieren, löschen) und in die Cloud hochgeladen.'
        : 'Nur Lesen: Stammdaten kommen ausschließlich aus der Cloud. Dieses Gerät lädt nur seinen eigenen Lernfortschritt hoch — Vokabeln, Idioms und Grammatik werden hier weder geändert noch gelöscht.'}</p>
      <p class="hint">Automatisch erkannt: ${deviceRole.detected === 'master' ? 'Hauptgerät (Windows-PC)' : 'Nur Lesen'}${deviceRole.isAuto() ? '' : ' — von Hand überschrieben'}</p>
      <button class="btn btn-secondary" id="device-role-toggle-btn">${isMaster ? 'Auf "nur Lesen" umstellen' : 'Als Hauptgerät festlegen'}</button>
      ${deviceRole.isAuto() ? '' : '<button class="btn btn-secondary" id="device-role-auto-btn">Wieder automatisch erkennen</button>'}`;

    box.querySelector('#device-role-toggle-btn').addEventListener('click', () => {
      if (!isMaster && !confirm('Dieses Gerät als Hauptgerät festlegen? Änderungen und Löschungen von hier aus werden dann in die Cloud übertragen und gelten für alle Geräte.')) return;
      deviceRole.set(isMaster ? 'reader' : 'master');
      render();
    });

    box.querySelector('#device-role-auto-btn')?.addEventListener('click', () => {
      deviceRole.set(null);
      render();
    });
  }

  /**
   * Shows how many records on THIS device are still marked dirty (added or
   * edited locally but not yet confirmed pushed to Firestore) — the "In der
   * Cloud" count above already includes these unconfirmed local records
   * (mergeFromRemote keeps any local record with no remote match), so a
   * device that's stuck failing to push looks like it simply "has more"
   * rather than "has unsynced" data. This makes that distinction visible
   * instead of silently folding it into one ambiguous total.
   */
  async function updateUnsyncedText() {
    const el = container.querySelector('#sync-unsynced-text');
    if (!el) return;
    const [vocabDirty, grammarDirty, idiomDirty] = await Promise.all([
      vocabStore.getDirty(),
      grammarStore.getDirty(),
      idiomStore.getDirty()
    ]);
    const total = vocabDirty.length + grammarDirty.length + idiomDirty.length;
    el.textContent = total > 0
      ? `${total} Änderung(en) auf diesem Gerät noch nicht in der Cloud bestätigt (${vocabDirty.length} Vokabeln, ${grammarDirty.length} Grammatik, ${idiomDirty.length} Idioms).`
      : 'Alle lokalen Änderungen sind in der Cloud bestätigt.';
  }

  function renderAccountBox() {
    const box = container.querySelector('#account-box');
    if (!box) return;

    const connected = firebaseAuth.isConfigured();
    box.innerHTML = `
      <h3>Cloud-Sync</h3>
      ${connected
        ? `<p class="hint">Angemeldet als ${escapeHtml(firebaseAuth.getEmail())}</p>
           <p class="hint" id="sync-status-text">–</p>
           <p class="hint" id="sync-counts-text"></p>
           <p class="hint" id="sync-unsynced-text"></p>
           <button class="btn btn-secondary" id="disconnect-btn">Trennen</button>
           <button class="btn btn-secondary" id="sync-now-btn">Jetzt synchronisieren</button>
           <button class="btn btn-secondary" id="full-resync-btn">Vollständig neu abrufen</button>
           <p class="hint">Falls die Zahl auf diesem Gerät dauerhaft niedriger bleibt als auf einem anderen: "Vollständig neu abrufen" holt wirklich alles nochmal frisch aus der Cloud. Löscht nichts, betrifft nur diesen einen Abgleich-Zwischenstand auf diesem Gerät. Zählt bei der kostenlosen Firebase-Stufe als ein Lesevorgang pro Vokabel — bei großen Sammlungen sparsam einsetzen, nicht mehrmals hintereinander.</p>`
        : `<p class="hint">Vokabeln zwischen Geräten abgleichen — mit dem Sync-Login anmelden, das in Firebase für diese App angelegt wurde (siehe SETUP-FIREBASE-SYNC.md).</p>
           <form id="login-form" class="add-form">
             <input type="email" id="email-input" placeholder="E-Mail" autocomplete="username" required />
             <input type="password" id="password-input" placeholder="Passwort" autocomplete="current-password" required />
             <button type="submit" class="btn btn-primary">Verbinden</button>
           </form>
           <p class="hint" id="sync-status-text"></p>`}
    `;

    if (connected) {
      box.querySelector('#disconnect-btn').addEventListener('click', async () => {
        await firebaseAuth.disconnect();
        renderAccountBox();
      });
      // force: this button is also the way out of a sync the watchdog has
      // given up on — it starts a fresh run instead of joining the stuck one.
      box.querySelector('#sync-now-btn').addEventListener('click', () => syncService.sync({ force: true }));
      box.querySelector('#full-resync-btn').addEventListener('click', () => syncService.fullResync());
      updateUnsyncedText();
    } else {
      box.querySelector('#login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = box.querySelector('#email-input').value.trim();
        const password = box.querySelector('#password-input').value;
        if (!email || !password) return;
        try {
          await firebaseAuth.signIn(email, password);
        } catch (err) {
          const statusEl = box.querySelector('#sync-status-text');
          if (statusEl) statusEl.textContent = authErrorMessage(err);
          return;
        }
        renderAccountBox();
        syncService.sync();
      });
    }

    unsubscribeStatus?.();
    unsubscribeStatus = syncService.onStatusChange((status) => {
      const el = container.querySelector('#sync-status-text');
      if (el) el.textContent = status.message;
      const countsEl = container.querySelector('#sync-counts-text');
      if (countsEl && status.counts) {
        const vocabN = status.counts.vocab ?? 0;
        const grammarN = status.counts.grammar ?? 0;
        const idiomN = status.counts.idioms ?? 0;
        countsEl.textContent = `In der Cloud: ${vocabN} Vokabeln, ${grammarN} Grammatikübungen, ${idiomN} Idioms`;
      }
      if (status.state === 'synced' || status.state === 'error') updateUnsyncedText();
    });
  }

  function renderVoiceBox() {
    const box = container.querySelector('#voice-box');
    if (!box) return;

    if (!ttsService.isSupported()) {
      box.innerHTML = `
        <h3><span class="icon-inline-wrap">${speakerIcon}</span> Vorlese-Stimme</h3>
        <p class="hint">Sprachausgabe wird auf diesem Gerät nicht unterstützt.</p>`;
      return;
    }

    const voiceOptionsHtml = (langPrefix) => {
      const voices = ttsService.listVoices(langPrefix);
      if (voices.length === 0) return `<option value="">Wird geladen …</option>`;
      const preferred = ttsService.getPreferredVoiceName(langPrefix);
      const selectedName = preferred && voices.some((v) => v.name === preferred) ? preferred : voices[0].name;
      return voices.map((v) => {
        const origin = ttsService.runsOnDevice(v) ? 'auf dem Gerät' : 'aus dem Netz';
        return `<option value="${escapeHtml(v.name)}" ${v.name === selectedName ? 'selected' : ''}>${escapeHtml(v.name)} (${escapeHtml(v.lang)}) · ${origin}</option>`;
      }).join('');
    };

    box.innerHTML = `
      <h3><span class="icon-inline-wrap">${speakerIcon}</span> Vorlese-Stimme</h3>
      <p class="hint">Gilt fürs Vorlesen im Auto-Modus, falls dein Gerät mehrere Stimmen anbietet. Stimmen „auf dem Gerät“ sprechen sofort und funktionieren ohne Netz — Netz-Stimmen können unterwegs verzögert starten oder stumm bleiben.</p>
      <div class="voice-row">
        <span class="voice-row-label">Englisch</span>
        <select class="voice-select" id="voice-select-en">${voiceOptionsHtml('en')}</select>
        <button type="button" class="btn btn-icon" id="voice-test-en" aria-label="Englische Stimme anhören"><span class="icon-inline-wrap">${speakerIcon}</span></button>
      </div>
      <div class="voice-row">
        <span class="voice-row-label">Deutsch</span>
        <select class="voice-select" id="voice-select-de">${voiceOptionsHtml('de')}</select>
        <button type="button" class="btn btn-icon" id="voice-test-de" aria-label="Deutsche Stimme anhören"><span class="icon-inline-wrap">${speakerIcon}</span></button>
      </div>
      <details id="tts-debug-details">
        <summary>Diagnose-Log (bei Problemen mit der Sprachausgabe, z. B. im Auto)</summary>
        <p class="hint">Zeichnet auf, was die Sprachausgabe auf diesem Gerät tatsächlich tut — hilfreich, wenn Vorlesen unterwegs ausbleibt oder verspätet kommt. Am besten kurz vor der Fahrt hier "Leeren" antippen, damit der ganze Verlauf hineinpasst; nach der Fahrt "Kopieren" antippen und den Text schicken.</p>
        <textarea id="tts-debug-log" rows="8" readonly></textarea>
        <button type="button" class="btn btn-secondary" id="tts-debug-copy-btn">Kopieren</button>
        <button type="button" class="btn btn-secondary" id="tts-debug-clear-btn">Leeren</button>
      </details>`;

    ['en', 'de'].forEach((langPrefix) => {
      const select = box.querySelector(`#voice-select-${langPrefix}`);
      select.addEventListener('change', () => ttsService.setPreferredVoiceName(langPrefix, select.value));
      box.querySelector(`#voice-test-${langPrefix}`).addEventListener('click', () => {
        ttsService.previewVoice(langPrefix, select.value, VOICE_SAMPLES[langPrefix]);
      });
    });

    const debugLogEl = box.querySelector('#tts-debug-log');
    const fillDebugLog = () => { debugLogEl.value = ttsService.getDebugLog().join('\n'); };
    box.querySelector('#tts-debug-details').addEventListener('toggle', (e) => {
      if (e.target.open) fillDebugLog();
    });
    box.querySelector('#tts-debug-copy-btn').addEventListener('click', async () => {
      fillDebugLog();
      debugLogEl.select();
      try {
        await navigator.clipboard.writeText(debugLogEl.value);
      } catch {
        document.execCommand('copy'); // clipboard API unavailable — the selection above still lets this fall back
      }
    });
    box.querySelector('#tts-debug-clear-btn').addEventListener('click', () => {
      ttsService.clearDebugLog();
      fillDebugLog();
    });

    unsubscribeVoices?.();
    unsubscribeVoices = ttsService.onVoicesChange(() => renderVoiceBox());
  }

  render();

  // Own, permanent subscription (unlike renderAccountBox's, which is torn
  // down/recreated on every render) so a sync completing anywhere — on
  // startup, in the background, or triggered from another mode — refreshes
  // the counts shown here even while this screen stays open. Edge-triggered
  // on the transition *into* 'synced' so it doesn't re-fire on every repeat
  // status ping.
  const unsubscribeAutoRefresh = syncService.onStatusChange((status) => {
    if (status.state === 'synced' && lastSyncState !== 'synced') {
      refreshAfterSync();
    }
    lastSyncState = status.state;
  });

  return () => {
    unsubscribeStatus?.();
    unsubscribeVoices?.();
    unsubscribeAutoRefresh?.();
  };
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
