import { describe, expect, it, vi } from 'vitest';
import { recordAttendanceViaRest } from './AttendancePage';

vi.mock('../services/userPreferences', () => ({
  userPreferences: {},
  PREFERENCE_KEYS: {},
}));

describe('REST attendance writes', () => {
  it('returns the saved attendance response', async () => {
    const heldState = {
      id: 42,
      gatheringTypeId: 7,
      sessionDate: '2026-08-17',
      status: 'held' as const,
      rosterProvenanceVersion: 1,
      cancelledAt: null,
      cancelledBy: null,
    };
    const record = vi.fn().mockResolvedValue({
      data: { message: 'Attendance recorded successfully', sessionState: heldState },
    });
    const result = await recordAttendanceViaRest(
      record,
      7,
      '2026-08-17',
      { attendanceRecords: [{ individualId: 5, present: true }], visitors: [] },
    );

    expect(result.sessionState).toEqual(heldState);
  });
});
