import React, { useState, useRef, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';

interface ChurchSwitcherProps {
  className?: string;
  textClassName?: string;
}

const ChurchSwitcher: React.FC<ChurchSwitcherProps> = ({ className, textClassName }) => {
  const { user, myChurches, switchChurch } = useAuth();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSwitch = async (churchId: string) => {
    setSwitching(true);
    try {
      await switchChurch(churchId);
    } catch (error) {
      console.error('Failed to switch church:', error);
      setSwitching(false);
    }
  };

  if (myChurches.length === 0) {
    return (
      <div
        className={`relative overflow-hidden rounded-lg border border-white/10 bg-white/[0.06] px-3 py-2.5 shadow-sm ${textClassName || 'text-white'} ${className || ''}`}
        role="group"
        aria-label="Current church"
      >
        <span
          aria-hidden="true"
          className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-secondary-300/80"
        />
        <p className="text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-primary-100/80">
          Current church
        </p>
        <p className="mt-0.5 break-words text-base font-semibold leading-snug">
          {user?.churchName}
        </p>
      </div>
    );
  }

  return (
    <div className={`relative ${className || ''}`} ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        disabled={switching}
        className={`${textClassName || ''} flex items-center gap-1`}
      >
        <span>{user?.churchName}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-48 rounded-md bg-white dark:bg-gray-700 shadow-lg border border-gray-200 dark:border-gray-600">
          <div className="px-3 py-2 text-xs font-semibold text-gray-500 dark:text-gray-300 border-b border-gray-200 dark:border-gray-600">
            Switch church
          </div>
          {myChurches.map((church) => (
            <button
              key={church.churchId}
              type="button"
              onClick={() => handleSwitch(church.churchId)}
              className="block w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-600"
            >
              {church.churchName}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default ChurchSwitcher;
