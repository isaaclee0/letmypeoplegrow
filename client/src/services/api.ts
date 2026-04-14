import axios from 'axios';

// Use relative URL for API requests - this will work with any domain
const API_BASE_URL = process.env.REACT_APP_API_URL || '/api';

// Create axios instance
const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 15000, // Increased timeout for iOS Safari
  withCredentials: true, // Enable cookies to be sent with requests
  headers: {
    'Content-Type': 'application/json',
  },
});

// Track refresh state to prevent concurrent refreshes
let isRefreshingToken = false;
let failedQueue: Array<{
  resolve: (value?: any) => void;
  reject: (reason?: any) => void;
}> = [];

const processQueue = (error: any, token: string | null = null) => {
  failedQueue.forEach(({ resolve, reject }) => {
    if (error) {
      reject(error);
    } else {
      resolve(token);
    }
  });

  failedQueue = [];
};

// Request interceptor - cookies are automatically sent with withCredentials: true
api.interceptors.request.use(
  (config) => {
    // Cookies are automatically handled by the browser when withCredentials is true
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor to handle token expiry and auto-refresh
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    
    // Handle network errors (server unavailable, no internet, etc.)
    if (!error.response && (error.code === 'NETWORK_ERROR' || error.message?.includes('fetch'))) {
      console.log('🌐 Network error detected - server may be unavailable');
      // Don't redirect to login for network errors - let components handle offline mode
      return Promise.reject({
        ...error,
        code: 'NETWORK_ERROR',
        isNetworkError: true
      });
    }
    
    // Handle 401 errors with token refresh
    if (error.response?.status === 401) {
      const originalRequest = error.config;
      const requestUrl = originalRequest.url;
      
      // Skip refresh for auth endpoints to prevent infinite loops
      if (requestUrl.includes('/auth/refresh') || requestUrl.includes('/auth/logout')) {
        console.log('🔒 Auth endpoint 401 - not attempting refresh:', requestUrl);
        return Promise.reject(error);
      }
      
      // Only log 401s for non-auth endpoints to reduce noise
      if (!requestUrl.includes('/auth/me')) {
        console.log('🔒 Authentication required for:', requestUrl);
      }
      
      // Prevent infinite loops by checking if this request is already a retry
      if (originalRequest._retry) {
        console.log('⚠️ Request already retried, not attempting refresh again');
        return Promise.reject(error);
      }
      
      // Attempt token refresh if not already refreshing
      if (!isRefreshingToken) {
        isRefreshingToken = true;
        console.log('🔄 Attempting token refresh...');
        
        try {
          const refreshResponse = await api.post('/auth/refresh');
          
          if (refreshResponse.status === 200) {
            console.log('✅ Token refresh successful');
            isRefreshingToken = false;
            processQueue(null, 'refreshed');
            
            // Mark request as retried and retry the original request
            originalRequest._retry = true;
            return api(originalRequest);
          }
        } catch (refreshError: any) {
          console.log('💥 Token refresh failed:', refreshError.response?.status || refreshError.message);
          isRefreshingToken = false;
          processQueue(refreshError, null);
          
          // Only redirect to login if it's an authentication error, not a network error
          if (refreshError.response?.status === 401 || refreshError.response?.status === 403) {
            localStorage.removeItem('user');
            if (window.location.pathname !== '/login') {
              console.log('➡️ Redirecting to login due to auth failure');
              window.location.href = '/login';
            }
          } else if (refreshError.isNetworkError) {
            console.log('🌐 Token refresh failed due to network error - staying offline');
            // Don't redirect to login for network errors
          } else {
            localStorage.removeItem('user');
            if (window.location.pathname !== '/login') {
              console.log('➡️ Redirecting to login due to unexpected error');
              window.location.href = '/login';
            }
          }
          return Promise.reject(refreshError);
        }
      } else {
        // If already refreshing, queue this request
        console.log('⏳ Token refresh in progress, queuing request');
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        }).then(() => {
          // Mark request as retried and retry the original request
          originalRequest._retry = true;
          return api(originalRequest);
        }).catch((err) => {
          return Promise.reject(err);
        });
      }
    }
    return Promise.reject(error);
  }
);

// Types
export interface User {
  id: number;
  email?: string;
  mobileNumber?: string;
  primaryContactMethod: 'email' | 'sms';
  role: 'admin' | 'coordinator' | 'attendance_taker';
  firstName: string;
  lastName: string;
  isChurchApproved?: boolean;
  isFirstLogin?: boolean;
  defaultGatheringId?: number;
  church_id?: string;
  gatheringAssignments: GatheringType[];
  unreadNotifications?: number;
  hasSampleData?: boolean;
}

export interface GatheringType {
  id: number;
  name: string;
  description?: string;
  dayOfWeek?: string;
  startTime?: string;
  frequency?: string;
  attendanceType: 'standard' | 'headcount';
  customSchedule?: {
    type: 'one_off' | 'recurring';
    startDate: string;
    endDate?: string;
    pattern?: {
      frequency: 'daily' | 'weekly' | 'biweekly' | 'monthly';
      interval: number;
      daysOfWeek?: string[];
      dayOfMonth?: number;
      customDates?: string[];
    };
  };
  endTime?: string;
  kioskEnabled?: boolean;
  leaderCheckinEnabled?: boolean;
  individualMode?: boolean;
  kioskMessage?: string;
  isActive: boolean;
  memberCount?: number;
  createdAt?: string;
}

export interface Individual {
  id: number;
  firstName: string;
  lastName: string;
  peopleType: 'regular' | 'local_visitor' | 'traveller_visitor';
  isChild?: boolean;
  badgeText?: string | null;
  badgeColor?: string | null;
  badgeIcon?: string | null;
  familyId?: number;
  familyName?: string;
  familyNotes?: string | null;
  present?: boolean;
  isSaving?: boolean;
}

export interface Visitor {
  id?: number;
  individualId?: number;
  name: string;
  visitorType: 'potential_regular' | 'temporary_other';
  visitorFamilyGroup?: string;
  notes?: string;
  lastAttended?: string;
  familyId?: number;
  familyName?: string;
  isChild?: boolean;
}

export interface AttendanceData {
  attendanceList: Individual[];
  visitors: Visitor[];
}

export interface AddVisitorData {
  name?: string;
  visitorType?: string;
  visitorFamilyGroup?: string;
  familyName?: string;
  notes?: string;
  people?: Array<{
    firstName: string;
    lastName: string;
    firstUnknown: boolean;
    lastUnknown: boolean;
    isChild: boolean;
  }>;
}

// Auth API
export const authAPI = {
  requestCode: (contact: string, churchId?: string) =>
    api.post('/auth/request-code', { contact, ...(churchId && { churchId }) }),

  verifyCode: (contact: string, code: string, churchId?: string) =>
    api.post('/auth/verify-code', { contact, code, ...(churchId && { churchId }) }),
    

  register: (data: {
    email: string;
    firstName: string;
    lastName: string;
    role?: 'admin' | 'attendance_taker' | 'coordinator';
  }) => 
    api.post('/auth/register', data),
    
  getCurrentUser: () => 
    api.get('/auth/me'),
    
  refreshToken: () => {
    console.log('🔄 API: authAPI.refreshToken() called');
    console.log('🔧 RefreshToken call stack:', new Error().stack);
    console.log('🕒 Current time:', new Date().toISOString());
    
    const result = api.post('/auth/refresh');
    console.log('📤 API: Refresh token request sent');
    
    result.then(() => {
      console.log('✅ API: Refresh token request completed successfully');
    }).catch((error) => {
      console.log('💥 API: Refresh token request failed:', error);
    });
    
    return result;
  },
    
  logout: () => 
    api.post('/auth/logout'),
    
  clearExpiredToken: () => 
    api.post('/auth/clear-expired-token'),
    

  checkUsers: () =>
    api.get('/auth/check-users'),

  getServerTime: () =>
    api.get('/auth/server-time'),
};

// Gatherings API
export const gatheringsAPI = {
  getAll: () => 
    api.get('/gatherings'),
    
  create: (data: {
    name: string;
    description?: string;
    dayOfWeek?: string;
    startTime?: string;
    frequency?: string;
    attendanceType: 'standard' | 'headcount';
    customSchedule?: {
      type: 'one_off' | 'recurring';
      startDate: string;
      endDate?: string;
      pattern?: {
        frequency: 'daily' | 'weekly' | 'biweekly' | 'monthly';
        interval: number;
        daysOfWeek?: string[];
        dayOfMonth?: number;
        customDates?: string[];
      };
    };
    kioskEnabled?: boolean;
    leaderCheckinEnabled?: boolean;
    individualMode?: boolean;
    setAsDefault?: boolean;
  }) =>
    api.post('/gatherings', data),

  update: (gatheringId: number, data: {
    name: string;
    description?: string;
    dayOfWeek?: string;
    startTime?: string;
    frequency?: string;
    attendanceType: 'standard' | 'headcount';
    customSchedule?: {
      type: 'one_off' | 'recurring';
      startDate: string;
      endDate?: string;
      pattern?: {
        frequency: 'daily' | 'weekly' | 'biweekly' | 'monthly';
        interval: number;
        daysOfWeek?: string[];
        dayOfMonth?: number;
        customDates?: string[];
      };
    };
    kioskEnabled?: boolean;
    leaderCheckinEnabled?: boolean;
    individualMode?: boolean;
  }) =>
    api.put(`/gatherings/${gatheringId}`, data),
    
  getMembers: (gatheringId: number) => 
    api.get(`/gatherings/${gatheringId}/members`),
    
  duplicate: (gatheringId: number, name: string) => 
    api.post(`/gatherings/${gatheringId}/duplicate`, { name }),
    
  delete: (gatheringId: number) => 
    api.delete(`/gatherings/${gatheringId}`),

  updateKioskSettings: (gatheringId: number, data: { endTime?: string; kioskMessage?: string }) =>
    api.patch(`/gatherings/${gatheringId}/kiosk-settings`, data),
};

// Attendance API
export const attendanceAPI = {
  get: (gatheringTypeId: number, date: string) =>
    api.get(`/attendance/${gatheringTypeId}/${date}`),

  // OPTIMIZED: Get all attendance data in one call (replaces 5 separate calls)
  getFull: (gatheringTypeId: number, date: string) =>
    api.get(`/attendance/${gatheringTypeId}/${date}/full`),

  record: (gatheringTypeId: number, date: string, data: {
    attendanceRecords: Array<{ individualId: number; present: boolean }>;
    visitors: Visitor[];
  }) =>
    api.post(`/attendance/${gatheringTypeId}/${date}`, data),

  getRecentVisitors: (gatheringTypeId: number) =>
    api.get(`/attendance/${gatheringTypeId}/visitors/recent`),

  // Church-wide visitors (all gatherings, all time)
  getAllVisitors: () =>
    api.get('/attendance/visitors/all'),

  // Church-wide people (all gatherings, all time - including regular members)
  getAllPeople: () =>
    api.get('/attendance/people/all'),
    
  addVisitor: (gatheringTypeId: number, date: string, visitor: AddVisitorData) => 
    api.post(`/attendance/${gatheringTypeId}/${date}/visitors`, visitor),
    
  updateVisitor: (gatheringTypeId: number, date: string, visitorId: number, visitor: AddVisitorData) => 
    api.put(`/attendance/${gatheringTypeId}/${date}/visitors/${visitorId}`, visitor),
    
  deleteVisitor: (gatheringTypeId: number, date: string, visitorId: number, deleteFamily: boolean = false) => 
    api.delete(`/attendance/${gatheringTypeId}/${date}/visitors/${visitorId}${deleteFamily ? '?deleteFamily=true' : ''}`),
    
  addRegularAttendee: (gatheringTypeId: number, date: string, people: Array<{
    firstName: string;
    lastName: string;
    firstUnknown: boolean;
    lastUnknown: boolean;
    isChild: boolean;
  }>) => 
    api.post(`/attendance/${gatheringTypeId}/${date}/regulars`, { people }),
    
  addVisitorFamilyToService: (gatheringTypeId: number, date: string, familyId: number) => 
    api.post(`/attendance/${gatheringTypeId}/${date}/visitor-family/${familyId}`),
    
  addIndividualToService: (gatheringTypeId: number, date: string, individualId: number) => 
    api.post(`/attendance/${gatheringTypeId}/${date}/individual/${individualId}`),

  // Headcount endpoints
  getHeadcount: (gatheringTypeId: number, date: string, mode: 'separate' | 'combined' | 'averaged' = 'separate') => 
    api.get(`/attendance/headcount/${gatheringTypeId}/${date}?mode=${mode}`),
    
  updateHeadcount: (gatheringTypeId: number, date: string, headcount: number, mode: 'separate' | 'combined' | 'averaged' = 'separate') => 
    api.post(`/attendance/headcount/update/${gatheringTypeId}/${date}`, { headcount, mode }),
    
  updateHeadcountMode: (gatheringTypeId: number, date: string, mode: 'separate' | 'combined' | 'averaged') => 
    api.put(`/attendance/headcount/mode/${gatheringTypeId}/${date}`, { mode }),
    
  updateUserHeadcount: (gatheringTypeId: number, date: string, targetUserId: number, headcount: number) =>
    api.post(`/attendance/headcount/update-user/${gatheringTypeId}/${date}/${targetUserId}`, { headcount }),

  toggleExcludeFromStats: (sessionId: number) =>
    api.patch(`/attendance/sessions/${sessionId}/exclude`),
};

// Kiosk API
export const kioskAPI = {
  record: (gatheringTypeId: number, date: string, data: {
    individualIds: number[];
    action: 'checkin' | 'checkout';
    signerName?: string;
  }) =>
    api.post(`/kiosk/${gatheringTypeId}/${date}`, data),

  getHistory: (gatheringTypeId: number, limit?: number) =>
    api.get(`/kiosk/history/${gatheringTypeId}`, { params: { limit: limit || 20 } }),

  getHistoryDetail: (gatheringTypeId: number, date: string) =>
    api.get(`/kiosk/history/${gatheringTypeId}/${date}`),

  deleteSession: (gatheringTypeId: number, date: string) =>
    api.delete(`/kiosk/history/${gatheringTypeId}/${date}`),
};

// Users API
export const usersAPI = {
  getAll: () => 
    api.get('/users'),
    
  getById: (id: number) => 
    api.get(`/users/${id}`),
    
  create: (data: {
    email?: string;
    mobileNumber?: string;
    primaryContactMethod: 'email' | 'sms';
    role: 'coordinator' | 'attendance_taker';
    firstName: string;
    lastName: string;
  }) => 
    api.post('/users', data),
    
  update: (id: number, data: any) => 
    api.put(`/users/${id}`, data),
    
  delete: (id: number) =>
    api.delete(`/users/${id}`),

  getGatheringAssignments: (userId: number) =>
    api.get(`/users/${userId}/gatherings`),
    
  assignGatherings: (userId: number, gatheringIds: number[]) => 
    api.post(`/users/${userId}/gatherings`, { gatheringIds }),
  
  updateMe: (data: {
    firstName?: string;
    lastName?: string;
    email?: string | null;
    mobileNumber?: string | null;
    primaryContactMethod?: 'email' | 'sms';
  }) => api.put('/users/me', data),
  
  // User preferences
  getPreferences: () => 
    api.get('/users/me/preferences'),
    
  savePreference: (key: string, value: any) => 
    api.post('/users/me/preferences', { key, value }),
    
  savePreferences: (preferences: Record<string, any>) => 
    api.post('/users/me/preferences/batch', { preferences }),
};

// Invitations API
export const invitationsAPI = {
  send: (data: {
    email?: string;
    mobileNumber?: string;
    primaryContactMethod: 'email' | 'sms';
    role: 'coordinator' | 'attendance_taker';
    firstName: string;
    lastName: string;
    gatheringIds?: number[];
  }) => 
    api.post('/invitations/send', data),
    
  getPending: () => 
    api.get('/invitations/pending'),
    
  resend: (id: number) => 
    api.post(`/invitations/resend/${id}`),
    
  cancel: (id: number) => 
    api.delete(`/invitations/${id}`),
    
  accept: (token: string) => 
    api.get(`/invitations/accept/${token}`),
    
  complete: (token: string, data: { gatheringAssignments?: number[] }) => 
    api.post(`/invitations/complete/${token}`, data),
};

// Families API
export const familiesAPI = {
  getAll: () => 
    api.get('/families'),
  getAllIncludingInactive: () => 
    api.get('/families/all'),
    
  create: (data: { familyName: string }) => 
    api.post('/families', data),
    
  update: (id: number, data: { familyName?: string; familyType?: 'regular' | 'local_visitor' | 'traveller_visitor' }) =>
    api.put(`/families/${id}`, data),
    
  delete: (id: number) =>
    api.delete(`/families/${id}`),
    
  createVisitorFamily: (data: {
    familyName: string;
    peopleType: 'regular' | 'local_visitor' | 'traveller_visitor';
    notes?: string;
    people: Array<{
      firstName: string;
      lastName: string;
      firstUnknown: boolean;
      lastUnknown: boolean;
      isChild: boolean;
    }>;
  }) => 
    api.post('/families/visitor', data),
    
  merge: (data: {
    keepFamilyId: number;
    mergeFamilyIds: number[];
    newFamilyName?: string;
    newFamilyType?: 'regular' | 'local_visitor' | 'traveller_visitor';
  }) => 
    api.post('/families/merge', data),
    
  mergeIndividuals: (data: {
    individualIds: number[];
    familyName: string;
    familyType?: 'regular' | 'local_visitor' | 'traveller_visitor';
    mergeAssignments?: boolean;
  }) =>
    api.post('/families/merge-individuals', data),

  getCaregivers: (familyId: number) =>
    api.get(`/families/${familyId}/caregivers`).then(r => r.data.caregivers),

  assignCaregiver: (familyId: number, payload: {
    caregiver_type: 'user' | 'contact';
    user_id?: number;
    contact_id?: number;
  }) => api.post(`/families/${familyId}/caregivers`, payload).then(r => r.data),

  removeCaregiver: (familyId: number, caregiverId: number) =>
    api.delete(`/families/${familyId}/caregivers/${caregiverId}`).then(r => r.data),
};

// Individuals API
export const individualsAPI = {
  getAll: () => 
    api.get('/individuals'),
    
  get: (id: number) => 
    api.get(`/individuals/${id}`),
    
  create: (data: {
    firstName: string;
    lastName: string;
    familyId?: number;
    isChild?: boolean;
    peopleType?: 'regular' | 'local_visitor' | 'traveller_visitor';
  }) => 
    api.post('/individuals', data),
    
  update: (id: number, data: {
    firstName: string;
    lastName: string;
    familyId?: number;
    peopleType?: 'regular' | 'local_visitor' | 'traveller_visitor';
    isChild?: boolean;
  }) => 
    api.put(`/individuals/${id}`, data),
    
  delete: (id: number) => 
    api.delete(`/individuals/${id}`),
  restore: (id: number) =>
    api.post(`/individuals/${id}/restore`),
  permanentDelete: (id: number) =>
    api.delete(`/individuals/${id}/permanent`),
    
  assignToGathering: (individualId: number, gatheringId: number) => 
    api.post(`/individuals/${individualId}/gatherings/${gatheringId}`),
    
  unassignFromGathering: (individualId: number, gatheringId: number) => 
    api.delete(`/individuals/${individualId}/gatherings/${gatheringId}`),
    
  deduplicate: (data: {
    keepId: number;
    deleteIds: number[];
    mergeAssignments?: boolean;
  }) => 
    api.post('/individuals/deduplicate', data),
    
  getAttendanceHistory: (id: number) => 
    api.get(`/individuals/${id}/attendance-history`),
    
  getArchived: () => 
    api.get('/individuals/archived'),
};

// Reports API
export const reportsAPI = {
  getDashboard: (params?: { gatheringTypeId?: number; startDate?: string; endDate?: string }) => 
    api.get('/reports/dashboard', { params }),
  
  exportData: (params?: { gatheringTypeId?: number; startDate?: string; endDate?: string }) =>
    api.get('/reports/export', { params, responseType: 'blob' }),

  dismissAbsence: (data: { key: string; gatheringTypeIds: number[] }) =>
    api.post('/reports/dismiss-absence', data),

  getDismissals: (params: { gatheringTypeIds: number[] }) =>
    api.get('/reports/dismissals', { params }),
};

// Notifications API
export const notificationsAPI = {
  getAll: (params?: { limit?: number; offset?: number }) => 
    api.get('/notifications', { params }),
    
  markAsRead: (id: number) => 
    api.put(`/notifications/${id}/read`),
};

// Onboarding API
export const onboardingAPI = {
  getStatus: () => 
    api.get('/onboarding/status'),
    
  getCountries: () =>
    api.get('/onboarding/countries'),
    
  saveChurchInfo: (data: {
    churchName: string;
    countryCode: string;
    timezone?: string;
    emailFromName?: string;
    emailFromAddress?: string;
    locationName?: string;
    locationLat?: number;
    locationLng?: number;
  }) => 
    api.post('/onboarding/church-info', data),
    
  createGathering: (data: {
    name: string;
    description?: string;
    dayOfWeek: string;
    startTime: string;
    frequency: string;
    groupByFamily?: boolean;
  }) => 
    api.post('/onboarding/gathering', data),
    
  deleteGathering: (gatheringId: number) => 
    api.delete(`/onboarding/gathering/${gatheringId}`),
    
  uploadCSV: (gatheringId: number, file: File) => {
    const formData = new FormData();
    formData.append('csvFile', file);
    return api.post(`/onboarding/upload-csv/${gatheringId}`, formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
  },
    
  importPasteData: (gatheringId: number, data: string) => 
    api.post(`/onboarding/import-paste/${gatheringId}`, { data }),
    
  complete: () => 
    api.post('/onboarding/complete'),
    
  downloadTemplate: () => 
    api.get('/onboarding/csv-template', { responseType: 'blob' }),
    
  saveProgress: (currentStep: number, data?: any) =>
    api.post('/onboarding/save-progress', { currentStep, data }),

  loadSampleData: () =>
    api.post('/onboarding/sample-data'),

  clearSampleData: () =>
    api.post('/onboarding/clear-sample-data'),
};

// CSV Import API
export const csvImportAPI = {
  upload: (gatheringId: number, file: File) => {
    const formData = new FormData();
    formData.append('csvFile', file);
    return api.post(`/csv-import/upload/${gatheringId}`, formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
  },
    
  copyPaste: (data: string, gatheringId?: number) => 
    api.post(`/csv-import/copy-paste${gatheringId ? `/${gatheringId}` : ''}`, { data }),
    
  downloadTemplate: () => 
    api.get('/csv-import/template', { responseType: 'blob' }),
    
  massAssign: (gatheringId: number, individualIds: number[]) => 
    api.post(`/csv-import/mass-assign/${gatheringId}`, { individualIds }),
    
  massRemove: (gatheringId: number, individualIds: number[]) => 
    api.delete(`/csv-import/mass-remove/${gatheringId}`, { data: { individualIds } }),
    
  massUpdateType: (individualIds: number[], isVisitor: boolean) => 
    api.put('/csv-import/mass-update-type', { individualIds, isVisitor }),
    
  massUpdatePeopleType: (individualIds: number[], peopleType: 'regular' | 'local_visitor' | 'traveller_visitor') => 
    api.put('/csv-import/mass-update-people-type', { individualIds, peopleType }),
    
  updateExisting: (data: string) => 
    api.post('/csv-import/update-existing', { data }),
};

export const notificationRulesAPI = {
  getAll: () => api.get('/notification-rules'),
  create: (data: any) => api.post('/notification-rules', data),
  update: (id: number, data: any) => api.put(`/notification-rules/${id}`, data),
  remove: (id: number) => api.delete(`/notification-rules/${id}`),
};

// Settings API
export const settingsAPI = {
  getAll: () => api.get('/settings'),
  getBadgeDefaults: () => api.get('/settings/badge-defaults'),
  // DISABLED: External data access feature is currently disabled
  // getDataAccess: () => api.get('/settings/data-access'),
  // updateDataAccess: (enabled: boolean) => api.put('/settings/data-access', { enabled }),
  // Elvanto configuration
  getElvantoConfig: () => api.get('/settings/elvanto-config'),
  updateElvantoConfig: (data: {
    clientId: string;
    clientSecret?: string;
    redirectUri: string;
  }) => api.put('/settings/elvanto-config', data),
  // Location
  searchLocation: (q: string) => api.get('/settings/location-search', { params: { q } }),
  updateLocation: (data: { name: string; lat: number; lng: number }) => api.put('/settings/location', data),
  updateChildFlairColor: (color: string) => api.put('/settings/child-flair-color', { color }),
  updateDefaultBadge: (data: { text?: string; color?: string }) => api.put('/settings/default-badge', data),
  // Weekly review
  getWeeklyReview: () => api.get('/settings/weekly-review'),
  updateWeeklyReview: (data: { enabled?: boolean; day?: string | null; includeInsight?: boolean; caregiverAbsenceThreshold?: number }) =>
    api.put('/settings/weekly-review', data),
  sendTestWeeklyReview: () => api.post('/settings/weekly-review/test'),
  sendTestCaregiverDigest: () => api.post('/settings/caregiver-digest/test'),
  getIntegrationSettings: () => api.get('/settings/integrations'),
  updateIntegrationSettings: (data: { planningCenterSyncIndicator?: boolean; planningCenterAutoArchive?: boolean }) =>
    api.put('/settings/integrations', data),
};

// Integrations API
export const integrationsAPI = {
  // Elvanto integration - API Key based
  getElvantoStatus: () => api.get('/integrations/elvanto/status'),
  connectElvanto: (apiKey: string) => api.post('/integrations/elvanto/connect', { apiKey }),
  disconnectElvanto: () => api.post('/integrations/elvanto/disconnect'),
  // Elvanto data
  getElvantoPeople: (params?: { page?: number; per_page?: number; search?: string; include_family?: string }) =>
    api.get('/integrations/elvanto/people', { params }),
  getElvantoFamilies: (params?: { page?: number; per_page?: number; search?: string; include_archived?: string }) =>
    api.get('/integrations/elvanto/families', { params }),
  getElvantoGroups: (params?: { page?: number; per_page?: number; search?: string }) =>
    api.get('/integrations/elvanto/groups', { params }),
  getElvantoGroupInfo: (groupId: string) =>
    api.get(`/integrations/elvanto/groups/${groupId}`),
  getElvantoServices: (params?: { page?: number; per_page?: number }) =>
    api.get('/integrations/elvanto/services', { params }),
  importFromElvanto: (data: { peopleIds?: string[]; familyIds?: string[]; gatheringIds?: number[] }) =>
    api.post('/integrations/elvanto/import', data),
  checkGatheringDuplicates: (data: { groupIds?: string[]; serviceTypeIds?: string[] }) =>
    api.post('/integrations/elvanto/check-gathering-duplicates', data),
  importGatheringsFromElvanto: (data: { groupIds?: string[]; serviceTypeIds?: string[]; gatheringInfo?: Record<string, { name?: string; description?: string; dayOfWeek: string; startTime: string; frequency: string }>; nameOverrides?: Record<string, string> }) =>
    api.post('/integrations/elvanto/import-gatherings', data),
  // Debug - dump all available Elvanto data
  debugDumpElvanto: () => api.get('/integrations/elvanto/debug-dump'),

  // Planning Center integration - OAuth based
  getPlanningCenterStatus: () => api.get('/integrations/planning-center/status'),
  authorizePlanningCenter: () => api.get('/integrations/planning-center/authorize'),
  disconnectPlanningCenter: () => api.post('/integrations/planning-center/disconnect'),
  getPlanningCenterPeople: () => api.get('/integrations/planning-center/people'),
  getPlanningCenterCheckins: (params: { startDate: string; endDate: string }) =>
    api.get('/integrations/planning-center/checkins', { params }),
  linkPlanningCenterFamily: (data: { householdId: string; familyId: number }) => api.post('/integrations/planning-center/link-family', data),
  importPeopleFromPlanningCenter: (data?: { householdIds?: string[] }) => api.post('/integrations/planning-center/import-people', data || {}),
  importCheckinsFromPlanningCenter: (data: { startDate: string; endDate: string; eventId?: string }) =>
    api.post('/integrations/planning-center/import-checkins', data),

  // Historical CSV attendance backfill
  previewHistoricalCsv: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return api.post('/integrations/historical-csv-preview', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 60000,
    });
  },
  importHistoricalCsv: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return api.post('/integrations/historical-csv-execute', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 120000,
    });
  },
};

// AI Insights API
export const aiAPI = {
  getStatus: () => api.get('/ai/status'),
  configure: (data: { apiKey: string; provider: 'openai' | 'anthropic'; model?: string }) =>
    api.post('/ai/configure', data),
  disconnect: () => api.post('/ai/disconnect'),
  ask: (question: string, conversationId?: number | null) =>
    api.post('/ai/ask', { question, conversationId }, { timeout: 60000 }),

  // Chat history
  getConversations: () => api.get('/ai/conversations'),
  createConversation: (title?: string) => api.post('/ai/conversations', { title }),
  getMessages: (conversationId: number) => api.get(`/ai/conversations/${conversationId}/messages`),
  saveMessage: (conversationId: number, role: string, content: string) =>
    api.post(`/ai/conversations/${conversationId}/messages`, { role, content }),
  updateConversationTitle: (conversationId: number, title: string) =>
    api.put(`/ai/conversations/${conversationId}/title`, { title }),
  deleteConversation: (conversationId: number) => api.delete(`/ai/conversations/${conversationId}`),
};

// Visitor Configuration API
export const visitorConfigAPI = {
  getConfig: () => api.get('/visitor-config'),
  updateConfig: (config: { localVisitorServiceLimit: number; travellerVisitorServiceLimit: number }) => 
    api.put('/visitor-config', config)
};

// Takeout API (data export + account deletion)
export const takeoutAPI = {
  exportData: () => api.get('/takeout/export', { responseType: 'blob', timeout: 120000 }),
  deleteChurch: (confirmChurchName: string) => api.post('/takeout/delete', { confirmChurchName }),
};

export const contactsAPI = {
  getAll: () =>
    api.get('/contacts').then(r => r.data.contacts),

  create: (data: {
    first_name: string;
    last_name: string;
    email?: string;
    mobile_number?: string;
    primary_contact_method?: 'email' | 'sms';
    notes?: string;
  }) => api.post('/contacts', data).then(r => r.data.contact),

  update: (id: number, data: {
    first_name: string;
    last_name: string;
    email?: string;
    mobile_number?: string;
    primary_contact_method?: 'email' | 'sms';
    notes?: string;
  }) => api.put(`/contacts/${id}`, data).then(r => r.data.contact),

  delete: (id: number) =>
    api.delete(`/contacts/${id}`).then(r => r.data),

  getFamilies: (contactId: number) =>
    api.get(`/contacts/${contactId}/families`).then(r => r.data.families),

  assignFamily: (contactId: number, familyId: number) =>
    api.post(`/contacts/${contactId}/families/${familyId}`).then(r => r.data),

  unassignFamily: (contactId: number, familyId: number) =>
    api.delete(`/contacts/${contactId}/families/${familyId}`).then(r => r.data),

  convertToUser: (contactId: number, role: 'coordinator' | 'attendance_taker') =>
    api.post(`/contacts/${contactId}/convert-to-user`, { role }).then(r => r.data.user),
};

export default api;