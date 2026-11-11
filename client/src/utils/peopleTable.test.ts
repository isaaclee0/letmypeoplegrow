import { describe, expect, it } from 'vitest';
import { normalizePeopleTable, parsePeopleTable } from './peopleTable';

describe('people spreadsheet input', () => {
  it('keeps quoted commas in names and gathering lists when converting CSV for import', () => {
    const csv = 'FIRST NAME,LAST NAME,FAMILY NAME,GATHERINGS,ADULT/CHILD\r\nJane,Smith,"Smith, Jane","Sunday, Youth",Adult';
    expect(normalizePeopleTable(csv)).toBe('FIRST NAME\tLAST NAME\tFAMILY NAME\tGATHERINGS\tADULT/CHILD\nJane\tSmith\tSmith, Jane\tSunday, Youth\tAdult');
    expect(parsePeopleTable(csv)[1]).toEqual(['Jane', 'Smith', 'Smith, Jane', 'Sunday, Youth', 'Adult']);
  });
  it('preserves spreadsheet tabs and escaped quotes', () => {
    expect(parsePeopleTable('Jane\t"O""Neil"\tJane O\tSunday\tAdult')[0]).toEqual(['Jane', 'O"Neil', 'Jane O', 'Sunday', 'Adult']);
  });
  it('rejects multiline cells that the existing import endpoints cannot read safely', () => {
    expect(() => normalizePeopleTable('Jane,Smith,"two\nlines",Sunday')).toThrow(/line breaks/i);
  });
  it('rejects incomplete quoted cells rather than silently shifting columns', () => {
    expect(() => normalizePeopleTable('Jane,Smith,"unfinished,Sunday')).toThrow(/quote/i);
  });
});
