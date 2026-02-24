import { useState, useEffect } from 'react';
import { settingsAPI } from '../services/api';
import { getChildBadgeStyles } from '../utils/colorUtils';
import logger from '../utils/logger';

/**
 * Hook to fetch and provide child flair color settings
 * Returns the badge styles to apply to child badges
 */
export function useChildFlairColor() {
  const [badgeStyles, setBadgeStyles] = useState(getChildBadgeStyles('#c5aefb')); // Default light purple
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchChildFlairColor = async () => {
      try {
        const response = await settingsAPI.getAll();
        const color = response.data.settings?.child_flair_color || '#c5aefb';
        setBadgeStyles(getChildBadgeStyles(color));
      } catch (error) {
        logger.error('Failed to fetch child flair color:', error);
        // Use default color on error
        setBadgeStyles(getChildBadgeStyles('#c5aefb'));
      } finally {
        setIsLoading(false);
      }
    };

    fetchChildFlairColor();
  }, []);

  return { badgeStyles, isLoading };
}
