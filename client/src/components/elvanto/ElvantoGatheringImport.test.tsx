import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { integrationsAPI } from '../../services/api';
import ElvantoGatheringImport from './ElvantoGatheringImport';

vi.mock('../../services/api', () => ({
  integrationsAPI: {
    getElvantoGroups: vi.fn(),
    getElvantoServices: vi.fn(),
    checkGatheringDuplicates: vi.fn(),
    importGatheringsFromElvanto: vi.fn(),
  },
}));

describe('ElvantoGatheringImport', () => {
  beforeEach(() => vi.clearAllMocks());

  it('normalizes singleton group and service collections returned by Elvanto', async () => {
    vi.mocked(integrationsAPI.getElvantoGroups).mockResolvedValue({
      data: { groups: { group: { id: 'g-1', name: 'Youth Group' } } },
    });
    vi.mocked(integrationsAPI.getElvantoServices).mockResolvedValue({
      data: { services: { service: { id: 's-1', service_type: { id: 'st-1', name: 'Sunday Service' } } } },
    });

    render(<ElvantoGatheringImport connected />);

    expect(await screen.findByRole('checkbox', { name: 'Youth Group' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Sunday Service (1)' })).toBeInTheDocument();
  });
});
