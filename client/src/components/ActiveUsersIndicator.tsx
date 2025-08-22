import React from 'react';
import { useAuth } from '../contexts/AuthContext';
import { ActiveUser } from '../contexts/WebSocketContext';

interface ActiveUsersIndicatorProps {
  activeUsers: ActiveUser[];
  className?: string;
}

const ActiveUsersIndicator: React.FC<ActiveUsersIndicatorProps> = ({ 
  activeUsers, 
  className = '' 
}) => {
  const { user: currentUser } = useAuth();
  
  // Filter out the current user from the display
  const otherUsers = activeUsers.filter(user => user.id !== currentUser?.id);
  
  // Don't show anything if there are no other users
  if (otherUsers.length === 0) {
    return null;
  }

  // Function to generate initials from name
  const getInitials = (user: ActiveUser): string => {
    const firstInitial = user.firstName ? user.firstName.charAt(0).toUpperCase() : '';
    const lastInitial = user.lastName ? user.lastName.charAt(0).toUpperCase() : '';
    
    if (firstInitial && lastInitial) {
      return firstInitial + lastInitial;
    } else if (firstInitial) {
      return firstInitial;
    } else {
      // Fallback to email if no name
      return user.email ? user.email.charAt(0).toUpperCase() : 'U';
    }
  };

  // Function to get full name for tooltip
  const getFullName = (user: ActiveUser): string => {
    if (user.firstName && user.lastName) {
      return `${user.firstName} ${user.lastName}`;
    } else if (user.firstName) {
      return user.firstName;
    } else {
      return user.email;
    }
  };

  // Generate a consistent color for each user based on their ID
  const getUserColor = (userId: number): string => {
    const colors = [
      'bg-blue-500',
      'bg-green-500', 
      'bg-purple-500',
      'bg-orange-500',
      'bg-pink-500',
      'bg-indigo-500',
      'bg-teal-500',
      'bg-red-500',
      'bg-yellow-500',
      'bg-gray-500'
    ];
    return colors[userId % colors.length];
  };

  return (
    <div className={`flex items-center space-x-1 ${className}`}>
      {otherUsers.slice(0, 5).map((user) => (
        <div
          key={user.id}
          className={`relative h-8 w-8 rounded-full ${getUserColor(user.id)} flex items-center justify-center text-white text-xs font-medium shadow-sm border-2 border-white transition-transform hover:scale-110 cursor-pointer group`}
          title={getFullName(user)}
        >
          {getInitials(user)}
          
          {/* Tooltip */}
          <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-2 py-1 bg-gray-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-10">
            {getFullName(user)}
            <div className="absolute top-full left-1/2 transform -translate-x-1/2 border-4 border-transparent border-t-gray-900"></div>
          </div>
        </div>
      ))}
      
      {/* Show +N if there are more than 5 users */}
      {otherUsers.length > 5 && (
        <div 
          className="h-8 w-8 rounded-full bg-gray-400 flex items-center justify-center text-white text-xs font-medium shadow-sm border-2 border-white"
          title={`${otherUsers.length - 5} more users`}
        >
          +{otherUsers.length - 5}
        </div>
      )}
    </div>
  );
};

export default ActiveUsersIndicator;
