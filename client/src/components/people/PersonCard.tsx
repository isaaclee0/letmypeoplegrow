import React from 'react';
import BadgeIcon, { BadgeIconType } from '../icons/BadgeIcon';

interface Person {
  id: number;
  firstName: string;
  lastName: string;
  peopleType: 'regular' | 'local_visitor' | 'traveller_visitor';
  isChild?: boolean;
  badgeText?: string | null;
  badgeColor?: string | null;
  badgeIcon?: string | null;
  familyId?: number;
  familyName?: string;
  gatheringAssignments?: Array<{
    id: number;
    name: string;
  }>;
  createdAt?: string;
}

interface BadgeInfo {
  text: string | null;
  icon: string;
  styles: {
    backgroundColor: string;
    color: string;
  };
}

interface PersonCardProps {
  person: Person;
  isSelected: boolean;
  onToggleSelection: (personId: number) => void;
  displayName: string;
  needsWideLayout: boolean;
  getGatheringColor: (gatheringId: number) => string;
  getStandardGatheringAssignments: (assignments?: Array<{ id: number; name: string }>) => Array<{ id: number; name: string }>;
  getBadgeInfo: (person: { isChild?: boolean; badgeText?: string | null; badgeColor?: string | null; badgeIcon?: string | null }) => BadgeInfo | null;
  variant?: 'grouped' | 'individual'; // grouped has more spacing, individual is compact
}

const PersonCard: React.FC<PersonCardProps> = ({
  person,
  isSelected,
  onToggleSelection,
  displayName,
  needsWideLayout,
  getGatheringColor,
  getStandardGatheringAssignments,
  getBadgeInfo,
  variant = 'grouped'
}) => {
  const standardGatherings = getStandardGatheringAssignments(person.gatheringAssignments);
  const isGrouped = variant === 'grouped';
  const badgeInfo = getBadgeInfo(person);

  return (
    <div
      key={person.id}
      className={`relative flex items-center ${isGrouped ? 'justify-between p-3' : 'space-x-3 p-2'} rounded-md ${
        isGrouped ? 'border-2' : 'border'
      } cursor-pointer transition-colors ${
        isSelected
          ? 'border-primary-500 bg-primary-50'
          : isGrouped ? 'border-gray-200 hover:border-gray-300' : 'border-gray-200 hover:bg-gray-50'
      } ${needsWideLayout ? 'col-span-2' : ''}`}
      onClick={() => onToggleSelection(person.id)}
    >
      <div className={`flex items-center space-x-3 ${isGrouped ? 'flex-1 min-w-0' : ''}`}>
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => onToggleSelection(person.id)}
          className="rounded border-gray-300 text-primary-600 focus:ring-primary-500 flex-shrink-0"
          onClick={(e) => e.stopPropagation()}
        />
        <div className={isGrouped ? 'flex-1 min-w-0' : 'flex-1 min-w-0'}>
          <div className="flex items-center space-x-2 min-w-0">
            <span className="text-sm font-medium text-gray-900 truncate">
              {displayName}
            </span>
            <div className="flex items-center space-x-1 flex-shrink-0">
              {standardGatherings.map(gathering => (
                <div
                  key={gathering.id}
                  className={`w-2 h-2 rounded-full ${getGatheringColor(gathering.id)}`}
                  title={gathering.name}
                ></div>
              ))}
            </div>
          </div>
          {isGrouped && (
            <div className="text-xs text-gray-500 mt-0.5">
              {person.peopleType === 'local_visitor' ? 'Local Visitor' : person.peopleType === 'traveller_visitor' ? 'Traveller Visitor' : ''}
            </div>
          )}
        </div>
      </div>

      {/* Badge: inline right-aligned on mobile, floating top-right on sm+ */}
      {badgeInfo && (
        <span
          className={`flex-shrink-0 ml-auto sm:absolute sm:right-3 sm:top-0 sm:-translate-y-1/2 flex items-center space-x-1 shadow-sm ${
            badgeInfo.text ? 'px-2 py-1 rounded-full' : 'w-6 h-6 justify-center rounded-full'
          }`}
          style={badgeInfo.styles}
        >
          {badgeInfo.icon && (
            <BadgeIcon type={badgeInfo.icon as BadgeIconType} className="w-4 h-4 flex-shrink-0" />
          )}
          {badgeInfo.text && (
            <span className="text-xs font-medium whitespace-nowrap">{badgeInfo.text}</span>
          )}
        </span>
      )}
    </div>
  );
};

export default PersonCard;
