import { usersAPI } from './api';

// Preference keys
export const PREFERENCE_KEYS = {
  ATTENDANCE_LAST_VIEWED: 'attendance_last_viewed',
  ATTENDANCE_GATHERING_DATES: 'attendance_gathering_dates',
  REPORTS_LAST_VIEWED: 'reports_last_viewed', 
  PEOPLE_LAST_VIEWED: 'people_last_viewed',
} as const;

// Types for preference values
export interface AttendanceLastViewed {
  gatheringId: number;
  date: string;
  timestamp: number;
}

export interface AttendanceGatheringDates {
  [gatheringId: number]: string; // gatheringId -> last viewed date
  timestamp: number;
}

export interface ReportsLastViewed {
  selectedGatherings: number[];
  startDate: string;
  endDate: string;
  timestamp: number;
}

export interface PeopleLastViewed {
  selectedGathering: number | null;
  searchTerm: string;
  timestamp: number;
}

class UserPreferencesService {
  private syncInProgress = false;
  private pendingSync = false;

  // Get preference from localStorage (fast)
  getLocalPreference<T>(key: string): T | null {
    try {
      const stored = localStorage.getItem(`preference_${key}`);
      if (stored) {
        const parsed = JSON.parse(stored);
        // Check if preference is not too old (30 days)
        if (parsed.timestamp && Date.now() - parsed.timestamp < 30 * 24 * 60 * 60 * 1000) {
          return parsed;
        }
      }
    } catch (error) {
      console.warn(`Failed to get local preference ${key}:`, error);
    }
    return null;
  }

  // Save preference to localStorage (fast)
  setLocalPreference<T>(key: string, value: T): void {
    try {
      const data = {
        ...value,
        timestamp: Date.now()
      };
      localStorage.setItem(`preference_${key}`, JSON.stringify(data));
    } catch (error) {
      console.warn(`Failed to save local preference ${key}:`, error);
    }
  }

  // Get preference from database (persistent)
  async getDatabasePreference<T>(key: string): Promise<T | null> {
    try {
      const response = await usersAPI.getPreferences();
      const preferences = response.data.preferences;
      return preferences[key] || null;
    } catch (error) {
      console.warn(`Failed to get database preference ${key}:`, error);
      return null;
    }
  }

  // Save preference to database (persistent)
  async setDatabasePreference<T>(key: string, value: T): Promise<void> {
    try {
      await usersAPI.savePreference(key, value);
    } catch (error) {
      console.warn(`Failed to save database preference ${key}:`, error);
      throw error;
    }
  }

  // Hybrid get: try localStorage first, fallback to database
  async getPreference<T>(key: string): Promise<T | null> {
    // Try localStorage first (fast)
    const localValue = this.getLocalPreference<T>(key);
    if (localValue) {
      return localValue;
    }

    // Fallback to database
    const dbValue = await this.getDatabasePreference<T>(key);
    if (dbValue) {
      // Cache in localStorage for next time
      this.setLocalPreference(key, dbValue);
      return dbValue;
    }

    return null;
  }

  // Hybrid save: save to both localStorage and database
  async setPreference<T>(key: string, value: T): Promise<void> {
    // Save to localStorage immediately (fast UX)
    this.setLocalPreference(key, value);

    // Save to database in background (persistent)
    try {
      await this.setDatabasePreference(key, value);
    } catch (error) {
      console.warn(`Failed to sync preference ${key} to database:`, error);
      // Don't throw - localStorage save succeeded
    }
  }

  // Batch save multiple preferences
  async setPreferences(preferences: Record<string, any>): Promise<void> {
    // Save all to localStorage immediately
    Object.entries(preferences).forEach(([key, value]) => {
      this.setLocalPreference(key, value);
    });

    // Save all to database in background
    try {
      await usersAPI.savePreferences(preferences);
    } catch (error) {
      console.warn('Failed to sync preferences to database:', error);
      // Don't throw - localStorage saves succeeded
    }
  }

  // Sync all localStorage preferences to database (background sync)
  async syncToDatabase(): Promise<void> {
    if (this.syncInProgress) {
      this.pendingSync = true;
      return;
    }

    this.syncInProgress = true;

    try {
      const preferences: Record<string, any> = {};
      
      // Collect all localStorage preferences
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('preference_')) {
          const preferenceKey = key.replace('preference_', '');
          const value = this.getLocalPreference(preferenceKey);
          if (value) {
            preferences[preferenceKey] = value;
          }
        }
      }

      // Sync to database if we have preferences
      if (Object.keys(preferences).length > 0) {
        await usersAPI.savePreferences(preferences);
        console.log('✅ Synced preferences to database');
      }
    } catch (error) {
      console.warn('Failed to sync preferences to database:', error);
    } finally {
      this.syncInProgress = false;
      
      // If there was a pending sync, do it now
      if (this.pendingSync) {
        this.pendingSync = false;
        setTimeout(() => this.syncToDatabase(), 1000);
      }
    }
  }

  // Load all preferences from database and cache in localStorage
  async loadFromDatabase(): Promise<void> {
    try {
      const response = await usersAPI.getPreferences();
      const preferences = response.data.preferences;

      // Cache all preferences in localStorage
      Object.entries(preferences).forEach(([key, value]) => {
        this.setLocalPreference(key, value);
      });

      console.log('✅ Loaded preferences from database');
    } catch (error) {
      console.warn('Failed to load preferences from database:', error);
    }
  }

  // Specific preference helpers
  async getAttendanceLastViewed(): Promise<AttendanceLastViewed | null> {
    return this.getPreference<AttendanceLastViewed>(PREFERENCE_KEYS.ATTENDANCE_LAST_VIEWED);
  }

  async setAttendanceLastViewed(gatheringId: number, date: string): Promise<void> {
    const value: AttendanceLastViewed = {
      gatheringId,
      date,
      timestamp: Date.now()
    };
    return this.setPreference(PREFERENCE_KEYS.ATTENDANCE_LAST_VIEWED, value);
  }

  async getReportsLastViewed(): Promise<ReportsLastViewed | null> {
    return this.getPreference<ReportsLastViewed>(PREFERENCE_KEYS.REPORTS_LAST_VIEWED);
  }

  async setReportsLastViewed(selectedGatherings: number[], startDate: string, endDate: string): Promise<void> {
    const value: ReportsLastViewed = {
      selectedGatherings,
      startDate,
      endDate,
      timestamp: Date.now()
    };
    return this.setPreference(PREFERENCE_KEYS.REPORTS_LAST_VIEWED, value);
  }

  async getPeopleLastViewed(): Promise<PeopleLastViewed | null> {
    return this.getPreference<PeopleLastViewed>(PREFERENCE_KEYS.PEOPLE_LAST_VIEWED);
  }

  async setPeopleLastViewed(selectedGathering: number | null, searchTerm: string): Promise<void> {
    const value: PeopleLastViewed = {
      selectedGathering,
      searchTerm,
      timestamp: Date.now()
    };
    return this.setPreference(PREFERENCE_KEYS.PEOPLE_LAST_VIEWED, value);
  }

  // Gathering-specific date tracking
  async getAttendanceGatheringDates(): Promise<AttendanceGatheringDates | null> {
    return this.getPreference<AttendanceGatheringDates>(PREFERENCE_KEYS.ATTENDANCE_GATHERING_DATES);
  }

  async setAttendanceGatheringDate(gatheringId: number, date: string): Promise<void> {
    const current = await this.getAttendanceGatheringDates() || { timestamp: Date.now() };
    const updated: AttendanceGatheringDates = {
      ...current,
      [gatheringId]: date,
      timestamp: Date.now()
    };
    return this.setPreference(PREFERENCE_KEYS.ATTENDANCE_GATHERING_DATES, updated);
  }

  async getLastViewedDateForGathering(gatheringId: number): Promise<string | null> {
    const gatheringDates = await this.getAttendanceGatheringDates();
    return gatheringDates?.[gatheringId] || null;
  }
}

// Export singleton instance
export const userPreferences = new UserPreferencesService();

// Auto-sync preferences when the app loads
if (typeof window !== 'undefined') {
  // Load from database on app start
  userPreferences.loadFromDatabase();
  
  // Sync to database periodically (every 5 minutes)
  setInterval(() => {
    userPreferences.syncToDatabase();
  }, 5 * 60 * 1000);
  
  // Sync to database when page is about to unload
  window.addEventListener('beforeunload', () => {
    userPreferences.syncToDatabase();
  });
}
