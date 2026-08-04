import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import OnboardingPeopleImport from './OnboardingPeopleImport';
import { peopleImportAPI } from '../../services/api';
import type { PeopleImportReview, ImportSelection } from './types';
import type { SyncProvider } from '../peopleSync/types';

vi.mock('../../services/api', () => ({
  peopleImportAPI: { listSources: vi.fn(), preview: vi.fn(), apply: vi.fn() },
}));

function reviewFor(provider: SyncProvider, selection: ImportSelection): PeopleImportReview {
  return {
    operationKind: 'people_import',
    runId: 14,
    reviewToken: 'onboarding-import-review' as PeopleImportReview['reviewToken'],
    selection,
    snapshot: { fetchedAt: '2026-08-04T00:00:00.000Z', mode: 'full' },
    summary: {
      linkPeople: 0, linkFamilies: 0, addPeople: 0, addFamilies: 0, updateManagedFields: 0,
      promoteToRegular: 0, demoteToLocalVisitor: 0, archive: 0, reactivate: 0, moveFamily: 0,
      renameFamily: 0, addToGathering: 0, removeFromGathering: 0, ambiguousPeople: 0,
      familyConflicts: 0, unmatchedLocalRegulars: 0, skipped: 0,
    },
    plan: {
      operationKind: 'people_import', provider, authoritative: false,
      snapshot: { fetchedAt: '2026-08-04T00:00:00.000Z', mode: 'full' },
      linkPeople: [], linkFamilies: [], addPeople: [], addFamilies: [], updateManagedFields: [],
      promoteToRegular: [], demoteToLocalVisitor: [], archive: [], reactivate: [], moveFamily: [],
      renameFamily: [], addToGathering: [], removeFromGathering: [], ambiguousPeople: [],
      familyConflicts: [], unmatchedLocalRegulars: [], skipped: [],
    },
  };
}

describe('OnboardingPeopleImport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(peopleImportAPI.apply).mockImplementation(async (provider, request) => ({
      data: {
        runId: 14,
        status: 'applied' as const,
        applied: {} as never,
        summary: reviewFor(provider, request.selection).summary,
      },
    } as never));
  });

  it('previews and applies a selected Planning Center List before continuing', async () => {
    const selection = { kind: 'planning_center_list' as const, externalId: 'list-members' };
    vi.mocked(peopleImportAPI.listSources).mockResolvedValue({ data: {
      success: true,
      allOption: { kind: 'all', name: 'Everyone' },
      sources: [{
        kind: 'planning_center_list', externalId: 'list-members', name: 'Members',
        memberCount: 28, providerRefreshedAt: null,
      }],
    } } as never);
    vi.mocked(peopleImportAPI.preview).mockResolvedValue({ data: reviewFor('planning_center', selection) } as never);
    const onComplete = vi.fn();

    render(<OnboardingPeopleImport provider="planning_center" onComplete={onComplete} onSkip={vi.fn()} />);

    expect(await screen.findByRole('radio', { name: 'Everyone' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /Members/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Review import' }));
    expect(await screen.findByRole('button', { name: 'Apply import' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply import' }));

    await waitFor(() => expect(peopleImportAPI.preview).toHaveBeenCalledWith('planning_center', selection));
    await waitFor(() => expect(peopleImportAPI.apply).toHaveBeenCalledWith('planning_center', {
      selection,
      reviewToken: 'onboarding-import-review',
      selections: {
        acceptArchiveIndividualIds: [],
        acceptFamilyRenameIds: [],
        ambiguous: {},
        skipExternalPersonIds: [],
        visitorChoices: {},
      },
    }));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });

  it.each([
    ['Category', { kind: 'elvanto_category' as const, externalId: 'category-adults' }, /Adults/],
    ['Group', { kind: 'elvanto_group' as const, externalId: 'group-youth' }, /Youth/],
    ['Everyone', { kind: 'all' as const }, 'Everyone'],
  ])('previews the selected Elvanto %s without schedule or authority setup', async (_label, selection, accessibleName) => {
    vi.mocked(peopleImportAPI.listSources).mockResolvedValue({ data: {
      success: true,
      allOption: { kind: 'all', name: 'Everyone' },
      sources: [
        { kind: 'elvanto_category', externalId: 'category-adults', name: 'Adults', memberCount: 40, providerRefreshedAt: null },
        { kind: 'elvanto_group', externalId: 'group-youth', name: 'Youth', memberCount: 12, providerRefreshedAt: null },
      ],
    } } as never);
    vi.mocked(peopleImportAPI.preview).mockResolvedValue({ data: reviewFor('elvanto', selection) } as never);

    render(<OnboardingPeopleImport provider="elvanto" onComplete={vi.fn()} onSkip={vi.fn()} />);

    fireEvent.click(await screen.findByRole('radio', { name: accessibleName }));
    fireEvent.click(screen.getByRole('button', { name: 'Review import' }));

    await waitFor(() => expect(peopleImportAPI.preview).toHaveBeenCalledWith('elvanto', selection));
    expect(screen.queryByText(/source of truth/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/schedule/i)).not.toBeInTheDocument();
  });

  it('keeps skip available before a source is selected', async () => {
    vi.mocked(peopleImportAPI.listSources).mockResolvedValue({ data: {
      success: true, allOption: { kind: 'all', name: 'Everyone' }, sources: [],
    } } as never);
    const onSkip = vi.fn();
    render(<OnboardingPeopleImport provider="planning_center" onComplete={vi.fn()} onSkip={onSkip} />);

    await screen.findByRole('radio', { name: 'Everyone' });
    fireEvent.click(screen.getByRole('button', { name: 'Skip people import' }));

    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(peopleImportAPI.preview).not.toHaveBeenCalled();
    expect(peopleImportAPI.apply).not.toHaveBeenCalled();
  });

  it('stays on the import review when apply is stale', async () => {
    const selection = { kind: 'all' as const };
    vi.mocked(peopleImportAPI.listSources).mockResolvedValue({ data: {
      success: true, allOption: { kind: 'all', name: 'Everyone' }, sources: [],
    } } as never);
    vi.mocked(peopleImportAPI.preview).mockResolvedValue({ data: reviewFor('elvanto', selection) } as never);
    vi.mocked(peopleImportAPI.apply).mockRejectedValue({
      response: { data: { code: 'SYNC_PLAN_STALE', error: 'This import review is stale.' } },
    });
    const onComplete = vi.fn();
    render(<OnboardingPeopleImport provider="elvanto" onComplete={onComplete} onSkip={vi.fn()} />);

    fireEvent.click(await screen.findByRole('radio', { name: 'Everyone' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review import' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply import' }));

    expect(await screen.findByText('This import review is out of date.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Refresh plan' }).length).toBeGreaterThan(0);
    expect(onComplete).not.toHaveBeenCalled();
  });
});
