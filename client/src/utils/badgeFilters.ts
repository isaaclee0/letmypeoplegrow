import type { BadgeIconType } from '../components/icons/BadgeIcon';
import { getChildBadgeStyles } from './colorUtils';

export interface BadgeFilterOption {
  key: string;
  text: string | null;
  icon: string;
  backgroundColor: string;
  color: string;
  helperText: string;
}

export interface MedicalBadgeAppearance {
  icon: BadgeIconType;
  color: string;
}

export function createBadgeFilterKey(
  badge: Pick<BadgeFilterOption, 'text' | 'icon' | 'backgroundColor'>,
): string {
  return JSON.stringify([
    badge.icon,
    badge.backgroundColor.toLowerCase(),
    badge.text || '',
  ]);
}

export function createMedicalBadgeFilterOption(
  appearance: MedicalBadgeAppearance | null,
): BadgeFilterOption | null {
  if (!appearance) return null;

  const styles = getChildBadgeStyles(appearance.color);
  const option: BadgeFilterOption = {
    key: JSON.stringify(['medical', appearance.icon, appearance.color.toLowerCase()]),
    text: null,
    icon: appearance.icon,
    backgroundColor: styles.backgroundColor,
    color: styles.color,
    helperText: 'Medical note recorded',
  };
  return option;
}

export function getApplicableBadgeFilterKeys(
  ordinaryKey: string | null,
  hasMedicalNotes: boolean,
  medicalKey: string | null,
): string[] {
  return [ordinaryKey, hasMedicalNotes ? medicalKey : null]
    .filter((key): key is string => Boolean(key));
}

export function matchesSelectedBadgeKeys(
  selected: ReadonlySet<string>,
  applicable: readonly string[],
): boolean {
  return selected.size === 0 || applicable.some((key) => selected.has(key));
}
