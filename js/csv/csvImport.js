/**
 * Comma and semicolon can't both be treated as delimiters at once — a file
 * that uses ";" as the column separator may legitimately contain "," inside
 * a translation (e.g. a list of synonyms), and vice versa. So the delimiter
 * is detected once per file (whichever character is more frequent overall)
 * rather than accepting either character everywhere.
 */
function detectDelimiter(lines) {
  let commaCount = 0;
  let semicolonCount = 0;
  for (const line of lines) {
    for (const ch of line) {
      if (ch === ',') commaCount += 1;
      else if (ch === ';') semicolonCount += 1;
    }
  }
  return semicolonCount > commaCount ? ';' : ',';
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
