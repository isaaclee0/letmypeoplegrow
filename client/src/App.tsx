import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { MigrationProvider } from './contexts/MigrationContext';
import { DebugProvider } from './contexts/DebugContext';
import LoginPage from './pages/LoginPage';
import SignupPage from './pages/SignupPage';
import DashboardPage from './pages/DashboardPage';
import AttendancePage from './pages/AttendancePage';
import ReportsPage from './pages/ReportsPage';
import ManageGatheringsPage from './pages/ManageGatheringsPage';
import PeoplePage from './pages/PeoplePage';
import UsersPage from './pages/UsersPage';
import MigrationsPage from './pages/MigrationsPage';
import OnboardingPage from './pages/OnboardingPage';
import AcceptInvitationPage from './pages/AcceptInvitationPage';
import FirstLoginSetupPage from './pages/FirstLoginSetupPage';
import NonAdminSetupPage from './pages/NonAdminSetupPage';
import SettingsPage from './pages/SettingsPage';
import Layout from './components/Layout';
import LoadingSpinner from './components/LoadingSpinner';
import ToastContainer from './components/ToastContainer';

// Protected Route component
const ProtectedRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, isLoading, needsOnboarding, user } = useAuth();

  if (isLoading) {
    return <LoadingSpinner />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  // Redirect admin users to onboarding if needed
  if (user?.role === 'admin' && needsOnboarding && window.location.pathname !== '/onboarding') {
    return <Navigate to="/onboarding" replace />;
  }

  // Redirect first-time users to appropriate setup
  if (user?.isFirstLogin) {
    if (user.role === 'admin' && needsOnboarding && window.location.pathname !== '/onboarding') {
      return <Navigate to="/onboarding" replace />;
    } else if (user.role !== 'admin' && window.location.pathname !== '/first-login-setup' && window.location.pathname !== '/non-admin-setup') {
      // Check if user has gathering assignments
      if (user.gatheringAssignments && user.gatheringAssignments.length > 0) {
        return <Navigate to="/first-login-setup" replace />;
      } else {
        return <Navigate to="/non-admin-setup" replace />;
      }
    }
  }

  // Redirect attendance takers directly to attendance page
  if (user?.role === 'attendance_taker' && window.location.pathname === '/app/dashboard') {
    return <Navigate to="/app/attendance" replace />;
  }

  return <>{children}</>;
};

// Role-based Protected Route component
const RoleProtectedRoute: React.FC<{ 
  children: React.ReactNode; 
  allowedRoles: string[];
}> = ({ children, allowedRoles }) => {
  const { user } = useAuth();

  if (!user || !allowedRoles.includes(user.role)) {
    return <Navigate to="/app/dashboard" replace />;
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
    // Redirect based on user role
    if (user.role === 'attendance_taker') {
      return <Navigate to="/app/attendance" replace />;
    } else {
      return <Navigate to="/app/dashboard" replace />;
    }
  }

  return <>{children}</>;
};

function App() {
  return (
    <AuthProvider>
      <MigrationProvider>
        <DebugProvider>
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
            <Route
              path="/onboarding"
              element={
                <ProtectedRoute>
                  <OnboardingPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/first-login-setup"
              element={
                <ProtectedRoute>
                  <FirstLoginSetupPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/non-admin-setup"
              element={
                <ProtectedRoute>
                  <NonAdminSetupPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/accept-invitation/:token"
              element={<AcceptInvitationPage />}
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
              <Route index element={<Navigate to="/app/dashboard" replace />} />
              <Route path="dashboard" element={<DashboardPage />} />
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
              <Route 
                path="migrations" 
                element={
                  <RoleProtectedRoute allowedRoles={['admin']}>
                    <MigrationsPage />
                  </RoleProtectedRoute>
                } 
              />
              <Route path="settings" element={<SettingsPage />} />
            </Route>
          </Routes>
        </div>
      </Router>
        </ToastContainer>
        </DebugProvider>
      </MigrationProvider>
    </AuthProvider>
  );
}

export default App;
