import React, { useState, useMemo } from 'react';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, getDay, addMonths, subMonths, isSameMonth, isSameDay, isToday, addDays, startOfWeek } from 'date-fns';
import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/24/outline';

interface AttendanceDatePickerProps {
  selectedDate: string;
  onDateChange: (date: string) => void;
  validDates: string[];
  gatheringName?: string;
}

const AttendanceDatePicker: React.FC<AttendanceDatePickerProps> = ({
  selectedDate,
  onDateChange,
  validDates,
  gatheringName
}) => {
  const [currentMonth, setCurrentMonth] = useState(() => {
    return selectedDate ? new Date(selectedDate) : new Date();
  });

  const validDateSet = useMemo(() => new Set(validDates), [validDates]);

  const monthStart = startOfMonth(currentMonth);
  const monthEnd = endOfMonth(currentMonth);
  
  // Only show days that belong to the current month
  const days = eachDayOfInterval({ start: monthStart, end: monthEnd });

  const selectedDateObj = selectedDate ? new Date(selectedDate) : null;

  const handleDateClick = (date: Date) => {
    const dateStr = format(date, 'yyyy-MM-dd');
    if (validDateSet.has(dateStr)) {
      onDateChange(dateStr);
    }
  };

  const navigateMonth = (direction: 'prev' | 'next') => {
    setCurrentMonth(prev => direction === 'prev' ? subMonths(prev, 1) : addMonths(prev, 1));
  };

  const goToToday = () => {
    const today = new Date();
    setCurrentMonth(today);
    
    // Find the closest valid date to today
    const todayStr = format(today, 'yyyy-MM-dd');
    if (validDateSet.has(todayStr)) {
      onDateChange(todayStr);
    } else {
      // Find the closest valid date
      const sortedValidDates = validDates.sort();
      const closestDate = sortedValidDates.find(date => date >= todayStr) || 
                         sortedValidDates[sortedValidDates.length - 1];
      if (closestDate) {
        onDateChange(closestDate);
      }
    }
  };

  return (
    <div className="bg-white border border-gray-300 rounded-lg shadow-lg p-4 w-80">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={() => navigateMonth('prev')}
          className="p-1 hover:bg-gray-100 rounded"
          type="button"
        >
          <ChevronLeftIcon className="w-5 h-5 text-gray-600" />
        </button>
        
        <div className="text-center">
          <h3 className="text-lg font-semibold text-gray-900">
            {format(currentMonth, 'MMMM yyyy')}
          </h3>
          {gatheringName && (
            <p className="text-sm text-gray-600">{gatheringName}</p>
          )}
        </div>
        
        <button
          onClick={() => navigateMonth('next')}
          className="p-1 hover:bg-gray-100 rounded"
          type="button"
        >
          <ChevronRightIcon className="w-5 h-5 text-gray-600" />
        </button>
      </div>

      {/* Quick Actions */}
      <div className="flex justify-center mb-4">
        <button
          onClick={goToToday}
          className="px-3 py-1 text-sm bg-blue-50 text-blue-700 hover:bg-blue-100 rounded-md transition-colors"
          type="button"
        >
          Go to Today
        </button>
      </div>

      {/* Day Labels */}
      <div className="grid grid-cols-7 gap-1 mb-2">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
          <div key={day} className="text-center text-sm font-medium text-gray-500 py-2">
            {day}
          </div>
        ))}
      </div>

      {/* Calendar Grid */}
      <div className="grid grid-cols-7 gap-1">
        {/* Add empty cells for proper week alignment */}
        {Array.from({ length: monthStart.getDay() }, (_, index) => (
          <div key={`empty-${index}`} className="h-10 w-10"></div>
        ))}
        
        {days.map((day, index) => {
          const dateStr = format(day, 'yyyy-MM-dd');
          const isValid = validDateSet.has(dateStr);
          const isSelected = selectedDateObj && isSameDay(day, selectedDateObj);
          const isTodayDate = isToday(day);

          return (
            <button
              key={index}
              onClick={() => handleDateClick(day)}
              disabled={!isValid}
              type="button"
              className={`
                h-10 w-10 text-sm rounded-lg transition-all duration-200 relative
                ${isSelected 
                  ? 'bg-blue-600 text-white font-semibold ring-2 ring-blue-300' 
                  : ''
                }
                ${isValid && !isSelected 
                  ? 'bg-green-50 text-green-800 hover:bg-green-100 border border-green-200 font-medium' 
                  : ''
                }
                ${!isValid 
                  ? 'text-gray-300 cursor-not-allowed' 
                  : ''
                }
                ${isTodayDate && !isSelected 
                  ? 'ring-2 ring-blue-200' 
                  : ''
                }
              `}
            >
              {format(day, 'd')}
              {isTodayDate && (
                <div className="absolute bottom-0 left-1/2 transform -translate-x-1/2 w-1 h-1 bg-blue-600 rounded-full"></div>
              )}
            </button>
          );
        })}
      </div>

      {/* Legend */}
      <div className="mt-4 pt-3 border-t border-gray-200">
        <div className="flex items-center justify-center space-x-4 text-xs">
          <div className="flex items-center space-x-1">
            <div className="w-3 h-3 bg-green-50 border border-green-200 rounded"></div>
            <span className="text-gray-600">Meeting dates</span>
          </div>
          <div className="flex items-center space-x-1">
            <div className="w-3 h-3 bg-blue-600 rounded"></div>
            <span className="text-gray-600">Selected</span>
          </div>
          <div className="flex items-center space-x-1">
            <div className="w-3 h-3 border-2 border-blue-200 rounded"></div>
            <span className="text-gray-600">Today</span>
          </div>
        </div>
      </div>

      {/* Selected Date Display */}
      {selectedDate && (
        <div className="mt-3 pt-3 border-t border-gray-200 text-center">
          <p className="text-sm text-gray-600">Selected Date:</p>
          <p className="font-semibold text-gray-900">
            {format(new Date(selectedDate), 'EEEE, MMMM d, yyyy')}
          </p>
        </div>
      )}
    </div>
  );
};

export default AttendanceDatePicker;