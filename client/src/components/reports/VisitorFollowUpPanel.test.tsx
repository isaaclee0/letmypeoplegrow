import React from 'react';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import VisitorFollowUpPanel from './VisitorFollowUpPanel';
import api from '../../services/api';
vi.mock('../../services/api', () => ({ default: { get: vi.fn() } }));
vi.mock('./AttendanceHistoryPopover', () => ({default: ({children}: {children: React.ReactNode}) => <span>{children}</span>}));
vi.mock('./CaregiverPicker', () => ({default: () => null}));
afterEach(()=>{ cleanup(); vi.clearAllMocks(); });
const briefing = {asOf:'2026-09-20',categories:[{key:'priority',label:'Priority follow-up',action:'Check whether someone has connected.'}],groups:[{key:'family:1',familyId:1,familyName:'Guest',category:'priority',caregivers:['Alex Leader'],members:[{individualId:1,name:'Sam Guest',category:'priority',firstVisitDate:'2026-09-06',latestVisitDate:'2026-09-06',firstGatheringName:'Sunday',missedOpportunities:2,visitCount:1}]}]};
it('shows named actions, completed-week date and caregiver without inventing contact status', async()=>{
 vi.mocked(api.get).mockResolvedValue({data:briefing});
 render(<VisitorFollowUpPanel gatheringIds={[1]} churchId="church-a" />);
 await screen.findByText('Sam Guest');
 expect(screen.getByText(/As of 2026-09-20/)).toBeTruthy();
 expect(screen.getByText(/2 completed weekly opportunities/)).toBeTruthy();
 expect(screen.getByText(/Alex Leader/)).toBeTruthy();
 expect(screen.getByText(/Contact status unknown/)).toBeTruthy();
 expect(api.get).toHaveBeenCalledWith('/reports/visitor-follow-up',{params:{gatheringIds:'1'}});
});
it('shows failed loading separately from no actions and clears old church facts',async()=>{
 vi.mocked(api.get).mockResolvedValueOnce({data:briefing}).mockRejectedValueOnce(new Error('offline'));
 const {rerender}=render(<VisitorFollowUpPanel gatheringIds={[1]} churchId="church-a" />);
 await screen.findByText('Sam Guest');
 rerender(<VisitorFollowUpPanel gatheringIds={[1]} churchId="church-b" />);
 await screen.findByRole('alert');
 expect(screen.queryByText('Sam Guest')).toBeNull();
 expect(screen.queryByText(/No visitor follow-up/)).toBeNull();
});
it('gathering filters reload the current briefing',async()=>{
 vi.mocked(api.get).mockResolvedValue({data:{...briefing,groups:[]}});
 const {rerender}=render(<VisitorFollowUpPanel gatheringIds={[1]} churchId="a" />);
 await screen.findByText(/No visitor follow-up/);
 rerender(<VisitorFollowUpPanel gatheringIds={[2]} churchId="a" />);
 await waitFor(()=>expect(api.get).toHaveBeenLastCalledWith('/reports/visitor-follow-up',{params:{gatheringIds:'2'}}));
});
