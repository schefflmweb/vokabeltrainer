function parseLine(line) {
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
    } else if (ch === ',' || ch === ';') {
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

  let start = 0;
  const first = parseLine(lines[0]).map((c) => c.toLowerCase());
  if (first[0] === 'en' || first[0] === 'english' || first[0] === 'englisch') {
    start = 1;
  }

  const entries = [];
  for (let i = start; i < lines.length; i++) {
    const cols = parseLine(lines[i]);
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
