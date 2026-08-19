import React from 'react';
import type { EngagementAxisStatus, EngagementSettingsDto } from '../../services/api';

interface EngagementTierBadgeProps {
  status: EngagementAxisStatus;
  settings: EngagementSettingsDto;
}

const EngagementTierBadge: React.FC<EngagementTierBadgeProps> = ({ status, settings }) => {
  if (status.status === 'establishing') {
    return <span className="inline-flex rounded-full bg-blue-100 px-2 py-1 text-xs font-medium text-blue-800">Establishing</span>;
  }
  if (status.status === 'not_assigned') {
    return <span className="inline-flex rounded-full bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700">Not assigned</span>;
  }
  const tier = settings.tiers[status.status];
  return (
    <span
      className="inline-flex rounded-full border px-2 py-1 text-xs font-medium"
      style={{ borderColor: tier.colour, color: tier.colour }}
    >
      {tier.label}
    </span>
  );
};

export default EngagementTierBadge;
