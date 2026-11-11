/** Parse the tabular format shared by the preview and both people import endpoints. */
export function parsePeopleTable(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, '').trim();
  if (!text) return [];
  const firstLine = text.split(/\r?\n/, 1)[0];
  let delimiter = ',';
  let quoted = false;
  const separators = new Set<string>();
  for (let i = 0; i < firstLine.length; i++) {
    const char = firstLine[i];
    if (char === '"') {
      if (quoted && firstLine[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (!quoted && ['\t', ';', ','].includes(char)) separators.add(char);
  }
  if (separators.has('\t')) delimiter = '\t';
  else if (separators.has(';')) delimiter = ';';

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else if (quoted || !cell.trim()) quoted = !quoted;
      else cell += char;
    } else if (char === '\n' || char === '\r') {
      if (quoted) throw new Error('Remove line breaks inside spreadsheet cells before importing.');
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = []; cell = '';
    } else if (char === delimiter && !quoted) { row.push(cell.trim()); cell = ''; }
    else cell += char;
  }
  if (quoted) throw new Error('A spreadsheet cell has an unfinished quote. Check the file and try again.');
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

export function normalizePeopleTable(input: string): string {
  return parsePeopleTable(input).map(row => row.map(cell =>
    /["\t]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell
  ).join('\t')).join('\n');
}
