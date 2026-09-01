import React from 'react';
import type { EngagementOverviewDto, EngagementTierKey } from '../../services/api';

interface EngagementMatrixProps {
  matrix: EngagementOverviewDto['matrix'];
  labels: Record<EngagementTierKey, string>;
  onOpen: (token: string, title: string) => void;
  panel?: React.ReactNode;
}

const TIERS: EngagementTierKey[] = ['core', 'casual', 'irregular'];

const EngagementMatrix: React.FC<EngagementMatrixProps> = ({ matrix, labels, onOpen, panel }) => (
  <section className="rounded-lg bg-white p-5 shadow dark:bg-gray-800" aria-labelledby="engagement-matrix-heading">
    <h2 id="engagement-matrix-heading" className="text-lg font-semibold text-gray-900 dark:text-gray-100">
      Primary × Community
    </h2>
    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
      {matrix.classifiedOnBothAxes} people are classified on both axes.
    </p>
    <div className="mt-4 overflow-x-auto">
      <table className="min-w-full border-collapse text-sm">
        <caption className="sr-only">Primary tiers by Community tiers</caption>
        <thead>
          <tr><th className="p-2 text-left text-gray-900 dark:text-gray-100">Primary \ Community</th>{TIERS.map((tier) => <th key={tier} className="p-2 text-gray-900 dark:text-gray-100">{labels[tier]}</th>)}</tr>
        </thead>
        <tbody>
          {TIERS.map((primaryTier) => (
            <tr key={primaryTier}>
              <th className="p-2 text-left text-gray-900 dark:text-gray-100">{labels[primaryTier]}</th>
              {TIERS.map((communityTier) => {
                const cell = matrix.cells.find((item) => item.primaryTier === primaryTier && item.communityTier === communityTier);
                const count = cell?.count || 0;
                const description = `${labels[primaryTier]} Primary, ${labels[communityTier]} Community: ${count} ${count === 1 ? 'person' : 'people'}`;
                return (
                  <td key={communityTier} className="border border-gray-200 p-2 text-center dark:border-gray-700" aria-label={description}>
                    {cell?.peopleToken ? (
                      <button type="button" className="min-h-10 min-w-10 rounded font-semibold text-gray-900 hover:bg-gray-100 dark:text-gray-100 dark:hover:bg-gray-700" onClick={() => onOpen(cell.peopleToken, `${labels[primaryTier]} Primary / ${labels[communityTier]} Community`)}>
                        {count}
                      </button>
                    ) : count}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    <dl className="mt-4 grid gap-2 text-sm text-gray-700 dark:text-gray-300 sm:grid-cols-2">
      <div><dt className="inline font-medium">Primary Establishing:</dt> <dd className="inline">{matrix.outside.primaryEstablishing}</dd></div>
      <div><dt className="inline font-medium">Primary Not assigned:</dt> <dd className="inline">{matrix.outside.primaryNotAssigned}</dd></div>
      <div><dt className="inline font-medium">Community Establishing:</dt> <dd className="inline">{matrix.outside.communityEstablishing}</dd></div>
      <div><dt className="inline font-medium">Community Not assigned:</dt> <dd className="inline">{matrix.outside.communityNotAssigned}</dd></div>
    </dl>
    {panel}
  </section>
);

export default EngagementMatrix;
