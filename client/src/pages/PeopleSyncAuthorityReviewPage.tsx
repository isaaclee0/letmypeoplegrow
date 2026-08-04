import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import AuthorityReviewWorkspace from '../components/peopleSync/AuthorityReviewWorkspace';
import type { SyncProvider } from '../components/peopleSync/types';
import { peopleSyncAPI } from '../services/api';

interface AuthorityReviewRouteConfig {
  provider: SyncProvider;
  label: string;
  returnTo: string;
}

const routeConfigs: Record<string, AuthorityReviewRouteConfig> = {
  'planning-center': {
    provider: 'planning_center',
    label: 'Planning Center',
    returnTo: '/app/settings?tab=integrations&integration=planning-center',
  },
  elvanto: {
    provider: 'elvanto',
    label: 'Elvanto',
    returnTo: '/app/settings?tab=integrations&integration=elvanto',
  },
};

const secondaryButtonClass = 'rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700';

export default function PeopleSyncAuthorityReviewPage() {
  const { provider: providerSlug } = useParams();
  const navigate = useNavigate();
  const config = routeConfigs[providerSlug || ''];
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (!config) navigate('/app/settings?tab=integrations', { replace: true });
  }, [config, navigate]);

  const returnToProvider = useCallback(() => {
    if (config) navigate(config.returnTo);
  }, [config, navigate]);

  const refreshAndReturn = useCallback(async () => {
    if (!config) return;
    await peopleSyncAPI.getSettings();
    navigate(config.returnTo);
  }, [config, navigate]);

  if (!config) return null;

  return (
    <section aria-label={`${config.label} first batch authority review`} className="space-y-5">
      {!confirmed ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-5 text-amber-950 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100">
          <h1 className="text-lg font-semibold">Review {config.label} as source of truth</h1>
          <div className="mt-3 space-y-2 text-sm">
            <p>
              This combined review will activate the prepared sync batch and make {config.label} the source of truth for regular people.
            </p>
            <p>
              Provider-managed people may be added, updated, archived, or reactivated when you apply the reviewed changes.
            </p>
            <p>
              The other provider stays connected, but only {config.label} sync batches can run while it is the source of truth.
            </p>
          </div>
          <div className="mt-5 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => setConfirmed(true)}
              className="rounded-md bg-green-600 px-3 py-2 text-sm font-medium text-white hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2"
            >
              Review and enable source of truth
            </button>
            <button type="button" onClick={returnToProvider} className={secondaryButtonClass}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <AuthorityReviewWorkspace
          provider={config.provider}
          autoStart
          onApplied={refreshAndReturn}
          onCancel={returnToProvider}
        />
      )}
    </section>
  );
}
