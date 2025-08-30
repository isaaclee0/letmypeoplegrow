/**
 * Shared constants for consistent configuration across components
 */

// People and family types
export const PEOPLE_TYPES = {
  REGULAR: 'regular' as const,
  LOCAL_VISITOR: 'local_visitor' as const,
  TRAVELLER_VISITOR: 'traveller_visitor' as const
} as const;

export type PeopleType = typeof PEOPLE_TYPES[keyof typeof PEOPLE_TYPES];

// People type labels for display
export const PEOPLE_TYPE_LABELS: Record<PeopleType, string> = {
  [PEOPLE_TYPES.REGULAR]: 'Regular',
  [PEOPLE_TYPES.LOCAL_VISITOR]: 'Local Visitor',
  [PEOPLE_TYPES.TRAVELLER_VISITOR]: 'Traveller Visitor'
};

// Color palette for gatherings (consistent across components)
export const GATHERING_COLORS = [
  'bg-blue-500',
  'bg-green-500', 
  'bg-purple-500',
  'bg-orange-500',
  'bg-pink-500',
  'bg-indigo-500',
  'bg-red-500',
  'bg-yellow-500',
  'bg-teal-500',
  'bg-cyan-500'
] as const;

// Get color for a gathering by ID
export const getGatheringColor = (gatheringId: number): string => {
  return GATHERING_COLORS[gatheringId % GATHERING_COLORS.length];
};

// Visitor categorization constants
export const VISITOR_CATEGORIES = {
  RECENT_THRESHOLD_DAYS: 42, // 6 weeks
  INFREQUENT_LABEL: 'Infrequent (not seen in 6+ weeks)',
  RECENT_LABEL: 'Recent (last 6 weeks)'
} as const;

// Form validation constants
export const VALIDATION_LIMITS = {
  NAME_MIN_LENGTH: 1,
  NAME_MAX_LENGTH: 50,
  EMAIL_MAX_LENGTH: 255,
  FAMILY_NAME_MIN_LENGTH: 3,
  FAMILY_NAME_MAX_LENGTH: 100,
  NOTES_MAX_LENGTH: 500,
  PHONE_MIN_DIGITS: 7,
  PHONE_MAX_DIGITS: 15
} as const;

// Modal z-index levels for consistent layering
export const Z_INDEX = {
  MODAL: 9999,
  DROPDOWN: 1000,
  TOOLTIP: 1010,
  FLOATING_ACTION: 9998
} as const;

// Polling and refresh intervals (in milliseconds)
export const INTERVALS = {
  ATTENDANCE_POLLING: 20000, // 20 seconds
  DEBOUNCE_SEARCH: 300, // 300ms
  DEBOUNCE_VALIDATION: 500 // 500ms
} as const;

// Permission-related constants
export const PERMISSIONS = {
  EDIT_CUTOFF_WEEKS: 2, // Can't edit attendance older than 2 weeks
  ADMIN_ONLY_FEATURES: [
    'merge_people',
    'permanent_delete',
    'advanced_migrations',
    'bulk_operations'
  ]
} as const;

// CSV import constants
export const CSV_CONFIG = {
  EXPECTED_HEADERS: ['FIRST NAME', 'LAST NAME', 'FAMILY NAME'],
  SUPPORTED_SEPARATORS: [',', '\t'],
  MAX_FILE_SIZE_MB: 10,
  TEMPLATE_URL: '/api/csv-import/template'
} as const;

// Error messages for consistency
export const ERROR_MESSAGES = {
  NETWORK_ERROR: 'Network error. Please check your connection and try again.',
  PERMISSION_DENIED: 'You do not have permission to perform this action.',
  VALIDATION_FAILED: 'Please correct the errors below and try again.',
  DUPLICATE_FOUND: 'Duplicate entries found. Please review and correct.',
  OPERATION_FAILED: 'Operation failed. Please try again.',
  FILE_TOO_LARGE: `File size must be less than ${CSV_CONFIG.MAX_FILE_SIZE_MB}MB`,
  INVALID_FILE_TYPE: 'Please select a valid CSV file',
  REQUIRED_FIELD: 'This field is required'
} as const;

// Success messages for consistency
export const SUCCESS_MESSAGES = {
  PERSON_ADDED: 'Person added successfully',
  PERSON_UPDATED: 'Person updated successfully',
  PERSON_DELETED: 'Person deleted successfully',
  PERSON_ARCHIVED: 'Person archived successfully',
  PERSON_RESTORED: 'Person restored successfully',
  FAMILY_CREATED: 'Family created successfully',
  FAMILY_UPDATED: 'Family updated successfully',
  FAMILY_MERGED: 'Families merged successfully',
  ATTENDANCE_UPDATED: 'Attendance updated',
  BULK_OPERATION_COMPLETED: 'Bulk operation completed successfully',
  CSV_IMPORTED: 'CSV data imported successfully',
  ASSIGNMENTS_UPDATED: 'Gathering assignments updated'
} as const;

// Default values for forms
export const DEFAULTS = {
  PEOPLE_TYPE: PEOPLE_TYPES.REGULAR,
  FAMILY_TYPE: PEOPLE_TYPES.REGULAR,
  AUTO_FILL_SURNAME: false,
  MERGE_ASSIGNMENTS: true,
  VISITOR_FAMILY_PREFIX: 'Visitor Family'
} as const;

// Regular expressions for validation
export const REGEX_PATTERNS = {
  NAME: /^[a-zA-Z\s\-'\.]+$/,
  EMAIL: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  PHONE_DIGITS_ONLY: /\D/g
} as const;

// Layout and UI constants
export const UI_CONFIG = {
  ITEMS_PER_PAGE: 50,
  SEARCH_MIN_LENGTH: 2,
  MOBILE_BREAKPOINT: 768,
  TABLET_BREAKPOINT: 1024,
  ANIMATION_DURATION: 300
} as const;

// WebSocket configuration
export const WEBSOCKET_CONFIG = {
  // Environment variable VITE_USE_WEBSOCKETS controls WebSocket usage
  // Values: 'true' = WebSocket only, 'fallback' = WebSocket with API fallback, 'false' = API only
  USE_WEBSOCKETS: import.meta.env.VITE_USE_WEBSOCKETS || 'fallback',
  TIMEOUT_MS: 8000, // Reduced timeout for faster failure detection
  RETRY_ATTEMPTS: 2, // Reduced retry attempts
  OFFLINE_SYNC_INTERVAL: 30000
} as const;

// Helper to check WebSocket mode
export const getWebSocketMode = () => {
  const mode = WEBSOCKET_CONFIG.USE_WEBSOCKETS.toLowerCase();
  console.log('🔍 WebSocket Mode Debug:', {
    rawEnvVar: import.meta.env.VITE_USE_WEBSOCKETS,
    configValue: WEBSOCKET_CONFIG.USE_WEBSOCKETS,
    processedMode: mode,
    enabled: mode === 'true' || mode === 'fallback',
    fallbackAllowed: mode === 'fallback',
    pureWebSocket: mode === 'true'
  });
  
  return {
    enabled: mode === 'true' || mode === 'fallback',
    fallbackAllowed: mode === 'fallback',
    pureWebSocket: mode === 'true'
  };
};

// Feature flags for toggling functionality
export const FEATURE_FLAGS = {
  ENABLE_ADVANCED_SEARCH: true,
  ENABLE_BULK_OPERATIONS: true,
  ENABLE_FAMILY_GROUPING: true,
  ENABLE_VISITOR_CATEGORIZATION: true,
  ENABLE_AUTO_SAVE: false,
  ENABLE_REAL_TIME_VALIDATION: true
} as const;
