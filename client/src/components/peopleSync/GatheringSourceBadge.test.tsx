import React from 'react';
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import GatheringSourceBadge from './GatheringSourceBadge';

it('names every mapped source and distinguishes aligned membership from additions only', () => {
  render(<GatheringSourceBadge sources={[
    { provider: 'planning_center', sourceName: 'Youth', sourceKind: 'planning_center_list', membershipMode: 'aligned' },
    { provider: 'elvanto', sourceName: 'Leaders', sourceKind: 'elvanto_group', membershipMode: 'add_only' },
  ]} />);
  expect(screen.getByText(/Planning Center · Youth/)).toHaveTextContent('membership controlled by provider');
  expect(screen.getByText(/Elvanto · Leaders/)).toHaveTextContent('adds people only');
  expect(screen.getByText(/Manually added members and attendance history/)).toBeInTheDocument();
});

it('does not label a local gathering as provider managed', () => {
  const { container } = render(<GatheringSourceBadge />);
  expect(container).toBeEmptyDOMElement();
});
