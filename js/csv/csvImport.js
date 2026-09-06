/**
 * Comma and semicolon can't both be treated as delimiters at once — a file
 * that uses ";" as the column separator may legitimately contain "," inside
 * a translation (e.g. a list of synonyms), and vice versa. So the delimiter
 * is detected once per file rather than accepting either character
 * everywhere. Picking whichever character is simply more frequent overall
 * breaks down when many rows carry comma-separated synonym lists — those
 * in-field commas can easily outnumber the one semicolon per row that's
 * actually acting as the column separator. Instead, the true delimiter is
 * the one whose per-row count is most *consistent* (e.g. exactly 1 per row
 * for a 2-column file) — synonym commas vary row to row (0, 2, 3, ...) and
 * so don't agree on a single count the way a real column separator does.
 */
function detectDelimiter(lines) {
  const candidates = [';', ','];
  let best = candidates[0];
  let bestScore = -1;
  for (const delimiter of candidates) {
    const countsPerLine = new Map();
    for (const line of lines) {
      let count = 0;
      for (const ch of line) {
        if (ch === delimiter) count += 1;
      }
      if (count === 0) continue;
      countsPerLine.set(count, (countsPerLine.get(count) || 0) + 1);
    }
    let score = 0;
    for (const linesWithThisCount of countsPerLine.values()) {
      score = Math.max(score, linesWithThisCount);
    }
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }
  return best;
}

function parseLine(line, delimiter) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields.map((f) => f.trim());
}

/**
 * Parses CSV/semicolon-separated text with columns: en, de, category?, example?
 * A header row (first cell literally "en") is detected and skipped.
 */
export function parseCsv(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return [];

  const delimiter = detectDelimiter(lines);

  let start = 0;
  const first = parseLine(lines[0], delimiter).map((c) => c.toLowerCase());
  if (first[0] === 'en' || first[0] === 'english' || first[0] === 'englisch') {
    start = 1;
  }

  const entries = [];
  for (let i = start; i < lines.length; i++) {
    const cols = parseLine(lines[i], delimiter);
    if (!cols[0] || !cols[1]) continue;
    entries.push({
      en: cols[0],
      de: cols[1],
      category: cols[2] || '',
      example: cols[3] || ''
    });
  }
  return entries;
}

/** Serializes vocab entries back to comma-separated CSV text (with a header row) for export/backup. */
export function toCsv(list) {
  const escapeField = (value) => {
    const str = String(value ?? '');
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const lines = ['en,de,category,example'];
  for (const v of list) {
    lines.push([v.en, v.de, v.category, v.example].map(escapeField).join(','));
  }
  return lines.join('\r\n');
}
