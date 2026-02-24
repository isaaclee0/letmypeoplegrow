import React, { useState, useEffect } from 'react';
import { ChevronDownIcon, ChevronUpIcon } from '@heroicons/react/24/outline';
import { getChildBadgeStyles } from '../../utils/colorUtils';
import BadgeIcon, { BADGE_ICON_OPTIONS, BadgeIconType } from '../icons/BadgeIcon';

interface BadgeData {
  badgeText: string;
  badgeColor: string;
  badgeIcon: string;
}

interface BadgeEditorProps {
  badgeData: BadgeData;
  onBadgeChange: (updates: Partial<BadgeData>) => void;
  isChild: boolean;
}

const BadgeEditor: React.FC<BadgeEditorProps> = ({
  badgeData,
  onBadgeChange,
  isChild
}) => {
  const hasExistingBadge = badgeData.badgeText || badgeData.badgeIcon;

  // Badge section is expanded by default for children or people with existing badges
  const [isExpanded, setIsExpanded] = useState(() => isChild || hasExistingBadge);

  const handleReset = () => {
    onBadgeChange({ badgeText: '', badgeColor: '', badgeIcon: '' });
  };

  return (
    <div className="border-t border-gray-200 pt-4">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between mb-3 hover:bg-gray-50 rounded p-2 -m-2 transition-colors"
      >
        <div className="flex items-center space-x-2">
          <h4 className="text-sm font-medium text-gray-900">
            Badge Settings {!isChild && '(Optional)'}
          </h4>
          {(badgeData.badgeText || badgeData.badgeIcon) && !isExpanded && (
            <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded">
              Custom badge set
            </span>
          )}
        </div>
        {isExpanded ? (
          <ChevronUpIcon className="h-5 w-5 text-gray-400" />
        ) : (
          <ChevronDownIcon className="h-5 w-5 text-gray-400" />
        )}
      </button>

      {isExpanded && (
        <>
          <div className="flex items-center justify-end mb-3">
            <button
              type="button"
              onClick={handleReset}
              className="text-sm text-primary-600 hover:text-primary-700 font-medium"
            >
              Reset to Default
            </button>
          </div>
          <div className="space-y-3">
            {/* Badge Text */}
            <div>
              <label className="block text-sm font-medium text-gray-700">Badge Text</label>
              <div className="mt-1">
                <input
                  type="text"
                  value={badgeData.badgeText}
                  onChange={(e) => onBadgeChange({ badgeText: e.target.value })}
                  className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                  placeholder={isChild ? "Leave empty for default" : "e.g., Leader, Volunteer, Teen"}
                  maxLength={50}
                />
              </div>
              <div className="text-xs text-gray-500 mt-1">
                Leave empty to use church default settings
              </div>
            </div>

            {/* Badge Icon */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Badge Icon</label>
              <div className="grid grid-cols-4 gap-2">
                <button
                  type="button"
                  onClick={() => onBadgeChange({ badgeIcon: '' })}
                  className={`flex flex-col items-center justify-center p-3 rounded-md border-2 transition-all ${
                    badgeData.badgeIcon === ''
                      ? 'border-primary-500 bg-primary-50'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                  title="Default"
                >
                  <span className="text-xs font-medium text-gray-600">Default</span>
                </button>
                {BADGE_ICON_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => onBadgeChange({ badgeIcon: option.value })}
                    className={`flex flex-col items-center justify-center p-3 rounded-md border-2 transition-all ${
                      badgeData.badgeIcon === option.value
                        ? 'border-primary-500 bg-primary-50'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                    title={option.label}
                  >
                    <BadgeIcon type={option.value as BadgeIconType} className="w-5 h-5 text-gray-700" />
                    <span className="text-xs mt-1 text-gray-600">{option.label}</span>
                  </button>
                ))}
              </div>
              <div className="text-xs text-gray-500 mt-1">
                Select "Default" to use church default icon
              </div>
            </div>

            {/* Badge Color */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Badge Color</label>
              <div className="flex items-center space-x-3">
                <input
                  type="color"
                  value={badgeData.badgeColor || '#c5aefb'}
                  onChange={(e) => onBadgeChange({ badgeColor: e.target.value })}
                  className="h-10 w-20 rounded border border-gray-300 cursor-pointer"
                />
                <input
                  type="text"
                  value={badgeData.badgeColor || ''}
                  onChange={(e) => onBadgeChange({ badgeColor: e.target.value })}
                  className="block w-32 rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm uppercase font-mono"
                  placeholder="Default"
                  maxLength={7}
                />
              </div>
              <div className="text-xs text-gray-500 mt-1">
                Leave empty to use church default color
              </div>
            </div>

            {/* Preview */}
            {(badgeData.badgeIcon || badgeData.badgeText) && (
              <div className="flex items-center space-x-2">
                <span className="text-xs text-gray-500">Preview:</span>
                <span
                  className={`flex items-center space-x-1 shadow-sm ${
                    badgeData.badgeText ? 'px-2 py-1 rounded-full' : 'w-8 h-8 justify-center rounded-full'
                  }`}
                  style={getChildBadgeStyles(badgeData.badgeColor || '#c5aefb')}
                >
                  {badgeData.badgeIcon && (
                    <BadgeIcon type={badgeData.badgeIcon as BadgeIconType} className="w-5 h-5" />
                  )}
                  {badgeData.badgeText && (
                    <span className="text-xs font-medium whitespace-nowrap">
                      {badgeData.badgeText}
                    </span>
                  )}
                </span>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default BadgeEditor;
