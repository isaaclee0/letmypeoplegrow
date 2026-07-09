// Formats a day-of-month integer (1-31) as an ordinal string, e.g. "1st",
// "22nd", "31st". Used by the PCO monthly schedule day-of-month pickers.
export function ordinalDay(day: number): string {
  const rem100 = day % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${day}th`;
  switch (day % 10) {
    case 1: return `${day}st`;
    case 2: return `${day}nd`;
    case 3: return `${day}rd`;
    default: return `${day}th`;
  }
}
