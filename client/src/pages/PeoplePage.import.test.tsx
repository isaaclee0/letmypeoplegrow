import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ToastContainer from '../components/ToastContainer';
import type { AuthorityProvider } from '../components/peopleSync/types';
import type { PeopleImportReview } from '../components/peopleImport/types';
import {
  familiesAPI,
  integrationsAPI,
  gatheringsAPI,
  individualsAPI,
  peopleImportAPI,
  peopleSyncAPI,
  settingsAPI,
  visitorConfigAPI,
} from '../services/api';
import PeoplePage from './PeoplePage';

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => vi.unstubAllGlobals());

const authState = vi.hoisted(() => ({ role: 'admin' }));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 1,
      role: authState.role,
      firstName: 'Test',
      lastName: 'User',
      hasSampleData: false,
      gatheringAssignments: [],
      unreadNotifications: 0,
    },
    refreshUserData: vi.fn(),
  }),
}));

const review: PeopleImportReview = {
  operationKind: 'people_import',
  runId: 1,
  reviewToken: 'import-review-token' as PeopleImportReview['reviewToken'],
  selection: { kind: 'all' },
  snapshot: { fetchedAt: '2026-08-04T00:00:00.000Z', mode: 'full' },
  summary: {
    linkPeople: 0, linkFamilies: 0, addPeople: 1, addFamilies: 1, updateManagedFields: 0,
    promoteToRegular: 0, demoteToLocalVisitor: 0, archive: 0, reactivate: 0, moveFamily: 0,
    renameFamily: 0, addToGathering: 0, removeFromGathering: 0, ambiguousPeople: 0,
    familyConflicts: 0, unmatchedLocalRegulars: 0, skipped: 0,
  },
  plan: {
    operationKind: 'people_import', provider: 'planning_center', authoritative: false,
    snapshot: { fetchedAt: '2026-08-04T00:00:00.000Z', mode: 'full' },
    linkPeople: [], linkFamilies: [], addPeople: [], addFamilies: [], updateManagedFields: [],
    promoteToRegular: [], demoteToLocalVisitor: [], archive: [], reactivate: [], moveFamily: [],
    renameFamily: [], addToGathering: [], removeFromGathering: [], ambiguousPeople: [],
    familyConflicts: [], unmatchedLocalRegulars: [], skipped: [],
  },
};

function person(id: number) {
  return {
    id,
    firstName: 'Person',
    lastName: String(id),
    peopleType: 'regular' as const,
    isChild: false,
    badgeText: null,
    badgeColor: null,
    badgeIcon: null,
    externalLinks: {},
    pcoBackgroundCheckCleared: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    gatheringAssignments: [],
  };
}

function renderPeoplePage({
  role = 'admin',
  authorityProvider = 'none',
  peopleEditingLocked = authorityProvider !== 'none',
  people = [],
  entry = '/app/people',
}: {
  role?: string;
  authorityProvider?: AuthorityProvider;
  peopleEditingLocked?: boolean;
  people?: ReturnType<typeof person>[];
  entry?: string;
} = {}) {
  authState.role = role;
  vi.spyOn(individualsAPI, 'getAll').mockResolvedValue({ data: { people } } as never);
  vi.spyOn(individualsAPI, 'getArchived').mockResolvedValue({ data: { people: [] } } as never);
  vi.spyOn(familiesAPI, 'getAll').mockResolvedValue({
    data: { families: [], planningCenterTrackBackgroundChecks: false },
  } as never);
  vi.spyOn(gatheringsAPI, 'getAll').mockResolvedValue({ data: { gatherings: [] } } as never);
  vi.spyOn(peopleSyncAPI, 'getSettings').mockResolvedValue({
    data: { settings: { authorityProvider, peopleEditingLocked } },
  } as never);
  vi.spyOn(visitorConfigAPI, 'getConfig').mockResolvedValue({
    data: { localVisitorServiceLimit: 6, travellerVisitorServiceLimit: 2 },
  } as never);
  vi.spyOn(settingsAPI, 'getBadgeDefaults').mockResolvedValue({ data: { settings: {} } } as never);

  return render(
    <MemoryRouter initialEntries={[entry]}>
      <ToastContainer>
        <PeoplePage />
      </ToastContainer>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PeoplePage provider import', () => {
  it('resumes ongoing sync after OAuth even when one-time imports are locked', async () => {
    vi.spyOn(integrationsAPI, 'getPlanningCenterStatus').mockResolvedValue({ data: { connected: true } } as never);
    vi.spyOn(peopleSyncAPI, 'listSources').mockResolvedValue({ data: { sources: [] } } as never);
    renderPeoplePage({ authorityProvider: 'planning_center', peopleEditingLocked: true, entry: '/app/people?import=planning_center&mode=sync&pco=connected' });
    expect(await screen.findByRole('heading', { name: 'Keep people in sync with Planning Center' })).toBeInTheDocument();
    expect(await screen.findByLabelText('Runs automatically')).toBeChecked();
  });
  it('resumes source selection after Planning Center connects, without applying an import', async () => {
    vi.spyOn(peopleImportAPI, 'listSources').mockResolvedValue({ data: { sources: [], allOption: { kind: 'all', name: 'Everyone' } } } as never);
    const apply = vi.spyOn(peopleImportAPI, 'apply');
    renderPeoplePage({ entry: '/app/people?import=planning_center&pco=connected' });
    expect(await screen.findByRole('radio', { name: 'Everyone' })).toBeInTheDocument();
    expect(peopleImportAPI.listSources).toHaveBeenCalledWith('planning_center');
    expect(apply).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add people' }));
    await userEvent.click(screen.getByRole('tab', { name: 'Provider import / sync' }));
    expect(screen.getByText('Choose the provider to import people from.')).toBeInTheDocument();
  });

  it.each([
    { role: 'coordinator' },
    { authorityProvider: 'planning_center' as const, peopleEditingLocked: true },
  ])('keeps OAuth return subject to existing import access restrictions: %j', async (options) => {
    const listSources = vi.spyOn(peopleImportAPI, 'listSources');
    renderPeoplePage({ ...options, entry: '/app/people?import=planning_center&pco=connected' });
    await screen.findByRole('heading', { name: 'Manage People' });
    expect(screen.queryByRole('dialog', { name: 'Import people' })).not.toBeInTheDocument();
    expect(listSources).not.toHaveBeenCalled();
  });
  it.each([
    ['Add People', 'Add New People'],
    ['TSV Upload', 'Upload TSV File'],
    ['Copy & Paste', 'Copy & Paste Data'],
  ])('opens %s in the add modal', async (choice, heading) => {
    renderPeoplePage({ people: [person(1)] });
    await userEvent.click(await screen.findByRole('button', { name: 'Add people' }));
    await userEvent.click(screen.getByRole('tab', { name: choice }));
    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import or sync people' })).not.toBeInTheDocument();
  });

  it('keeps the people search field at a non-zooming mobile font size', async () => {
    renderPeoplePage({ people: [person(1)] });

    expect(await screen.findByRole('textbox', { name: 'Search People' })).toHaveClass('text-base', 'sm:text-sm');
  });

  it.each([
    ['empty locally managed roster', 'none', []],
    ['populated locally managed roster', 'none', [person(1)]],
    ['empty Planning Center-managed roster', 'planning_center', []],
    ['populated Planning Center-managed roster', 'planning_center', [person(1)]],
    ['empty Elvanto-managed roster', 'elvanto', []],
    ['populated Elvanto-managed roster', 'elvanto', [person(1)]],
  ] as const)('offers administrators an import action for an %s', async (_description, authorityProvider, people) => {
    renderPeoplePage({ authorityProvider, peopleEditingLocked: false, people: [...people] });

    await userEvent.click(await screen.findByRole('button', { name: 'Add people' }));
    expect(screen.getByRole('tab', { name: 'Provider import / sync' })).toBeEnabled();
  });

  it('offers sync but disables one-time import while managed-roster editing is locked', async () => {
    renderPeoplePage({ authorityProvider: 'planning_center', peopleEditingLocked: true, people: [person(1)] });

    await screen.findByRole('heading', { name: 'Manage People' });
    await userEvent.click(screen.getByRole('button', { name: 'Add people' }));
    await userEvent.click(screen.getByRole('tab', { name: 'Provider import / sync' }));
    expect(screen.getByRole('radio', { name: 'One-time import' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Keep in sync' })).toBeChecked();
  });

  it.each(['coordinator', 'attendance_taker'])('does not offer provider import to a %s', async (role) => {
    renderPeoplePage({ role, authorityProvider: 'none' });

    await screen.findByRole('heading', { name: 'Manage People' });
    await userEvent.click(screen.getByRole('button', { name: 'Add people' }));
    expect(screen.queryByRole('tab', { name: 'Provider import / sync' })).not.toBeInTheDocument();
  });

  it('keeps the manual tabs restricted to locally managed rosters', async () => {
    const { container } = renderPeoplePage({ authorityProvider: 'planning_center', people: [person(1)] });

    await screen.findByRole('heading', { name: 'Manage People' });
    await userEvent.click(screen.getByRole('button', { name: 'Add people' }));
    expect(screen.queryByRole('tab', { name: 'Add People' })).not.toBeInTheDocument();
  });

  it('refreshes people and families once and confirms success after an import applies', async () => {
    const user = userEvent.setup();
    renderPeoplePage({ authorityProvider: 'planning_center', peopleEditingLocked: false, people: [person(1)] });
    vi.spyOn(peopleImportAPI, 'listSources').mockResolvedValue({
      data: { success: true, allOption: { kind: 'all', name: 'Everyone' }, sources: [] },
    } as never);
    vi.spyOn(peopleImportAPI, 'preview').mockResolvedValue({ data: review } as never);
    vi.spyOn(peopleImportAPI, 'apply').mockResolvedValue({
      data: { runId: 1, status: 'applied', applied: {} as never, summary: review.summary },
    } as never);

    await user.click(await screen.findByRole('button', { name: 'Add people' }));
    await user.click(screen.getByRole('tab', { name: 'Provider import / sync' }));
    await user.click(screen.getByRole('button', { name: 'Planning Center' }));
    await user.click(await screen.findByRole('radio', { name: 'Everyone' }));
    await user.click(screen.getByRole('button', { name: 'Review import' }));
    let finishRefresh!: () => void;
    vi.mocked(individualsAPI.getAll).mockImplementationOnce(() => new Promise((resolve) => {
      finishRefresh = () => resolve({ data: { people: [person(1), person(2)] } } as never);
    }));
    await user.click(await screen.findByRole('button', { name: 'Apply import' }));

    await waitFor(() => expect(individualsAPI.getAll).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('dialog', { name: 'Add people' })).toBeInTheDocument();
    expect(screen.getByText('Import applied.')).toBeInTheDocument();
    await act(async () => finishRefresh());
    expect(screen.getByText('Import applied.')).toBeInTheDocument();
    expect(familiesAPI.getAll).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('People imported successfully.')).toBeInTheDocument();
  });
});
