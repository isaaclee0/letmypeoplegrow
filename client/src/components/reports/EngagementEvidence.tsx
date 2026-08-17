import React from 'react';
import type { EngagementAxisStatus } from '../../services/api';

export function percentage(rate: number): number {
  return Math.round(rate * 100);
}

const EngagementEvidence: React.FC<{ status: EngagementAxisStatus }> = ({ status }) => {
  if (status.status === 'not_assigned') return <span>Not assigned</span>;
  if (status.status === 'establishing' && status.rate === null) {
    return <span>{status.attended} of {status.opportunities} opportunities — Establishing</span>;
  }
  return (
    <span>
      {status.attended} of {status.opportunities} opportunities ({percentage(status.rate || 0)}%)
    </span>
  );
};

export default EngagementEvidence;
