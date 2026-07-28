import React, { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ElvantoFilterEditor, { defaultElvantoFilter } from './ElvantoFilterEditor';
import type { ElvantoFilterConfig, ElvantoMetadata } from '../peopleSync/types';

const metadata: ElvantoMetadata = {
  fetchedAt: '2026-07-25T10:00:00.000Z',
  categories: [{ id: 'category-members', name: 'Members' }, { id: 'category-visitors', name: 'Visitors' }],
  groups: [{ id: 'group-youth', name: 'Youth', status: 'active', memberCount: 12 }, { id: 'group-music', name: 'Music', status: null, memberCount: 8 }],
  demographics: [{ value: 'Young adults', count: 9 }],
  departments: [{ value: 'Worship', count: 5 }],
  serviceTypes: [{ id: 'service-sunday', name: 'Sunday service' }],
  locations: [{ id: 'location-main', name: 'Main campus' }],
  customFields: [{ id: 'field-ministry', name: 'Ministry', type: 'select', values: [{ id: 'value-welcome', name: 'Welcome team' }] }],
};

function ControlledFilter({ initial = defaultElvantoFilter(), source = metadata }: { initial?: ElvantoFilterConfig; source?: ElvantoMetadata }) {
  const [value, setValue] = useState(initial);
  return <>
    <ElvantoFilterEditor metadata={source} value={value} onChange={setValue} />
    <output data-testid="filter-value">{JSON.stringify(value)}</output>
  </>;
}

describe('ElvantoFilterEditor', () => {
  it('shows only populated metadata dimensions and starts new filters with Active and Contact', () => {
    const emptyMetadata = { ...metadata, categories: [], groups: [], demographics: [], departments: [], serviceTypes: [], locations: [], customFields: [] };
    render(<ControlledFilter source={emptyMetadata} />);

    expect(screen.getByLabelText('Active')).toBeChecked();
    expect(screen.getByLabelText('Contact')).toBeChecked();
    expect(screen.getByText('People status')).toBeInTheDocument();
    expect(screen.queryByText('Categories')).not.toBeInTheDocument();
    expect(screen.queryByText('Groups')).not.toBeInTheDocument();
    expect(screen.queryByText('Custom fields')).not.toBeInTheDocument();
    expect(screen.queryByText('AND')).not.toBeInTheDocument();
  });

  it('keeps group stable IDs in controlled state and changes any/all only after two choices', () => {
    render(<ControlledFilter />);

    fireEvent.click(screen.getByLabelText('Youth'));
    expect(screen.getByTestId('filter-value')).toHaveTextContent('group-youth');
    expect(screen.queryByRole('button', { name: 'Match all' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Music'));
    fireEvent.click(screen.getByRole('button', { name: 'Match all' }));
    expect(screen.getByTestId('filter-value')).toHaveTextContent('"operator":"all"');
  });

  it('matches any selected category by its stable ID without showing an unsupported category operator', () => {
    const categoryOnly = { ...metadata, groups: [], demographics: [], departments: [], serviceTypes: [], locations: [], customFields: [] };
    render(<ControlledFilter source={categoryOnly} />);

    fireEvent.click(screen.getByLabelText('Members'));
    fireEvent.click(screen.getByLabelText('Visitors'));
    const categorySection = screen.getByText('Categories').closest('section')!;
    expect(screen.getByTestId('filter-value')).toHaveTextContent('category-members');
    expect(screen.getByTestId('filter-value')).toHaveTextContent('category-visitors');
    expect(within(categorySection).queryByRole('button', { name: /Match any|Match all/ })).not.toBeInTheDocument();
  });

  it('shows AND between status and the first non-empty metadata dimension', () => {
    const categoryOnly = { ...metadata, groups: [], demographics: [], departments: [], serviceTypes: [], locations: [], customFields: [] };
    render(<ControlledFilter source={categoryOnly} />);

    expect(screen.getByText('AND')).toBeInTheDocument();
  });

  it('omits custom fields that have no selectable values and their connector', () => {
    const noOptions = { ...metadata, categories: [], groups: [], demographics: [], departments: [], serviceTypes: [], locations: [], customFields: [{ id: 'empty', name: 'No choices', type: 'text', values: [] }] };
    render(<ControlledFilter source={noOptions} />);

    expect(screen.queryByText('Custom fields')).not.toBeInTheDocument();
    expect(screen.queryByText('AND')).not.toBeInTheDocument();
  });

  it('uses category and custom-field definition/value IDs and warns about removed options', () => {
    const selected = {
      ...defaultElvantoFilter(),
      categoryIds: ['category-removed'],
      groups: { ids: ['group-removed'], operator: 'any' as const },
    };
    render(<ControlledFilter initial={selected} />);

    expect(screen.getByRole('alert')).toHaveTextContent(/no longer exists in Elvanto/i);
    fireEvent.click(screen.getByLabelText('Members'));
    fireEvent.click(screen.getByLabelText('Welcome team'));
    expect(screen.getByTestId('filter-value')).toHaveTextContent('category-members');
    expect(screen.getByTestId('filter-value')).toHaveTextContent('field-ministry');
    expect(screen.getByTestId('filter-value')).toHaveTextContent('value-welcome');
  });

  it('stacks long custom-field option labels in one column and keeps checkboxes from shrinking', () => {
    const longConsent = 'I consent to photos of me and my family being used for promotional purposes (e.g. appearing on the church website)';
    const longShare = "I'm happy for these details to be shared with other members of the church community (e.g. in the church directory)";
    const longPrivate = "Please don't share these details with other members of the church community";
    const consentMetadata: ElvantoMetadata = {
      ...metadata,
      categories: [],
      groups: [],
      demographics: [],
      departments: [],
      serviceTypes: [],
      locations: [],
      customFields: [
        { id: 'media', name: 'Media Consent', type: 'select', values: [{ id: 'consent', name: longConsent }] },
        {
          id: 'privacy',
          name: 'Privacy of Information',
          type: 'select',
          values: [
            { id: 'share', name: longShare },
            { id: 'private', name: longPrivate },
          ],
        },
      ],
    };
    const { container } = render(<ControlledFilter source={consentMetadata} />);

    const mediaLabel = screen.getByLabelText(longConsent).closest('label');
    const privacyGrid = screen.getByText('Privacy of Information').closest('div')?.parentElement?.querySelector('.grid');
    expect(mediaLabel?.className).toMatch(/items-start/);
    expect(screen.getByLabelText(longConsent).className).toMatch(/shrink-0/);
    expect(privacyGrid?.className).not.toMatch(/sm:grid-cols-2/);
    expect(container.querySelectorAll('input[type="checkbox"].shrink-0').length).toBeGreaterThan(0);
  });
});
