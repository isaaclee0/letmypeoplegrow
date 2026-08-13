import { formatInstant } from '../../utils/churchTime';

export interface CheckInHistoryDetail {
  date: string;
  individuals: Array<{
    individualId: number;
    firstName: string;
    lastName: string;
    familyName: string | null;
    checkins: Array<{ time: string; signerName: string | null; userName?: string | null }>;
    checkouts: Array<{ time: string; signerName: string | null; userName?: string | null }>;
  }>;
}

const timeOptions: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };

export function buildCheckInHistoryTsv(detail: CheckInHistoryDetail, timeZone: string): string {
  const lines = [['Name', 'Family', 'Check-in Time', 'Checked In By', 'User', 'Check-out Time', 'Checked Out By', 'User'].join('\t')];

  for (const person of detail.individuals) {
    const checkin = person.checkins[0];
    const checkout = person.checkouts[0];
    lines.push([
      `${person.firstName} ${person.lastName}`,
      person.familyName || '',
      checkin ? formatInstant(checkin.time, timeZone, timeOptions) : '',
      checkin?.signerName || '',
      checkin?.userName || '',
      checkout ? formatInstant(checkout.time, timeZone, timeOptions) : '',
      checkout?.signerName || '',
      checkout?.userName || '',
    ].join('\t'));
  }

  return lines.join('\n');
}
