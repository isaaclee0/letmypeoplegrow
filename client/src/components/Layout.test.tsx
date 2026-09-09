import React from 'react';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Layout from './Layout';
import { aiAPI, gatheringsAPI } from '../services/api';

const checkInsState = vi.hoisted(() => ({ isLocked: false }));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 1,
      role: 'admin',
      firstName: 'Test',
      lastName: 'User',
      gatheringAssignments: [],
      unreadNotifications: 0,
    },
    logout: vi.fn(),
    updateUser: vi.fn(),
  }),
}));

vi.mock('../contexts/CheckInsContext', () => ({
  useCheckIns: () => checkInsState,
}));

vi.mock('../contexts/WebSocketContext', () => ({
  useWebSocket: () => ({ isOfflineMode: false, connectionStatus: 'connected' }),
}));

vi.mock('../contexts/PWAUpdateContext', () => ({
  usePWAUpdate: () => ({ updateAvailable: false, performUpdate: vi.fn() }),
}));

vi.mock('./ChurchSwitcher', () => ({ default: () => null }));

function renderLayout() {
  const router = createMemoryRouter([
    {
      path: '/app',
      element: <Layout />,
      children: [{ index: true, element: <div data-testid="page-content">Page content</div> }],
    },
  ], { initialEntries: ['/app'] });

  return render(<RouterProvider router={router} />);
}

afterEach(() => {
  checkInsState.isLocked = false;
  vi.restoreAllMocks();
});

describe('Layout mobile page gutters', () => {
  it.each([
    ['normal pages', false],
    ['locked check-in pages', true],
  ])('uses compact mobile padding for %s', async (_description, isLocked) => {
    checkInsState.isLocked = isLocked;
    vi.spyOn(aiAPI, 'getStatus').mockResolvedValue({ data: { configured: false } } as never);
    vi.spyOn(gatheringsAPI, 'getAll').mockResolvedValue({ data: { gatherings: [] } } as never);

    renderLayout();

    const content = await screen.findByTestId('page-content');
    expect(content.parentElement).toHaveClass('px-2', 'sm:px-6', 'md:px-8');
  });
});
