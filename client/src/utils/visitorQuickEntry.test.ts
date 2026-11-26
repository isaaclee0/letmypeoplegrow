import { describe, expect, it } from 'vitest';
import { parseVisitorEntry } from './visitorQuickEntry';

describe('visitor quick entry', () => {
  it.each([
    ['john and judy, 2 children', ['John||adult', 'Judy||adult', 'Child 1||child', 'Child 2||child']],
    ['John and Judy Smith with their two children', ['John|Smith|adult', 'Judy|Smith|adult', 'Child 1||child', 'Child 2||child']],
    ['Lucy (child), John Smith', ['Lucy||child', 'John|Smith|adult']],
    ['John and Judy, 2 kids.', ['John||adult', 'Judy||adult', 'Child 1||child', 'Child 2||child']],
    ['John and Judy and Sam Smith', ['John|Smith|adult', 'Judy|Smith|adult', 'Sam|Smith|adult']],
    ['John Smith + Judy', ['John|Smith|adult', 'Judy||adult']],
    ['John Brown & Judy Smith', ['John|Brown|adult', 'Judy|Smith|adult']],
    ['John and Judy with two children, Lucy and Max', ['John||adult', 'Judy||adult', 'Lucy||child', 'Max||child']],
    ['John Smith + Judy Brown, baby Mia', ['John|Smith|adult', 'Judy|Brown|adult', 'Mia||child']],
    ['John with zero children', ['John||adult']],
    ['John & Judy with two kids named Lucy and Max', ['John||adult', 'Judy||adult', 'Lucy||child', 'Max||child']],
    ['the Smith family: 2 adults 1 child', ['Adult 1|Smith|adult', 'Adult 2|Smith|adult', 'Child 1|Smith|child']],
    ['John Smith (adult), Lucy (child)', ['John|Smith|adult', 'Lucy||child']],
    ['2 adults, 3 kids', ['Adult 1||adult', 'Adult 2||adult', 'Child 1||child', 'Child 2||child', 'Child 3||child']],
    ["anne-marie o’neill\nMcKenzie", ['Anne-Marie|O’Neill|adult', 'McKenzie||adult']],
    ['John and Judy Smith, kids: Lucy and Max', ['John|Smith|adult', 'Judy|Smith|adult', 'Lucy||child', 'Max||child']],
  ] as [string, string[]][])('interprets %s', (input, expected) => {
    const result = parseVisitorEntry(input);
    expect(result.issue).toBeUndefined();
    expect(result.people.map(p => [p.firstName, p.lastName, p.isChild ? 'child' : 'adult'].join('|'))).toEqual(expected);
  });

  it('asks for counts when only a family name is known', () => {
    expect(parseVisitorEntry('the smith family')).toMatchObject({ familySurname: 'Smith', people: [] });
  });

  it('reports an oversized group without silently truncating it', () => {
    expect(parseVisitorEntry('John and 10000 children').issue).toBeTruthy();
  });

  it('does not accept punctuation as a name', () => {
    expect(parseVisitorEntry('John and ...').issue).toBeTruthy();
  });
});
