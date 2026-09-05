import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  ReportPanel,
  ReportPanelExpansion,
  ReportPanelGrid,
  ReportPanelSectionHeading,
} from './ReportPanelGrid';
import { defaultReportLayout, type ReportLayout } from './reportLayout';

describe('ReportPanelGrid', () => {
  it('places every panel in the saved order, including panels from nested components', () => {
    const layout: ReportLayout = {
      ...defaultReportLayout(),
      order: [
        'regularity',
        'period-attendance',
        'attendance-direction',
        'summary',
        'period-visitors',
        'recent-absences',
        'recent-visitors',
        'attendance-changes',
      ],
    };

    const { container } = render(
      <ReportPanelGrid layout={layout} editing={false} unavailable={{}} onReorder={vi.fn()} onHide={vi.fn()}>
        <ReportPanel id="summary">Summary</ReportPanel>
        <div className="contents">
          <ReportPanel id="period-attendance">Period attendance</ReportPanel>
          <ReportPanel id="regularity">Regularity</ReportPanel>
          <ReportPanel id="attendance-direction">Attendance direction</ReportPanel>
        </div>
      </ReportPanelGrid>,
    );

    const panels = [...container.querySelectorAll<HTMLElement>('[data-report-panel]')];
    expect(panels.map((panel) => panel.dataset.reportPanel)).toEqual([
      'summary', 'period-attendance', 'regularity', 'attendance-direction',
    ]);
    expect(panels.map((panel) => panel.style.order)).toEqual(['7', '3', '1', '5']);
  });

  it('omits hidden panels and explains when every available panel is hidden', () => {
    const layout = { ...defaultReportLayout(), hidden: [...defaultReportLayout().order] };
    render(
      <ReportPanelGrid layout={layout} editing={false} unavailable={{}} onReorder={vi.fn()} onHide={vi.fn()}>
        <ReportPanel id="summary">Summary</ReportPanel>
      </ReportPanelGrid>,
    );

    expect(screen.queryByText('Summary')).not.toBeInTheDocument();
    expect(screen.getByText('All report panels are hidden.')).toBeInTheDocument();
  });

  it('previews and commits a pointer drag from the compact handle', () => {
    const onReorder = vi.fn();
    render(
      <ReportPanelGrid layout={defaultReportLayout()} editing unavailable={{}} onReorder={onReorder} onHide={vi.fn()}>
        <ReportPanel id="summary">Summary</ReportPanel>
        <ReportPanel id="period-attendance">Period attendance</ReportPanel>
      </ReportPanelGrid>,
    );

    const grabHandle = screen.getByRole('button', { name: 'Drag Summary metrics' });
    const target = screen.getByText('Period attendance').closest<HTMLElement>('[data-report-panel]')!;
    Object.defineProperty(target, 'getBoundingClientRect', { value: () => ({ top: 0, height: 100, left: 0, right: 100, bottom: 100, width: 100 }) });
    Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => [target] });

    expect(grabHandle).toHaveClass('rounded-full', 'cursor-grab');
    fireEvent.pointerDown(grabHandle, { button: 0, pointerId: 1, clientX: 20, clientY: 20 });
    const moveEvent = new Event('pointermove', { bubbles: true });
    Object.assign(moveEvent, { pointerId: 1, clientX: 40, clientY: 80 });
    fireEvent(window, moveEvent);

    const ghost = screen.getByTestId('report-panel-ghost');
    expect(ghost).toBeInTheDocument();
    expect(ghost).toHaveStyle({ transform: 'translate3d(54px, 94px, 0)' });
    expect(target).toHaveClass('bg-primary-100/70');
    const upEvent = new Event('pointerup', { bubbles: true });
    Object.assign(upEvent, { pointerId: 1, clientX: 40, clientY: 80 });
    fireEvent(window, upEvent);

    expect(onReorder).toHaveBeenCalledWith([
      'period-attendance',
      'summary',
      'period-visitors',
      'recent-absences',
      'recent-visitors',
      'attendance-direction',
      'regularity',
      'attendance-changes',
    ]);
  });

  it('uses the grab handle arrow keys to reorder and a circular X to hide', () => {
    const onReorder = vi.fn();
    const onHide = vi.fn();
    render(
      <ReportPanelGrid layout={defaultReportLayout()} editing unavailable={{}} onReorder={onReorder} onHide={onHide}>
        <ReportPanel id="summary">Summary</ReportPanel>
        <ReportPanel id="period-attendance">Period attendance</ReportPanel>
      </ReportPanelGrid>,
    );

    fireEvent.keyDown(screen.getByRole('button', { name: 'Drag Summary metrics' }), { key: 'ArrowDown' });
    expect(onReorder).toHaveBeenCalledWith([
      'period-attendance',
      'summary',
      'period-visitors',
      'recent-absences',
      'recent-visitors',
      'attendance-direction',
      'regularity',
      'attendance-changes',
    ]);

    const hideButton = screen.getByRole('button', { name: 'Hide Summary metrics' });
    expect(hideButton.querySelector('svg')).toBeInTheDocument();
    expect(hideButton).toHaveClass('rounded-full');
    fireEvent.click(hideButton);
    expect(onHide).toHaveBeenCalledWith('summary');
  });

  it('keeps a visible section heading when visitor panels are hidden', () => {
    const layout: ReportLayout = {
      ...defaultReportLayout(),
      hidden: ['period-visitors', 'recent-visitors'],
    };
    render(
      <ReportPanelGrid layout={layout} editing={false} unavailable={{}} onReorder={vi.fn()} onHide={vi.fn()}>
        <ReportPanelSectionHeading ids={['attendance-direction', 'regularity', 'attendance-changes']}>
          Long-term trends
        </ReportPanelSectionHeading>
        <ReportPanel id="attendance-direction">Attendance direction</ReportPanel>
      </ReportPanelGrid>,
    );

    const heading = screen.getByRole('heading', { name: 'Long-term trends' });
    expect(heading).toBeVisible();
    expect(heading.parentElement).toHaveStyle({ order: 10 });
    expect(Number.isInteger(Number(heading.parentElement?.style.order))).toBe(true);
  });

  it('stretches panel content to the full grid-row height', () => {
    render(
      <ReportPanelGrid layout={defaultReportLayout()} editing={false} unavailable={{}} onReorder={vi.fn()} onHide={vi.fn()}>
        <ReportPanel id="summary"><div>Summary</div></ReportPanel>
      </ReportPanelGrid>,
    );

    const panel = screen.getByText('Summary').closest('[data-report-panel]');
    expect(panel).toHaveClass('flex', 'flex-col');
    expect(panel?.querySelector('[data-report-panel-content]')).toHaveClass('flex-1');
  });

  it('places expanded panel content full width immediately after its panel', () => {
    render(
      <ReportPanelGrid layout={defaultReportLayout()} editing={false} unavailable={{}} onReorder={vi.fn()} onHide={vi.fn()}>
        <ReportPanel id="attendance-direction">Attendance direction</ReportPanel>
        <ReportPanelExpansion after="attendance-direction">Attendance history graph</ReportPanelExpansion>
        <ReportPanel id="regularity">Regularity</ReportPanel>
      </ReportPanelGrid>,
    );

    const expansion = screen.getByText('Attendance history graph');
    expect(expansion).toHaveClass('lg:col-span-2');
    expect(expansion).toHaveStyle({ order: 14 });
  });
});
