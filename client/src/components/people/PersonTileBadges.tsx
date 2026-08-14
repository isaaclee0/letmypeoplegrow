import React from 'react';
import BadgeIcon, { type BadgeIconType } from '../icons/BadgeIcon';
import MedicalNoteIndicator from '../icons/MedicalNoteIndicator';

interface BadgeInfo {
  text: string | null;
  icon: string;
  styles: {
    backgroundColor: string;
    color: string;
  };
}

interface PersonTileBadgesProps {
  displayName: string;
  badgeInfo?: BadgeInfo | null;
  hasMedicalNotes?: boolean;
  medicalNotesIndicator?: { icon: BadgeIconType; color: string } | null;
}

const PersonTileBadges: React.FC<PersonTileBadgesProps> = ({
  displayName,
  badgeInfo = null,
  hasMedicalNotes = false,
  medicalNotesIndicator = null,
}) => {
  if (!badgeInfo && !(hasMedicalNotes && medicalNotesIndicator)) return null;

  return (
    <div
      role="group"
      aria-label={`Badges for ${displayName}`}
      className="ml-auto flex shrink-0 items-center gap-1 sm:absolute sm:right-3 sm:top-0 sm:-translate-y-1/2"
    >
      {badgeInfo && (
        <span
          className={`flex shrink-0 items-center space-x-1 shadow-sm ${
            badgeInfo.text ? 'rounded-full px-2 py-1' : 'h-6 w-6 justify-center rounded-full'
          }`}
          style={badgeInfo.styles}
        >
          {badgeInfo.icon && (
            <BadgeIcon type={badgeInfo.icon as BadgeIconType} className="h-4 w-4 shrink-0" />
          )}
          {badgeInfo.text && (
            <span className="whitespace-nowrap text-xs font-medium">{badgeInfo.text}</span>
          )}
        </span>
      )}
      {hasMedicalNotes && medicalNotesIndicator && (
        <MedicalNoteIndicator icon={medicalNotesIndicator.icon} color={medicalNotesIndicator.color} />
      )}
    </div>
  );
};

export default PersonTileBadges;
