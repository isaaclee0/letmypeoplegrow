import React from 'react';

interface Person {
  id: number;
  firstName: string;
  lastName: string;
  peopleType: 'regular' | 'local_visitor' | 'traveller_visitor';
  familyId?: number;
  familyName?: string;
  gatheringAssignments?: Array<{
    id: number;
    name: string;
  }>;
  createdAt?: string;
}

interface PersonCardProps {
  person: Person;
  isSelected: boolean;
  onToggleSelection: (personId: number) => void;
  displayName: string;
  needsWideLayout: boolean;
  getGatheringColor: (gatheringId: number) => string;
  getStandardGatheringAssignments: (assignments?: Array<{ id: number; name: string }>) => Array<{ id: number; name: string }>;
  AttendanceInfoButton?: React.ComponentType<{ personId: number; createdAt?: string }>;
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
  AttendanceInfoButton,
  variant = 'grouped'
}) => {
  const standardGatherings = getStandardGatheringAssignments(person.gatheringAssignments);
  const isGrouped = variant === 'grouped';

  return (
    <div
      key={person.id}
      className={`flex items-center ${isGrouped ? 'justify-between p-3' : 'space-x-3 p-2'} rounded-md ${
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
        <div className={isGrouped ? 'flex-1 min-w-0' : 'flex items-center space-x-2'}>
          {isGrouped ? (
            <>
              <div className="flex items-center space-x-2">
                <span className="text-sm font-medium text-gray-900 truncate">
                  {displayName}
                </span>
                {AttendanceInfoButton && (
                  <AttendanceInfoButton personId={person.id} createdAt={person.createdAt} />
                )}
              </div>
              <div className="text-xs text-gray-500">
                {person.peopleType === 'local_visitor' ? 'Local Visitor' : person.peopleType === 'traveller_visitor' ? 'Traveller Visitor' : ''}
              </div>
              {standardGatherings.length > 0 && (
                <div className="flex items-center space-x-1 mt-1">
                  {standardGatherings.map(gathering => (
                    <div
                      key={gathering.id}
                      className={`w-2 h-2 rounded-full ${getGatheringColor(gathering.id)}`}
                      title={gathering.name}
                    ></div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <span className="text-sm font-medium text-gray-900">{displayName}</span>
              {standardGatherings.length > 0 && (
                <div className="flex items-center space-x-1">
                  {standardGatherings.map(gathering => (
                    <div
                      key={gathering.id}
                      className={`w-2 h-2 rounded-full ${getGatheringColor(gathering.id)}`}
                      title={gathering.name}
                    ></div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default PersonCard;
