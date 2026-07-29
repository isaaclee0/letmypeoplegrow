export type SourceFreshnessBand = 'green' | 'orange' | 'red' | 'unknown';

export interface SourceFreshness {
  band: SourceFreshnessBand;
  className: string;
  text: string;
  title: string;
}

const CLASS_NAMES: Record<SourceFreshnessBand, string> = {
  green: 'text-green-700 dark:text-green-300',
  orange: 'text-orange-700 dark:text-orange-300',
  red: 'text-red-700 dark:text-red-300',
  unknown: 'text-gray-600 dark:text-gray-400',
};

const DAY_MS = 24 * 60 * 60 * 1000;

function relativeAge(milliseconds: number): string {
  const wholeDays = Math.floor(Math.max(0, milliseconds) / DAY_MS);
  if (wholeDays === 0) return 'Updated today';
  return `Updated ${wholeDays} day${wholeDays === 1 ? '' : 's'} ago`;
}

export function sourceFreshness(providerRefreshedAt: string | null, now = new Date()): SourceFreshness {
  const refreshedAt = providerRefreshedAt === null ? Number.NaN : new Date(providerRefreshedAt).getTime();
  if (!Number.isFinite(refreshedAt) || !Number.isFinite(now.getTime())) {
    return { band: 'unknown', className: CLASS_NAMES.unknown, text: 'Refresh time unavailable', title: 'Refresh time unavailable' };
  }

  const age = Math.max(0, now.getTime() - refreshedAt);
  const band: SourceFreshnessBand = age <= DAY_MS * 7 ? 'green' : age <= DAY_MS * 30 ? 'orange' : 'red';
  const localized = new Date(refreshedAt).toLocaleString();
  return {
    band,
    className: CLASS_NAMES[band],
    text: relativeAge(age),
    title: `Planning Center last refreshed ${localized}`,
  };
}
