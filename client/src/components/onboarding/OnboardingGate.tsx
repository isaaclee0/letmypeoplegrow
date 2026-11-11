import React, { useEffect, useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { onboardingAPI } from '../../services/api';
import LoadingSpinner from '../LoadingSpinner';

/** Wait for authoritative setup state before mounting the ordinary application. */
export default function OnboardingGate({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const location = useLocation();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; required?: boolean; error?: boolean } | null>(null);
  // Recheck when entering/leaving setup, without remounting the whole app on
  // every normal page or query-string change.
  const key = `${user?.church_id}:${user?.id}:${location.pathname === '/app/onboarding' ? 'setup' : 'app'}:${attempt}`;
  const isAdmin = user?.role === 'admin';

  useEffect(() => {
    if (!isAdmin) return;
    let active = true;
    onboardingAPI.getStatus().then(response => {
      if (active) setResult({ key, required: response.data.guided?.required === true });
    }).catch(() => {
      if (active) setResult({ key, error: true });
    });
    return () => { active = false; };
  }, [key, isAdmin]);

  if (!isAdmin) return <>{children}</>;
  if (result?.key !== key) return <LoadingSpinner />;
  if (result.error) return <div className="mx-auto max-w-md p-8 text-center">
    <p role="alert" className="mb-4 text-gray-700 dark:text-gray-200">We couldn't check your setup progress. Please try again.</p>
    <button type="button" className="rounded-md bg-primary-600 px-4 py-2 text-white" onClick={() => setAttempt(value => value + 1)}>Try again</button>
  </div>;

  const setupPage = location.pathname === '/app/onboarding';
  const reviewPage = /^\/app\/settings\/integrations\/(planning-center|elvanto)\/(authority-review|review|batches\/\d+\/review)$/.test(location.pathname);
  const params = new URLSearchParams(location.search);
  const integrationPage = location.pathname === '/app/settings' && params.get('tab') === 'integrations'
    && ['planning-center', 'elvanto'].includes(params.get('integration') ?? '');
  const invitationPage = location.pathname === '/app/users' && params.get('onboarding') === '1';
  if (result.required && !setupPage && !reviewPage && !integrationPage && !invitationPage) return <Navigate to="/app/onboarding" replace />;
  return <>{result.required && !setupPage && <div className="border-b border-primary-200 bg-primary-50 px-4 py-3 text-center text-sm dark:bg-gray-800">
    <Link to="/app/onboarding" className="font-medium text-primary-700 underline dark:text-primary-300">Return to setup</Link>
  </div>}{children}</>;
}
