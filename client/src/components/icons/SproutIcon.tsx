import React from 'react';

interface SproutIconProps {
  className?: string;
}

// Simple single leaf icon
const SproutIcon: React.FC<SproutIconProps> = ({ className = "w-4 h-4" }) => {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Single leaf */}
      <path d="M12 20 Q12 16 8 12 Q6 10 4 8 Q3 7 4 6 Q5 5 6 6 Q10 8 14 12 Q18 16 18 20 Q18 21 17 21 Q12 21 12 20 Z" />
      {/* Leaf vein */}
      <path d="M12 20 Q10 16 8 12" stroke="currentColor" strokeWidth="0.5" fill="none" opacity="0.3" />
    </svg>
  );
};

export default SproutIcon;
