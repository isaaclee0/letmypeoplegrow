import React from 'react';
import BadgeIcon, { BADGE_ICON_OPTIONS, type BadgeIconType } from './BadgeIcon';
import { getChildBadgeStyles } from '../../utils/colorUtils';

interface Props {
  icon: BadgeIconType;
  color: string;
  className?: string;
}

const validIcons = new Set(BADGE_ICON_OPTIONS.map(({ value }) => value));

const MedicalNoteIndicator: React.FC<Props> = ({ icon, color, className = '' }) => {
  if (!validIcons.has(icon) || !/^#[0-9a-fA-F]{6}$/.test(color)) return null;
  return (
    <span
      aria-label="Medical note recorded"
      title="Medical note recorded"
      onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
      style={getChildBadgeStyles(color)}
      className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${className}`}
    >
      <BadgeIcon type={icon} className="h-4 w-4" />
    </span>
  );
};

export default MedicalNoteIndicator;
