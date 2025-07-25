import axios from 'axios';

// Use relative URL for API requests - this will work with any domain
const API_BASE_URL = '/api';

// Create axios instance
const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 10000,
  withCredentials: true, // Enable cookies to be sent with requests
  headers: {
    'Content-Type': 'application/json',
  },
});

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

// Response interceptor to handle token expiry
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('user');
      // Only redirect if we're not already on the login page
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
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
}

export interface Visitor {
  id?: number;
  name: string;
  visitorType: 'potential_regular' | 'temporary_other';
  visitorFamilyGroup?: string;
  notes?: string;
}

export interface AttendanceData {
  attendanceList: Individual[];
  visitors: Visitor[];
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
    
  refreshToken: () => 
    api.post('/auth/refresh'),
    
  logout: () => 
    api.post('/auth/logout'),
    
  setDefaultGathering: (gatheringId: number) =>
    api.post('/auth/set-default-gathering', { gatheringId }),
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
    email?: string;
    phone?: string;
  }) => 
    api.post('/individuals', data),
    
  update: (id: number, data: {
    firstName: string;
    lastName: string;
    familyId?: number;
    email?: string;
    phone?: string;
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
  getDashboard: (params?: { gatheringTypeId?: number; weeks?: number }) => 
    api.get('/reports/dashboard', { params }),
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
    
  downloadTemplate: () => 
    api.get('/csv-import/template', { responseType: 'blob' }),
};

export default api; 