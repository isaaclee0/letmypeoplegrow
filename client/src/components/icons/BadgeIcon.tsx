import React from 'react';
import {
  UsersIcon,
  StarIcon,
  HeartIcon,
  SparklesIcon,
  FireIcon,
  SunIcon,
  MoonIcon,
  BoltIcon,
  MusicalNoteIcon,
  FlagIcon,
  TrophyIcon,
  BookOpenIcon
} from '@heroicons/react/24/solid';

export type BadgeIconType = 'person' | 'star' | 'heart' | 'sparkles' | 'fire' | 'sun' | 'moon' | 'bolt' | 'music' | 'flag' | 'trophy' | 'book';

interface BadgeIconProps {
  type: BadgeIconType;
  className?: string;
}

const BadgeIcon: React.FC<BadgeIconProps> = ({ type, className = "w-4 h-4" }) => {
  switch (type) {
    case 'person':
      return <UsersIcon className={className} />;
    case 'star':
      return <StarIcon className={className} />;
    case 'heart':
      return <HeartIcon className={className} />;
    case 'sparkles':
      return <SparklesIcon className={className} />;
    case 'fire':
      return <FireIcon className={className} />;
    case 'sun':
      return <SunIcon className={className} />;
    case 'moon':
      return <MoonIcon className={className} />;
    case 'bolt':
      return <BoltIcon className={className} />;
    case 'music':
      return <MusicalNoteIcon className={className} />;
    case 'flag':
      return <FlagIcon className={className} />;
    case 'trophy':
      return <TrophyIcon className={className} />;
    case 'book':
      return <BookOpenIcon className={className} />;
    default:
      return <UsersIcon className={className} />;
  }
};

export default BadgeIcon;

// Icon options for the selector
export const BADGE_ICON_OPTIONS = [
  { value: 'person', label: 'Child', icon: 'person' },
  { value: 'star', label: 'Star', icon: 'star' },
  { value: 'heart', label: 'Heart', icon: 'heart' },
  { value: 'fire', label: 'Fire', icon: 'fire' },
  { value: 'sparkles', label: 'Sparkles', icon: 'sparkles' },
  { value: 'sun', label: 'Sun', icon: 'sun' },
  { value: 'moon', label: 'Moon', icon: 'moon' },
  { value: 'bolt', label: 'Lightning', icon: 'bolt' },
  { value: 'music', label: 'Music', icon: 'music' },
  { value: 'flag', label: 'Flag', icon: 'flag' },
  { value: 'trophy', label: 'Trophy', icon: 'trophy' },
  { value: 'book', label: 'Book', icon: 'book' },
] as const;
