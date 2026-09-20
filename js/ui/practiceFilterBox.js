import { practiceFilter } from '../data/practiceFilter.js';
import { filterIcon } from './icons.js';

/**
 * The word-type / category picker shown on the Auto, Quiz and Challenge start
 * screens. Collapsed it is a single line saying what is currently picked, so
 * it stays out of the way while nothing is filtered — which is the normal
 * case — and only takes up room once opened.
 *
 * mount(container) renders into the given element and returns a teardown
 * function; the host re-renders its own screen freely, so this keeps no state
 * beyond "is the panel open".
 */
// Kept across mounts: picking a chip makes the host re-render its screen,
// which remounts this box — without this the panel would snap shut on every
// pick, and the available values would be read again each time.
let open = false;
let types = [];
let categories = [];
let loaded = false;

export function mountPracticeFilter(host, { onChange } = {}) {

  function summary() {
    const { types: pickedTypes, categories: pickedCategories } = practiceFilter.get();
    if (!pickedTypes.length && !pickedCategories.length) return 'Alles gemischt';
    const parts = [];
    if (pickedTypes.length) parts.push(pickedTypes.join(', '));
    if (pickedCategories.length) parts.push(pickedCategories.join(', '));
    return parts.join(' · ');
  }

  function chipsHtml(dimension, values, picked) {
    if (values.length === 0) return `<p class="hint">Keine Angaben vorhanden.</p>`;
    return `<div class="filter-chips">
      ${values.map((v) => `
        <button type="button" class="filter-chip ${picked.includes(v) ? 'active' : ''}" data-dimension="${dimension}" data-value="${escapeHtml(v)}">${escapeHtml(v)}</button>
      `).join('')}
    </div>`;
  }

  function render() {
    const picked = practiceFilter.get();
    const active = practiceFilter.isActive();
    host.innerHTML = `
      <div class="practice-filter ${active ? 'is-active' : ''}">
        <button type="button" class="filter-toggle" id="filter-toggle">
          <span class="icon-inline-wrap">${filterIcon}</span>
          <span class="filter-summary">${escapeHtml(summary())}</span>
          <span class="filter-caret">${open ? '▾' : '▸'}</span>
        </button>
        ${open ? `
          <div class="filter-panel">
            <p class="hint">Worttyp</p>
            ${loaded ? chipsHtml('types', types, picked.types) : `<p class="hint">Lädt …</p>`}
            <p class="hint">Kategorie</p>
            ${loaded ? chipsHtml('categories', categories, picked.categories) : `<p class="hint">Lädt …</p>`}
            <p class="hint">Nichts ausgewählt heißt: alles ist dabei.</p>
            ${active ? `<button type="button" class="btn btn-secondary" id="filter-clear">Auswahl aufheben</button>` : ''}
          </div>` : ''}
      </div>`;

    host.querySelector('#filter-toggle').addEventListener('click', async () => {
      open = !open;
      if (open && !loaded) {
        render(); // show the panel with its loading note straight away
        [types, categories] = await Promise.all([
          practiceFilter.availableTypes(),
          practiceFilter.availableCategories()
        ]);
        loaded = true;
      }
      render();
    });

    host.querySelectorAll('.filter-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        practiceFilter.toggle(chip.dataset.dimension, chip.dataset.value);
        render();
        onChange?.();
      });
    });

    host.querySelector('#filter-clear')?.addEventListener('click', () => {
      practiceFilter.clear();
      render();
      onChange?.();
    });
  }

  render();
  return () => { host.innerHTML = ''; };
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
