/** index: 0-based index of the current card within the session. */
export function progressBarHtml(index, total) {
  const pct = total > 0 ? Math.round((index / total) * 100) : 0;
  return `
    <div class="progress-wrap"><div class="progress-bar" style="width:${pct}%"></div></div>
    <div class="progress-text">${index + 1} / ${total}</div>`;
}
