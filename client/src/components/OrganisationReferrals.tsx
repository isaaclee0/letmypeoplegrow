import React, { useCallback, useEffect, useRef, useState } from 'react';
import { referralsAPI, type OrganisationReferral } from '../services/api';

const statusLabels: Record<OrganisationReferral['status'], string> = {
  pre_approved: 'Pre-approved', registered: 'Signed up', expired: 'Expired',
  failed: 'Email failed', sending: 'Sending',
};

const OrganisationReferrals: React.FC = () => {
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [loading, setLoading] = useState(true);
  const [referrals, setReferrals] = useState<OrganisationReferral[]>([]);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setHistoryError('');
    try {
      const response = await referralsAPI.list();
      if (id === requestId.current) setReferrals(response.data.referrals);
    } catch {
      if (id === requestId.current) setHistoryError('Could not load referrals. Please try again.');
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => { requestId.current++; };
  }, [load]);

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    if (sending) return;
    setSending(true);
    setError('');
    setSuccess('');
    try {
      const response = await referralsAPI.send(email.trim());
      setSuccess(response.data.message);
      setEmail('');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Could not send the invitation. Please try again.');
    } finally {
      setSending(false);
      void load();
    }
  };

  return (
    <section className="max-w-2xl space-y-6" aria-labelledby="referrals-heading">
      <div>
        <h2 id="referrals-heading" className="text-lg font-medium text-gray-900 dark:text-gray-100">Refer an organisation</h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Know someone who could use Let My People Grow? Invite them to set up their own organisation.
          We’ll email them a signup link and pre-approve their organisation for 30 days.
        </p>
      </div>
      <form onSubmit={send} className="space-y-3">
        <label htmlFor="referral-email" className="block text-sm font-medium text-gray-700 dark:text-gray-300">Email address</label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input id="referral-email" type="email" required maxLength={254} value={email}
            onChange={event => setEmail(event.target.value)} disabled={sending}
            autoComplete="off" placeholder="name@example.com"
            className="min-w-0 flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100" />
          <button type="submit" disabled={sending || !email.trim()}
            className="rounded-md bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 disabled:opacity-50">
            {sending ? 'Sending…' : 'Send invitation'}
          </button>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400">They’ll sign up and verify this email address. Their organisation will have its own people and settings.</p>
      </form>
      {success && <p role="status" className="rounded-md bg-green-50 p-3 text-sm text-green-800 dark:bg-green-900/30 dark:text-green-300">{success}</p>}
      {error && <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">{error}</p>}
      <div>
        <h3 className="font-medium text-gray-900 dark:text-gray-100">Your organisation’s referrals</h3>
        {loading ? <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">Loading referrals…</p> : historyError ? (
          <div className="mt-3 text-sm">
            <p role="alert" className="text-red-700 dark:text-red-300">{historyError}</p>
            <button type="button" onClick={() => void load()} className="mt-2 font-medium text-primary-600 hover:underline">Retry</button>
          </div>
        ) : referrals.length === 0 ? <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">No referrals yet.</p> : (
          <ul className="mt-3 divide-y divide-gray-200 dark:divide-gray-700">
            {referrals.map(referral => (
              <li key={referral.id} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="break-all text-sm font-medium text-gray-900 dark:text-gray-100">{referral.email}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">Referred by {referral.referrer_name}</p>
                  {referral.status === 'pre_approved' && referral.expires_at && (
                    <p className="text-xs text-gray-500 dark:text-gray-400">Valid until {new Date(referral.expires_at.replace(' ', 'T') + 'Z').toLocaleDateString()}</p>
                  )}
                  {!!referral.delivery_failed && referral.status === 'pre_approved' && (
                    <p className="text-xs text-amber-700 dark:text-amber-300">Latest resend failed; the previous invitation is still valid.</p>
                  )}
                </div>
                <span className="text-sm text-gray-600 dark:text-gray-300">{statusLabels[referral.status]}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
};

export default OrganisationReferrals;
