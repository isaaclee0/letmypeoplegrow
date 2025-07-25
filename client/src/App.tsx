import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import LoginPage from './pages/LoginPage';
import SignupPage from './pages/SignupPage';
import DashboardPage from './pages/DashboardPage';
import AttendancePage from './pages/AttendancePage';
import ReportsPage from './pages/ReportsPage';
import ManageGatheringsPage from './pages/ManageGatheringsPage';
import PeoplePage from './pages/PeoplePage';
import OnboardingPage from './pages/OnboardingPage';
import AcceptInvitationPage from './pages/AcceptInvitationPage';
import FirstLoginSetupPage from './pages/FirstLoginSetupPage';
import NonAdminSetupPage from './pages/NonAdminSetupPage';
import Layout from './components/Layout';
import LoadingSpinner from './components/LoadingSpinner';

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

  return <>{children}</>;
};

// Public Route component (redirects to dashboard if authenticated)
const PublicRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return <LoadingSpinner />;
  }

  return !isAuthenticated ? <>{children}</> : <Navigate to="/app/dashboard" replace />;
};

function App() {
  return (
    <AuthProvider>
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
            </Route>
          </Routes>
        </div>
      </Router>
    </AuthProvider>
  );
}

export default App;
