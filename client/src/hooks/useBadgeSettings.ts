import { useState, useEffect } from 'react';
import { settingsAPI } from '../services/api';
import { getChildBadgeStyles } from '../utils/colorUtils';
import logger from '../utils/logger';

interface BadgeConfig {
  child: {
    defaultText: string;
    defaultColor: string;
    defaultIcon: string;
  };
  adult: {
    defaultText: string | null;
    defaultColor: string | null;
    defaultIcon: string | null;
  };
}

interface PersonBadgeInfo {
  text: string | null;
  icon: string;
  styles: {
    backgroundColor: string;
    color: string;
  };
}

/**
 * Hook to fetch and provide badge configuration for the church
 */
export function useBadgeSettings() {
  const [badgeConfig, setBadgeConfig] = useState<BadgeConfig>({
    child: {
      defaultText: '',
      defaultColor: '#c5aefb', // Light purple (75% opacity of primary purple #8b5cf6)
      defaultIcon: 'person' // Default to person icon, but can be empty string for no icon
    },
    adult: {
      defaultText: null,
      defaultColor: null,
      defaultIcon: null
    }
  });
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchBadgeSettings = async () => {
      try {
        const response = await settingsAPI.getBadgeDefaults();
        const settings = response.data.settings;
        setBadgeConfig({
          child: {
            defaultText: settings?.default_badge_text || '',
            defaultColor: settings?.child_flair_color || '#c5aefb',
            // Allow empty string for no default child icon; null/undefined defaults to 'person'
            defaultIcon: settings?.default_child_badge_icon !== null && settings?.default_child_badge_icon !== undefined
              ? settings.default_child_badge_icon
              : 'person'
          },
          adult: {
            defaultText: settings?.default_adult_badge_text || null,
            defaultColor: settings?.default_adult_badge_color || null,
            defaultIcon: settings?.default_adult_badge_icon || null
          }
        });
      } catch (error) {
        logger.error('Failed to fetch badge settings:', error);
        // Use defaults on error
      } finally {
        setIsLoading(false);
      }
    };

    fetchBadgeSettings();
  }, []);

  /**
   * Get badge info for a specific person
   * @param person Person object with isChild, badgeText, badgeColor, badgeIcon
   * @returns Badge info with text, icon, and styles, or null if no badge should be shown
   */
  const getBadgeInfo = (person: {
    isChild?: boolean;
    badgeText?: string | null;
    badgeColor?: string | null;
    badgeIcon?: string | null;
  }): PersonBadgeInfo | null => {
    // If person has custom badge (text, color, or icon set), use it
    if (person.badgeText || person.badgeColor || person.badgeIcon) {
      const defaultColor = person.isChild ? badgeConfig.child.defaultColor : (badgeConfig.adult.defaultColor || '#c5aefb');
      const color = person.badgeColor || defaultColor;
      // Use person's icon if set (including empty string), otherwise use default
      const icon = person.badgeIcon !== null && person.badgeIcon !== undefined
        ? person.badgeIcon
        : (person.isChild ? badgeConfig.child.defaultIcon : 'person');
      // Use person's text if set, otherwise fall back to default
      const text = person.badgeText
        || (person.isChild ? badgeConfig.child.defaultText : badgeConfig.adult.defaultText)
        || null;

      // If no icon and no text, don't show badge
      if (!icon && !text) {
        return null;
      }

      return {
        text,
        icon: icon, // Allow empty string for text-only badges
        styles: getChildBadgeStyles(color)
      };
    }

    // If person is a child (and no custom badge), show default child badge if configured
    if (person.isChild) {
      // Only show badge if default icon is set OR default text is set
      if (badgeConfig.child.defaultIcon || badgeConfig.child.defaultText) {
        return {
          text: badgeConfig.child.defaultText || null,
          icon: badgeConfig.child.defaultIcon, // Allow empty string for text-only badges
          styles: getChildBadgeStyles(badgeConfig.child.defaultColor)
        };
      }
      // No default badge configured for children
      return null;
    }

    // If person is an adult and a default adult badge is configured, show it
    if (!person.isChild && badgeConfig.adult.defaultIcon) {
      return {
        text: badgeConfig.adult.defaultText || null,
        icon: badgeConfig.adult.defaultIcon,
        styles: getChildBadgeStyles(badgeConfig.adult.defaultColor || '#c5aefb')
      };
    }

    // No badge for this person
    return null;
  };

  return {
    badgeConfig,
    getBadgeInfo,
    isLoading
  };
}
