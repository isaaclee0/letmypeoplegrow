import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ReportLayoutEditor from './ReportLayoutEditor';
import { defaultReportLayout } from './reportLayout';

const props = (hidden: string[] = []) => ({
  layout: { ...defaultReportLayout(), hidden: hidden as ReturnType<typeof defaultReportLayout>['hidden'] },
  editing: true,
  saving: false,
  error: null,
  unavailable: {},
  onSetVisible: vi.fn(),
  onSave: vi.fn(),
  onCancel: vi.fn(),
});

describe('ReportLayoutEditor', () => {
  it('restores hidden panels from the reveal dialog', () => {
    const editorProps = props(['recent-visitors']);
    render(<ReportLayoutEditor {...editorProps} />);

    fireEvent.click(screen.getByRole('button', { name: 'Reveal hidden sections (1)' }));
    expect(screen.getByRole('dialog', { name: 'Reveal hidden sections' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(editorProps.onSetVisible).toHaveBeenCalledWith('recent-visitors', true);
  });

  it('does not show reveal controls when nothing is hidden', () => {
    render(<ReportLayoutEditor {...props()} />);
    expect(screen.queryByRole('button', { name: /Reveal hidden sections/ })).not.toBeInTheDocument();
  });

  it('uses an opaque dark surface for readable editor controls', () => {
    render(<ReportLayoutEditor {...props()} />);
    expect(screen.getByRole('region', { name: 'Customise layout' })).toHaveClass('dark:bg-gray-800');
  });
});
