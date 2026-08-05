import { render, screen } from '@testing-library/react';
import PersonCard from './PersonCard';

test('renders computed medical indicator alongside the ordinary badge', () => {
  render(<PersonCard
    person={{ id: 1, firstName: 'Pat', lastName: 'Person', peopleType: 'regular', hasMedicalNotes: true, badgeIcon: 'star', badgeColor: '#ef4444' } as any}
    isSelected={false} onToggleSelection={() => {}} displayName="Pat" needsWideLayout={false}
    getGatheringColor={() => ''} getStandardGatheringAssignments={() => []}
    getBadgeInfo={() => ({ text: null, icon: 'star', styles: { backgroundColor: '#ef4444', color: '#fff' } })}
    medicalNotesIndicator={{ icon: 'heart', color: '#facc15' }}
  />);
  expect(screen.getByLabelText('Medical note recorded')).toBeInTheDocument();
  expect(document.querySelectorAll('svg')).toHaveLength(2);
});
