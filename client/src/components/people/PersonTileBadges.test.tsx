import { render, screen, within } from '@testing-library/react';
import PersonTileBadges from './PersonTileBadges';

test('groups medical and ordinary badges along the top edge of a person tile', () => {
  render(
    <PersonTileBadges
      displayName="Pat"
      badgeInfo={{
        text: null,
        icon: 'star',
        styles: { backgroundColor: '#ef4444', color: '#ffffff' },
      }}
      hasMedicalNotes
      medicalNotesIndicator={{ icon: 'heart', color: '#facc15' }}
    />,
  );

  const badges = screen.getByRole('group', { name: 'Badges for Pat' });
  expect(badges).toHaveClass(
    'gap-1',
    'sm:absolute',
    'sm:right-3',
    'sm:top-0',
    'sm:-translate-y-1/2',
  );
  expect(within(badges).getByLabelText('Medical note recorded')).toBeInTheDocument();
  expect(badges.querySelectorAll('svg')).toHaveLength(2);
});
