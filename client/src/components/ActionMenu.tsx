import React, { useState, useRef, useEffect } from 'react';
import { CogIcon } from '@heroicons/react/24/outline';

interface ActionMenuItem {
  label: string;
  onClick: () => void;
  icon?: React.ReactNode;
  className?: string;
  hidden?: boolean;
}

interface ActionMenuProps {
  items: ActionMenuItem[];
  className?: string;
}

const ActionMenu: React.FC<ActionMenuProps> = ({ items, className = '' }) => {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const visibleItems = items.filter(item => !item.hidden);

  if (visibleItems.length === 0) {
    return null;
  }

  return (
    <div className={`relative ${className}`} ref={menuRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="p-1 text-gray-400 hover:text-gray-600 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 rounded"
        title="More actions"
      >
        <CogIcon className="h-5 w-5" />
      </button>

      {isOpen && (
        <div className="absolute right-0 z-50 mt-2 w-48 bg-white rounded-md shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none">
          <div className="py-1">
            {visibleItems.map((item, index) => (
              <button
                key={index}
                onClick={() => {
                  item.onClick();
                  setIsOpen(false);
                }}
                className={`w-full text-left flex items-center px-4 py-2 text-sm hover:bg-gray-100 ${
                  item.className || 'text-gray-700'
                }`}
              >
                {item.icon && <span className="mr-3 flex-shrink-0">{item.icon}</span>}
                {item.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default ActionMenu; 