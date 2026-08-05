import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import MedicalNoteIndicator from './MedicalNoteIndicator';

test('renders a non-navigating accessible indicator without triggering its row', () => {
  const onRowClick = vi.fn();
  render(<div onClick={onRowClick}><MedicalNoteIndicator icon="heart" color="#facc15" /></div>);
  const indicator = screen.getByLabelText('Medical note recorded');
  expect(indicator).toHaveAttribute('title', 'Medical note recorded');
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
  fireEvent.click(indicator);
  expect(onRowClick).not.toHaveBeenCalled();
});

test('fails closed for an invalid appearance', () => {
  const { container } = render(<MedicalNoteIndicator icon={'cross' as any} color="yellow" />);
  expect(container).toBeEmptyDOMElement();
});
