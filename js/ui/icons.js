/** Shared line-art icons matching the bottom nav's visual style (stroke="currentColor"). */

function icon(inner) {
  return `<svg class="icon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

export const playIcon = icon(`
  <circle cx="12" cy="12" r="9"/>
  <path d="M10 8.3l6.2 3.7-6.2 3.7z" fill="currentColor" stroke="none"/>
`);

export const checkCircleIcon = icon(`
  <circle cx="12" cy="12" r="9"/>
  <path d="M8 12.4l2.6 2.6 5.4-6"/>
`);

export const xCircleIcon = icon(`
  <circle cx="12" cy="12" r="9"/>
  <path d="M9 9l6 6M15 9l-6 6"/>
`);

export const refreshIcon = icon(`
  <path d="M20 11A8 8 0 0 0 6.3 6.3L4 8.6"/>
  <path d="M4 4v4.6h4.6"/>
  <path d="M4 13a8 8 0 0 0 13.7 4.7L20 15.4"/>
  <path d="M20 20v-4.6h-4.6"/>
`);

export const starIcon = icon(`
  <path d="M12 3.5l2.5 5.2 5.6.6-4.2 3.9 1.2 5.6-5.1-2.9-5.1 2.9 1.2-5.6-4.2-3.9 5.6-.6z"/>
`);

export const speakerIcon = icon(`
  <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/>
  <path d="M15.5 8.7a4.8 4.8 0 0 1 0 6.6"/>
  <path d="M18 6.3a8.5 8.5 0 0 1 0 11.4"/>
`);

export const micIcon = icon(`
  <rect x="9" y="3" width="6" height="11" rx="3"/>
  <path d="M5 11a7 7 0 0 0 14 0"/>
  <path d="M12 18v3"/>
  <path d="M9 21h6"/>
`);

export const tapIcon = icon(`
  <circle cx="12" cy="12" r="3"/>
  <path d="M12 3v2.4M12 18.6V21M21 12h-2.4M5.4 12H3M18.4 5.6l-1.7 1.7M7.3 16.7l-1.7 1.7M18.4 18.4l-1.7-1.7M7.3 7.3L5.6 5.6"/>
`);

export const keyboardIcon = icon(`
  <rect x="3" y="6" width="18" height="12" rx="2"/>
  <path d="M6.5 10h.01M9.5 10h.01M12.5 10h.01M15.5 10h.01M17.5 10h.01"/>
  <path d="M6.5 13.8h11"/>
`);

export const warningIcon = icon(`
  <path d="M12 4L3 20h18L12 4z"/>
  <path d="M12 10v4"/>
  <circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none"/>
`);

export const errorIcon = icon(`
  <circle cx="12" cy="12" r="9"/>
  <path d="M6.5 6.5l11 11"/>
`);

export const hourglassIcon = icon(`
  <path d="M6 3h12M6 21h12"/>
  <path d="M7 3c0 4.5 3 5.5 5 6.5 2-1 5-2 5-6.5"/>
  <path d="M7 21c0-4.5 3-5.5 5-6.5 2 1 5 2 5 6.5"/>
`);

export const thinkingIcon = icon(`
  <path d="M12 4a7 7 0 0 0-6 10.6L5 20l5.4-1a7 7 0 1 0 1.6-15z"/>
  <circle cx="9" cy="12" r="0.7" fill="currentColor" stroke="none"/>
  <circle cx="12.5" cy="12" r="0.7" fill="currentColor" stroke="none"/>
  <circle cx="16" cy="12" r="0.7" fill="currentColor" stroke="none"/>
`);

export const skipIcon = icon(`
  <path d="M6 5v14l10-7z" fill="currentColor" stroke="none"/>
  <path d="M18 5v14"/>
`);

export const trashIcon = icon(`
  <path d="M4 7h16"/>
  <path d="M9 7V4.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1V7"/>
  <path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/>
  <path d="M10 11v6M14 11v6"/>
`);

export const searchIcon = icon(`
  <circle cx="10.5" cy="10.5" r="6.5"/>
  <path d="M20 20l-4.8-4.8"/>
`);

export const checklistIcon = icon(`
  <rect x="4" y="5" width="3" height="3" rx="0.8"/>
  <rect x="4" y="10.5" width="3" height="3" rx="0.8"/>
  <rect x="4" y="16" width="3" height="3" rx="0.8"/>
  <path d="M10 6.5h10M10 12h10M10 17.5h10"/>
`);

export const editIcon = icon(`
  <path d="M4 20l0.7-3.5L16.5 4.7a1.5 1.5 0 0 1 2.1 0l0.7 0.7a1.5 1.5 0 0 1 0 2.1L7.5 19.3 4 20z"/>
  <path d="M14.5 6.7l2.8 2.8"/>
`);

export const flameIcon = icon(`
  <path d="M12 3c1 3-3 4.5-3 8.5a3 3 0 0 0 6 0c.5-1 .3-2.3-0.3-3.2 1.5 1.5 2.3 3.5 2.3 5.7a5 5 0 0 1-10 0c0-4.2 2.3-6.3 3.5-8.2C10.9 5 11.5 4 12 3z"/>
`);

export const downloadIcon = icon(`
  <path d="M12 4v11"/>
  <path d="M7.5 11.5L12 16l4.5-4.5"/>
  <path d="M5 19.5h14"/>
`);

export const chartIcon = icon(`
  <path d="M4 20V10M10 20V4M16 20v-7M4 20h16"/>
`);
