import React from 'react';
import { ShieldCheckIcon } from '@heroicons/react/24/solid';
import { ShieldExclamationIcon } from '@heroicons/react/24/outline';

interface BackgroundCheckShieldProps {
  cleared: boolean | null | undefined;
  className?: string;
}

// Green solid shield when PCO reports a cleared, current background check;
// amber outline shield otherwise (not cleared, expired, or never synced —
// deliberately not red, since `false`/`null` can mean several different
// underlying PCO states we can't distinguish, and we don't want to assert a
// hard failure we can't back up).
const BackgroundCheckShield: React.FC<BackgroundCheckShieldProps> = ({ cleared, className = 'w-5 h-5' }) => {
  if (cleared) {
    return (
      <ShieldCheckIcon
        className={`${className} text-green-600 dark:text-green-400 shrink-0`}
        aria-label="Background check cleared"
        aria-hidden={false}
      />
    );
  }
  return (
    <ShieldExclamationIcon
      className={`${className} text-amber-600 dark:text-amber-400 shrink-0`}
      aria-label="No cleared background check on file"
      aria-hidden={false}
    />
  );
};

export default BackgroundCheckShield;
