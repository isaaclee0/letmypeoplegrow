import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ToastContainer from '../components/ToastContainer';
import type { AuthorityProvider } from '../components/peopleSync/types';
import type { PeopleImportReview } from '../components/peopleImport/types';
import {
  familiesAPI,
  gatheringsAPI,
  individualsAPI,
  peopleImportAPI,
  peopleSyncAPI,
  settingsAPI,
  visitorConfigAPI,
} from '../services/api';
import PeoplePage from './PeoplePage';

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
  people = [],
}: {
  role?: string;
  authorityProvider?: AuthorityProvider;
  people?: ReturnType<typeof person>[];
} = {}) {
  authState.role = role;
  vi.spyOn(individualsAPI, 'getAll').mockResolvedValue({ data: { people } } as never);
  vi.spyOn(individualsAPI, 'getArchived').mockResolvedValue({ data: { people: [] } } as never);
  vi.spyOn(familiesAPI, 'getAll').mockResolvedValue({
    data: { families: [], planningCenterTrackBackgroundChecks: false },
  } as never);
  vi.spyOn(gatheringsAPI, 'getAll').mockResolvedValue({ data: { gatherings: [] } } as never);
  vi.spyOn(peopleSyncAPI, 'getSettings').mockResolvedValue({
    data: { settings: { authorityProvider } },
  } as never);
  vi.spyOn(visitorConfigAPI, 'getConfig').mockResolvedValue({
    data: { localVisitorServiceLimit: 6, travellerVisitorServiceLimit: 2 },
  } as never);
  vi.spyOn(settingsAPI, 'getBadgeDefaults').mockResolvedValue({ data: { settings: {} } } as never);

  return render(
    <MemoryRouter initialEntries={['/app/people']}>
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
  it.each([
    ['empty locally managed roster', 'none', []],
    ['populated locally managed roster', 'none', [person(1)]],
    ['empty Planning Center-managed roster', 'planning_center', []],
    ['populated Planning Center-managed roster', 'planning_center', [person(1)]],
    ['empty Elvanto-managed roster', 'elvanto', []],
    ['populated Elvanto-managed roster', 'elvanto', [person(1)]],
  ] as const)('offers administrators an import action for an %s', async (_description, authorityProvider, people) => {
    renderPeoplePage({ authorityProvider, people: [...people] });

    expect(await screen.findByRole('button', { name: 'Import people' })).toBeEnabled();
  });

  it.each(['coordinator', 'attendance_taker'])('does not offer provider import to a %s', async (role) => {
    renderPeoplePage({ role, authorityProvider: 'none' });

    await screen.findByRole('heading', { name: 'Manage People' });
    expect(screen.queryByRole('button', { name: 'Import people' })).not.toBeInTheDocument();
  });

  it('keeps the floating manual-add button restricted to locally managed rosters', async () => {
    const { container } = renderPeoplePage({ authorityProvider: 'planning_center', people: [person(1)] });

    await screen.findByRole('heading', { name: 'Manage People' });
    expect(container.querySelector('button.fixed.bottom-4.right-4')).not.toBeInTheDocument();
  });

  it('refreshes people and families once and confirms success after an import applies', async () => {
    const user = userEvent.setup();
    renderPeoplePage({ authorityProvider: 'planning_center', people: [person(1)] });
    vi.spyOn(peopleImportAPI, 'listSources').mockResolvedValue({
      data: { success: true, allOption: { kind: 'all', name: 'Everyone' }, sources: [] },
    } as never);
    vi.spyOn(peopleImportAPI, 'preview').mockResolvedValue({ data: review } as never);
    vi.spyOn(peopleImportAPI, 'apply').mockResolvedValue({
      data: { runId: 1, status: 'applied', applied: {} as never, summary: review.summary },
    } as never);

    await user.click(await screen.findByRole('button', { name: 'Import people' }));
    await user.click(screen.getByRole('button', { name: 'Planning Center' }));
    await user.click(await screen.findByRole('radio', { name: 'Everyone' }));
    await user.click(screen.getByRole('button', { name: 'Review import' }));
    await user.click(await screen.findByRole('button', { name: 'Apply import' }));

    await waitFor(() => expect(individualsAPI.getAll).toHaveBeenCalledTimes(2));
    expect(familiesAPI.getAll).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('People imported successfully.')).toBeInTheDocument();
  });
});
