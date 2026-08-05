import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ToastContainer from '../components/ToastContainer';
import type { AuthorityProvider, ExternalLinks } from '../components/peopleSync/types';
import {
  familiesAPI,
  gatheringsAPI,
  individualsAPI,
  peopleSyncAPI,
  settingsAPI,
  visitorConfigAPI,
} from '../services/api';
import PeoplePage from './PeoplePage';

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 1,
      role: 'admin',
      firstName: 'Admin',
      lastName: 'User',
      hasSampleData: false,
      gatheringAssignments: [],
      unreadNotifications: 0,
    },
    refreshUserData: vi.fn(),
  }),
}));

interface TestPerson {
  id: number;
  firstName: string;
  lastName: string;
  peopleType: 'regular' | 'local_visitor' | 'traveller_visitor';
  isChild: boolean;
  badgeText: string | null;
  badgeColor: string | null;
  badgeIcon: string | null;
  familyId?: number;
  familyName?: string;
  planningCenterId?: string;
  externalLinks?: ExternalLinks;
  pcoBackgroundCheckCleared: boolean | null;
  lastAttendanceDate?: string;
  createdAt: string;
  gatheringAssignments: Array<{ id: number; name: string }>;
}

function person(id: number, overrides: Partial<TestPerson> = {}): TestPerson {
  return {
    id,
    firstName: 'Person',
    lastName: String(id),
    peopleType: 'regular',
    isChild: false,
    badgeText: null,
    badgeColor: null,
    badgeIcon: null,
    externalLinks: {},
    pcoBackgroundCheckCleared: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    gatheringAssignments: [],
    ...overrides,
  };
}

function renderPeoplePage({
  authorityProvider,
  people,
  initialEntry = '/app/people',
}: {
  authorityProvider: AuthorityProvider;
  people: TestPerson[];
  initialEntry?: string;
}) {
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
    <MemoryRouter initialEntries={[initialEntry]}>
      <ToastContainer>
        <PeoplePage />
      </ToastContainer>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PeoplePage external source filter', () => {
  it.each([
    ['planning_center', { planning_center: 'pco-1' }, 'PCO'],
    ['elvanto', { elvanto: 'elv-1' }, 'ELV'],
  ] as const)('does not show a %s badge on managed person tiles', async (authorityProvider, externalLinks, label) => {
    renderPeoplePage({
      authorityProvider,
      people: [person(1, { externalLinks })],
    });

    expect(await screen.findByText('Person 1')).toBeInTheDocument();
    expect(screen.queryByText(label)).not.toBeInTheDocument();
  });

  it('matches a link only for the active provider', async () => {
    const peoplePageModule = await import('./PeoplePage') as Record<string, unknown>;
    const matchesExternalSourceFilter = peoplePageModule.matchesExternalSourceFilter as
      | ((person: Pick<TestPerson, 'externalLinks'>, provider: AuthorityProvider, filter: 'all' | 'linked' | 'unlinked') => boolean)
      | undefined;

    expect(matchesExternalSourceFilter).toBeTypeOf('function');
    expect(matchesExternalSourceFilter?.(
      { externalLinks: { planning_center: 'pco-1' } },
      'planning_center',
      'linked',
    )).toBe(true);
    expect(matchesExternalSourceFilter?.(
      { externalLinks: { elvanto: 'elv-1' } },
      'planning_center',
      'linked',
    )).toBe(false);
    expect(matchesExternalSourceFilter?.(
      { externalLinks: { planning_center: 'pco-1' } },
      'none',
      'unlinked',
    )).toBe(true);
  });

  it('shows only people linked to the active provider when Linked is selected', async () => {
    const user = userEvent.setup();
    renderPeoplePage({
      authorityProvider: 'planning_center',
      people: [
        person(1, { externalLinks: { planning_center: 'pco-1' } }),
        person(2, { externalLinks: { elvanto: 'elv-2' } }),
      ],
    });

    await user.selectOptions(await screen.findByLabelText('Planning Center Link Status'), 'linked');

    expect(screen.getByText('Person 1')).toBeInTheDocument();
    expect(screen.queryByText('Person 2')).not.toBeInTheDocument();
  });

  it('shows only people not linked to the active provider when Not linked is selected', async () => {
    const user = userEvent.setup();
    renderPeoplePage({
      authorityProvider: 'planning_center',
      people: [
        person(1, { externalLinks: { planning_center: 'pco-1' } }),
        person(2, { externalLinks: { elvanto: 'elv-2' } }),
      ],
    });

    await user.selectOptions(await screen.findByLabelText('Planning Center Link Status'), 'unlinked');

    expect(screen.queryByText('Person 1')).not.toBeInTheDocument();
    expect(screen.getByText('Person 2')).toBeInTheDocument();
  });

  it('opens the Not linked view from the lifecycle review query link', async () => {
    renderPeoplePage({
      authorityProvider: 'planning_center',
      initialEntry: '/app/people?externalSource=unlinked',
      people: [
        person(1, { externalLinks: { planning_center: 'pco-1' } }),
        person(2),
      ],
    });

    expect(await screen.findByLabelText('Planning Center Link Status')).toHaveValue('unlinked');
    expect(screen.queryByText('Person 1')).not.toBeInTheDocument();
    expect(screen.getByText('Person 2')).toBeInTheDocument();
  });

  it('uses Elvanto links when Elvanto is the active authority', async () => {
    const user = userEvent.setup();
    renderPeoplePage({
      authorityProvider: 'elvanto',
      people: [
        person(1, { externalLinks: { planning_center: 'pco-1' } }),
        person(2, { externalLinks: { elvanto: 'elv-2' } }),
      ],
    });

    await user.selectOptions(await screen.findByLabelText('Elvanto Link Status'), 'linked');

    expect(screen.queryByText('Person 1')).not.toBeInTheDocument();
    expect(screen.getByText('Person 2')).toBeInTheDocument();
  });

  it('hides the control and leaves the roster unfiltered without an active authority', async () => {
    renderPeoplePage({
      authorityProvider: 'none',
      people: [
        person(1, { externalLinks: { planning_center: 'pco-1' } }),
        person(2),
      ],
    });

    await screen.findByText('Person 1');

    expect(screen.queryByLabelText(/Link Status/)).not.toBeInTheDocument();
    expect(screen.getByText('Person 2')).toBeInTheDocument();
  });

  it('keeps a family only when at least one member matches and hides its non-matching members', async () => {
    const user = userEvent.setup();
    renderPeoplePage({
      authorityProvider: 'planning_center',
      people: [
        person(1, {
          familyId: 10,
          familyName: 'Alpha Household',
          externalLinks: { planning_center: 'pco-1' },
        }),
        person(2, { familyId: 10, familyName: 'Alpha Household' }),
        person(3, { familyId: 20, familyName: 'Beta Household' }),
      ],
    });

    await user.selectOptions(await screen.findByLabelText('Planning Center Link Status'), 'linked');

    expect(screen.getByText('Alpha Household')).toBeInTheDocument();
    expect(screen.getByText('Person 1')).toBeInTheDocument();
    expect(screen.queryByText('Person 2')).not.toBeInTheDocument();
    expect(screen.queryByText('Beta Household')).not.toBeInTheDocument();
    expect(screen.queryByText('Person 3')).not.toBeInTheDocument();
  });

  it('applies the active-provider filter in individual view', async () => {
    const user = userEvent.setup();
    renderPeoplePage({
      authorityProvider: 'planning_center',
      people: [
        person(1, { externalLinks: { planning_center: 'pco-1' } }),
        person(2),
      ],
    });

    await user.selectOptions(await screen.findByLabelText('Planning Center Link Status'), 'unlinked');
    await user.click(screen.getByRole('button', { name: 'Individuals' }));

    expect(screen.queryByText('Person 1')).not.toBeInTheDocument();
    expect(screen.getByText('Person 2')).toBeInTheDocument();
    expect(screen.getByText('People (1) (Individual View)')).toBeInTheDocument();
  });

  it('clears selected people that disappear after the filter changes', async () => {
    const user = userEvent.setup();
    renderPeoplePage({
      authorityProvider: 'planning_center',
      people: [
        person(1, { externalLinks: { planning_center: 'pco-1' } }),
        person(2),
      ],
    });

    await user.click(await screen.findByText('Person 1'));
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Planning Center Link Status'), 'unlinked');

    await waitFor(() => expect(screen.queryByText('1 selected')).not.toBeInTheDocument());
    expect(screen.queryByText('Person 1')).not.toBeInTheDocument();
  });
});

describe('PeoplePage badge filter', () => {
  it('switches between family and individual views with a segmented control', async () => {
    const user = userEvent.setup();
    renderPeoplePage({
      authorityProvider: 'none',
      people: [person(1)],
    });

    const familiesButton = await screen.findByRole('button', { name: 'Families' });
    const individualsButton = screen.getByRole('button', { name: 'Individuals' });

    expect(familiesButton).toHaveAttribute('aria-pressed', 'true');
    expect(individualsButton).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('checkbox', { name: /Group people by families/ })).not.toBeInTheDocument();

    await user.click(individualsButton);

    expect(familiesButton).toHaveAttribute('aria-pressed', 'false');
    expect(individualsButton).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('People (1) (Individual View)')).toBeInTheDocument();
  });

  it('places the badge filters between the view and age controls', async () => {
    renderPeoplePage({
      authorityProvider: 'none',
      people: [person(1, { badgeText: 'Coach', badgeColor: '#dc2626', badgeIcon: 'star' })],
    });

    const displayFilters = await screen.findByRole('group', { name: 'People display filters' });
    const controlOrder = within(displayFilters)
      .getAllByRole('group')
      .map((group) => group.getAttribute('aria-label'));

    expect(controlOrder).toEqual(['View people as', 'Filter by badge', 'Filter by age']);
  });

  it('offers each used badge as a visual filter with its text in a helper', async () => {
    renderPeoplePage({
      authorityProvider: 'none',
      people: [
        person(1, { badgeText: 'Coach', badgeColor: '#dc2626', badgeIcon: 'star' }),
        person(2, { badgeText: 'Coach', badgeColor: '#dc2626', badgeIcon: 'star' }),
        person(3, { badgeText: 'Guest', badgeColor: '#16a34a', badgeIcon: '' }),
      ],
    });

    expect(await screen.findByRole('button', { name: 'Filter by badge: Coach' })).toHaveAttribute('title', 'Coach');
    expect(screen.getByRole('button', { name: 'Filter by badge: Guest' })).toHaveAttribute('title', 'Guest');
    expect(screen.getAllByRole('button', { name: /Filter by badge:/ })).toHaveLength(2);
  });

  it('shows people matching any selected badge and updates the roster count', async () => {
    const user = userEvent.setup();
    renderPeoplePage({
      authorityProvider: 'none',
      people: [
        person(1, { badgeText: 'Coach', badgeColor: '#dc2626', badgeIcon: 'star' }),
        person(2, { badgeText: 'Leader', badgeColor: '#2563eb', badgeIcon: 'heart' }),
        person(3),
      ],
    });

    await user.click(await screen.findByRole('button', { name: 'Filter by badge: Coach' }));

    expect(screen.getByText('Person 1')).toBeInTheDocument();
    expect(screen.queryByText('Person 2')).not.toBeInTheDocument();
    expect(screen.queryByText('Person 3')).not.toBeInTheDocument();
    expect(screen.getByText('People (1) (Grouped by Family)')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Filter by badge: Leader' }));

    expect(screen.getByText('Person 1')).toBeInTheDocument();
    expect(screen.getByText('Person 2')).toBeInTheDocument();
    expect(screen.queryByText('Person 3')).not.toBeInTheDocument();
    expect(screen.getByText('People (2) (Grouped by Family)')).toBeInTheDocument();
  });

  it('does not leave a mouse-focus ring looking like selection after a badge is deselected', async () => {
    const user = userEvent.setup();
    renderPeoplePage({
      authorityProvider: 'none',
      people: [
        person(1, { badgeText: 'Coach', badgeColor: '#dc2626', badgeIcon: 'star' }),
        person(2),
      ],
    });

    const coachBadge = await screen.findByRole('button', { name: 'Filter by badge: Coach' });
    await user.click(coachBadge);
    await user.click(coachBadge);

    expect(coachBadge).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Person 2')).toBeInTheDocument();
    expect(coachBadge).not.toHaveClass('focus:ring-2');
    expect(coachBadge).toHaveClass('focus-visible:ring-2');
  });
});
