import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ChurchSwitcher from './ChurchSwitcher';
import { useAuth } from '../contexts/AuthContext';

vi.mock('../contexts/AuthContext', () => ({
  useAuth: vi.fn(),
}));

describe('ChurchSwitcher', () => {
  it('renders static text with no button when there are no other linked churches', () => {
    (useAuth as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      user: { churchName: 'Kingston CRC' },
      myChurches: [],
      switchChurch: vi.fn(),
    });

    render(<ChurchSwitcher />);

    expect(screen.getByText('Kingston CRC')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders a dropdown listing other linked churches when clicked', () => {
    (useAuth as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      user: { churchName: 'Kingston CRC' },
      myChurches: [{ churchId: 'crc_54cc7bdb2f53', churchName: 'CRC South Tas' }],
      switchChurch: vi.fn(),
    });

    render(<ChurchSwitcher />);

    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByText('CRC South Tas')).toBeInTheDocument();
  });

  it('calls switchChurch with the selected church id', () => {
    const switchChurchMock = vi.fn();
    (useAuth as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      user: { churchName: 'Kingston CRC' },
      myChurches: [{ churchId: 'crc_54cc7bdb2f53', churchName: 'CRC South Tas' }],
      switchChurch: switchChurchMock,
    });

    render(<ChurchSwitcher />);
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByText('CRC South Tas'));

    expect(switchChurchMock).toHaveBeenCalledWith('crc_54cc7bdb2f53');
  });
});
