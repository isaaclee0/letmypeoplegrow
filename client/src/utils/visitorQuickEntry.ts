export interface VisitorName {
  firstName: string;
  lastName: string;
  isChild: boolean;
}

export const MAX_VISITORS = 10;

interface EntryPreview {
  people: VisitorName[];
  familySurname?: string;
  issue?: string;
}

const numberWords = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const roleWords = 'adults?|parents?|child(?:ren)?|kids?|bab(?:y|ies)|sons?|daughters?';
const groupStart = new RegExp('^(?:(?:their|his|her|our|the)\\s+)?(?:(\\d+|' + numberWords.join('|') + '|a|an)\\s+)?(' + roleWords + ')\\b[\\s:(-]*(.*)$', 'i');
const adjacentCount = new RegExp('\\b(' + roleWords + ')\\s+(?=(?:\\d+|' + numberWords.join('|') + ')\\s+(?:' + roleWords + ')\\b)', 'gi');
const tooMany = 'Add up to 10 people at a time.';

function formatName(value: string) {
  return value.split(/(\s+|[-'’])/).map(part =>
    part === part.toLocaleLowerCase() ? part.charAt(0).toLocaleUpperCase() + part.slice(1) : part
  ).join('');
}

export function countedVisitors(adults: number, children: number, lastName: string): VisitorName[] {
  return [adults, children].flatMap((count, role) => Array.from({ length: count }, (_, index) => ({
    firstName: (role ? 'Child ' : 'Adult ') + (index + 1), lastName, isChild: role === 1,
  })));
}

export function parseVisitorEntry(input: string): EntryPreview {
  const family = input.trim().match(/^(?:the\s+)?([\p{L}][\p{L}\p{M}'’ -]*?)\s+family\b/iu);
  const familySurname = family ? formatName(family[1].trim()) : '';
  const description = family ? input.trim().slice(family[0].length).replace(/^[\s,:-]+/, '') : input;
  if (family && !description) return { people: [], familySurname };

  const people: VisitorName[] = [];
  let namedGroup: VisitorName[] = [];
  let isChild = false;
  let count = 0;
  const unknownCounts = [0, 0];
  function finishGroup() {
    // A surname applies backwards only to consecutive unnamed surnames in this group.
    let sharedSurname = '';
    for (let i = namedGroup.length - 1; i >= 0; i--) {
      const person = namedGroup[i];
      if (person.lastName) sharedSurname = person.lastName;
      else person.lastName = sharedSurname;
    }
    people.push(...namedGroup);
    for (let i = namedGroup.length; i < count; i++) {
      const number = ++unknownCounts[Number(isChild)];
      people.push({ firstName: (isChild ? 'Child ' : 'Adult ') + number, lastName: '', isChild });
    }
    namedGroup = [];
    count = 0;
  }

  const tokens = description
    .replace(adjacentCount, '$1, ')
    .replace(/\((child|kid|baby|adult)\)/gi, ':$1')
    .replace(/[()]/g, ',')
    .split(/[,;+&\n]|\b(?:and|with|plus)\b/i)
    .map(token => token.trim()).filter(Boolean);
  for (let token of tokens) {
    const postfix = token.match(/^(.+?):(child|kid|baby|adult)$/i);
    const personIsChild = postfix ? postfix[2].toLowerCase() !== 'adult' : isChild;
    const hasOwnRole = Boolean(postfix && personIsChild !== isChild);
    if (hasOwnRole) finishGroup();
    if (postfix) token = postfix[1].trim();
    const group = !postfix && token.match(groupStart);
    if (group) {
      finishGroup();
      isChild = !/^(adult|parent)/i.test(group[2]);
      const quantity = (group[1] || 'one').toLowerCase();
      count = quantity === 'a' || quantity === 'an' ? 1 : /^\d+$/.test(quantity) ? Number(quantity) : numberWords.indexOf(quantity);
      if (people.length + count > MAX_VISITORS) return { people: [], issue: tooMany };
      token = group[3].trim().replace(/^(?:named|called)\s+/i, '');
      if (!token || /^[.!?]+$/.test(token)) continue;
    }
    if (!/^[\p{L}][\p{L}\p{M}.'’ -]*$/u.test(token)) {
      return { people: [], issue: 'Use names or a count such as “2 kids”, or enter people individually.' };
    }
    const [first, ...surname] = token.split(/\s+/);
    namedGroup.push({ firstName: formatName(first), lastName: formatName(surname.join(' ')), isChild: postfix ? personIsChild : isChild });
    if (people.length + namedGroup.length > MAX_VISITORS) return { people: [], issue: tooMany };
    if (hasOwnRole) finishGroup();
  }
  finishGroup();
  if (familySurname) people.forEach(person => { person.lastName ||= familySurname; });
  return { people };
}
