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
          
          // Clear user data and redirect to login
          localStorage.removeItem('user');
          if (window.location.pathname !== '/login') {
            console.log('➡️ Redirecting to login due to refresh failure');
            window.location.href = '/login';
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
  isFirstLogin?: boolean;
  defaultGatheringId?: number;
  church_id?: string;
  gatheringAssignments: GatheringType[];
  unreadNotifications?: number;
}

export interface GatheringType {
  id: number;
  name: string;
  description?: string;
  dayOfWeek: string;
  startTime: string;
  durationMinutes: number;
  frequency: string;
  isActive: boolean;
  memberCount?: number;
  createdAt?: string;
}

export interface Individual {
  id: number;
  firstName: string;
  lastName: string;
  familyId?: number;
  familyName?: string;
  present?: boolean;
  isVisitor?: boolean;
  isSaving?: boolean;
}

export interface Visitor {
  id?: number;
  name: string;
  visitorType: 'potential_regular' | 'temporary_other';
  visitorFamilyGroup?: string;
  notes?: string;
  lastAttended?: string;
  familyId?: number;
  familyName?: string;
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
  requestCode: (contact: string) => 
    api.post('/auth/request-code', { contact }),
    
  verifyCode: (contact: string, code: string) => 
    api.post('/auth/verify-code', { contact, code }),
    

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
};

// Gatherings API
export const gatheringsAPI = {
  getAll: () => 
    api.get('/gatherings'),
    
  create: (data: {
    name: string;
    description?: string;
    dayOfWeek: string;
    startTime: string;
    durationMinutes: number;
    frequency: string;
    setAsDefault?: boolean;
  }) => 
    api.post('/gatherings', data),
    
  update: (gatheringId: number, data: {
    name: string;
    description?: string;
    dayOfWeek: string;
    startTime: string;
    durationMinutes: number;
    frequency: string;
  }) => 
    api.put(`/gatherings/${gatheringId}`, data),
    
  getMembers: (gatheringId: number) => 
    api.get(`/gatherings/${gatheringId}/members`),
    
  delete: (gatheringId: number) => 
    api.delete(`/gatherings/${gatheringId}`),
};

// Attendance API
export const attendanceAPI = {
  get: (gatheringTypeId: number, date: string) => 
    api.get(`/attendance/${gatheringTypeId}/${date}`),
    
  record: (gatheringTypeId: number, date: string, data: {
    attendanceRecords: Array<{ individualId: number; present: boolean }>;
    visitors: Visitor[];
  }) => 
    api.post(`/attendance/${gatheringTypeId}/${date}`, data),
    
  getRecentVisitors: (gatheringTypeId: number) => 
    api.get(`/attendance/${gatheringTypeId}/visitors/recent`),
    
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
};

// Migrations API
export const migrationsAPI = {
  getStatus: () => 
    api.get('/migrations/status'),
    
  runMigration: (version: string) => 
    api.post(`/migrations/run/${version}`),
    
  runAllMigrations: () => 
    api.post('/migrations/run-all'),
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
    
  create: (data: { familyName: string; familyIdentifier?: string }) => 
    api.post('/families', data),
};

// Individuals API
export const individualsAPI = {
  getAll: () => 
    api.get('/individuals'),
    
  create: (data: {
    firstName: string;
    lastName: string;
    familyId?: number;
  }) => 
    api.post('/individuals', data),
    
  update: (id: number, data: {
    firstName: string;
    lastName: string;
    familyId?: number;
  }) => 
    api.put(`/individuals/${id}`, data),
    
  delete: (id: number) => 
    api.delete(`/individuals/${id}`),
    
  assignToGathering: (individualId: number, gatheringId: number) => 
    api.post(`/individuals/${individualId}/gatherings/${gatheringId}`),
    
  unassignFromGathering: (individualId: number, gatheringId: number) => 
    api.delete(`/individuals/${individualId}/gatherings/${gatheringId}`),
};

// Reports API
export const reportsAPI = {
  getDashboard: (params?: { gatheringTypeId?: number; startDate?: string; endDate?: string }) => 
    api.get('/reports/dashboard', { params }),
  
  exportData: (params?: { gatheringTypeId?: number; startDate?: string; endDate?: string }) => 
    api.get('/reports/export', { params, responseType: 'blob' }),
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
  }) => 
    api.post('/onboarding/church-info', data),
    
  createGathering: (data: {
    name: string;
    description?: string;
    dayOfWeek: string;
    startTime: string;
    durationMinutes: number;
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
  getDataAccess: () => api.get('/settings/data-access'),
  updateDataAccess: (enabled: boolean) => api.put('/settings/data-access', { enabled }),
};

export default api; 