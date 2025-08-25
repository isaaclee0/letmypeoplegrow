import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { PWAUpdateProvider, usePWAUpdate } from './contexts/PWAUpdateContext';
import { WebSocketProvider } from './contexts/WebSocketContext';
import LoginPage from './pages/LoginPage';
import SignupPage from './pages/SignupPage';
import AttendancePage from './pages/AttendancePage';
import ReportsPage from './pages/ReportsPage';
import ManageGatheringsPage from './pages/ManageGatheringsPage';
import PeoplePage from './pages/PeoplePage';
import UsersPage from './pages/UsersPage';
// Retired: OnboardingPage
// Retired: AcceptInvitationPage, FirstLoginSetupPage, NonAdminSetupPage
import SettingsPage from './pages/SettingsPage';
import NotificationRulesPage from './pages/NotificationRulesPage';
import TokenClearPage from './pages/TokenClearPage';
import Layout from './components/Layout';
import ProfilePage from './pages/ProfilePage';
import WebSocketTestPage from './pages/WebSocketTestPage';
import LoadingSpinner from './components/LoadingSpinner';
import ToastContainer from './components/ToastContainer';
import PWAUpdateNotification from './components/PWAUpdateNotification';


// Protected Route component
const ProtectedRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, isLoading, /* needsOnboarding, */ user } = useAuth();

  if (isLoading) {
    return <LoadingSpinner />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  // Onboarding retired: no redirect

  // First-login setup retired; users can go directly to app

  // No dashboard page; attendance takers and others can navigate within app

  return <>{children}</>;
};

// Default App Route component
const DefaultAppRoute: React.FC = () => {
  const { user } = useAuth();
  const hasGatherings = user?.gatheringAssignments && user.gatheringAssignments.length > 0;
  const defaultRoute = hasGatherings ? '/app/attendance' : '/app/gatherings';
  return <Navigate to={defaultRoute} replace />;
};

// Role-based Protected Route component
const RoleProtectedRoute: React.FC<{ 
  children: React.ReactNode; 
  allowedRoles: string[];
}> = ({ children, allowedRoles }) => {
  const { user } = useAuth();

  if (!user || !allowedRoles.includes(user.role)) {
    return <Navigate to="/app/attendance" replace />;
  }

  return <>{children}</>;
};

// Public Route component (redirects based on user role if authenticated)
const PublicRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, isLoading, user } = useAuth();

  if (isLoading) {
    return <LoadingSpinner />;
  }

  if (isAuthenticated && user) {
    // Check if user has any gathering assignments
    const hasGatherings = user.gatheringAssignments && user.gatheringAssignments.length > 0;
    
    // Redirect to gatherings page if no gatherings, otherwise attendance
    const defaultRoute = hasGatherings ? '/app/attendance' : '/app/gatherings';
    return <Navigate to={defaultRoute} replace />;
  }

  return <>{children}</>;
};

// PWA Update Notification Component
const PWAUpdateWrapper: React.FC = () => {
  const { showUpdateNotification, performUpdate } = usePWAUpdate();
  
  return (
    <>
      {showUpdateNotification && (
        <PWAUpdateNotification
          onUpdate={performUpdate}
        />
      )}
    </>
  );
};

function App() {
  return (
    <AuthProvider>
      <WebSocketProvider>
        <PWAUpdateProvider>
          <ToastContainer>
            <Router>
            <div className="min-h-screen bg-gray-50">
              <Routes>
                <Route
                  path="/signup"
                  element={
                    <PublicRoute>
                      <SignupPage />
                    </PublicRoute>
                  }
                />
                <Route
                  path="/login"
                  element={
                    <PublicRoute>
                      <LoginPage />
                    </PublicRoute>
                  }
                />
                {/* Onboarding route retired */}
                {/* Retired routes: first-login-setup, non-admin-setup, accept-invitation */}
                <Route
                  path="/clear-token"
                  element={<TokenClearPage />}
                />
                <Route
                  path="/websocket-test"
                  element={
                    <ProtectedRoute>
                      <WebSocketTestPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/"
                  element={<Navigate to="/login" replace />}
                />
                <Route
                  path="/app"
                  element={
                    <ProtectedRoute>
                      <Layout />
                    </ProtectedRoute>
                  }
                >
                  <Route index element={
                    <ProtectedRoute>
                      <DefaultAppRoute />
                    </ProtectedRoute>
                  } />
                  <Route path="attendance" element={<AttendancePage />} />
                  <Route path="people" element={<PeoplePage />} />
                  <Route path="gatherings" element={<ManageGatheringsPage />} />
                  <Route path="reports" element={<ReportsPage />} />
                  <Route 
                    path="users" 
                    element={
                      <RoleProtectedRoute allowedRoles={['admin', 'coordinator']}>
                        <UsersPage />
                      </RoleProtectedRoute>
                    } 
                  />
                  {/* Advanced Migrations removed */}
                  <Route path="settings" element={<SettingsPage />} />
                  <Route path="profile" element={<ProfilePage />} />
                  <Route path="websocket-test" element={<WebSocketTestPage />} />
                  <Route path="notification-rules" element={
                    <RoleProtectedRoute allowedRoles={['admin', 'coordinator']}>
                      <NotificationRulesPage />
                    </RoleProtectedRoute>
                  } />
                </Route>
              </Routes>
            </div>
            <PWAUpdateWrapper />
          </Router>
        </ToastContainer>
      </PWAUpdateProvider>
    </WebSocketProvider>
  </AuthProvider>
  );
}

export default App;
