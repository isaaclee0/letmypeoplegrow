import React from 'react';
import { LockClosedIcon } from '@heroicons/react/24/outline';

export interface GatheringSyncSource {
  provider: 'planning_center' | 'elvanto';
  sourceName: string;
  sourceKind: string;
  membershipMode: 'aligned' | 'add_only';
}

export default function GatheringSourceBadge({ sources = [] }: { sources?: GatheringSyncSource[] }) {
  if (!sources.length) return null;
  return <div className="mb-3 space-y-1 rounded-md bg-blue-50 p-3 text-xs text-blue-900 dark:bg-blue-950 dark:text-blue-100">
    {sources.map((source, index) => <p key={index} className="flex items-start gap-2">
      <LockClosedIcon aria-hidden="true" className="h-4 w-4 shrink-0" />
      <span>{source.provider === 'planning_center' ? 'Planning Center' : 'Elvanto'} · {source.sourceName} — {source.membershipMode === 'aligned' ? 'membership controlled by provider' : 'adds people only'}</span>
    </p>)}
    <p>Manage synced members in the connected list or group. Changes take effect when sync runs. Manually added members and attendance history stay in LMPG.</p>
  </div>;
}
