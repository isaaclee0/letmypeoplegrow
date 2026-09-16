import React, { useEffect, useState } from 'react';
import api from '../../services/api';
import AttendanceHistoryPopover from './AttendanceHistoryPopover';
import CaregiverPicker from './CaregiverPicker';

type Category = 'priority' | 'followUp' | 'welcome' | 'returned';
interface Member {
  individualId: number; name: string; category: Category;
  firstVisitDate: string; latestVisitDate: string;
  firstGatheringName: string; latestGatheringName: string;
  visitCount: number; missedOpportunities: number;
}
interface Briefing {
  asOf: string;
  categories: { key: Category; label: string; action: string }[];
  groups: { key: string; familyId: number | null; familyName: string | null;
    category: Category; members: Member[]; caregivers: string[] }[];
}

export default function VisitorFollowUpPanel({ gatheringIds, churchId }: { gatheringIds: number[]; churchId: string }) {
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [familyId, setFamilyId] = useState<number | null>(null);
  const selection = [...gatheringIds].sort((a,b)=>a-b).join(',');
  useEffect(() => {
    let current = true;
    setBriefing(null); setError(false); setFamilyId(null);
    api.get<Briefing>('/reports/visitor-follow-up', { params: { gatheringIds: selection || undefined } })
      .then(({ data }) => { if (current) setBriefing(data); })
      .catch(() => { if (current) setError(true); });
    return () => { current = false; };
  }, [selection, churchId, revision]);
  return <div className="h-full rounded-lg bg-white shadow dark:bg-gray-800 p-6">
    <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Visitor welcome &amp; follow-up</h3>
    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
      {briefing ? `As of ${briefing.asOf} · latest completed week. ` : ''}
      Independent of chart dates. Returns at other gatherings are included.
    </p>
    {error ? <div role="alert" className="mt-4 text-sm">Could not load visitor follow-up. <button className="underline" onClick={()=>setRevision(v=>v+1)}>Retry</button></div>
      : !briefing ? <p className="mt-4 text-sm" role="status">Loading visitor follow-up…</p>
      : !briefing.groups.length ? <p className="mt-4 text-sm text-gray-500">No visitor follow-up actions or return milestones for this completed week. Missing attendance is not treated as absence.</p>
      : briefing.categories.map(category => {
        const groups = briefing.groups.filter(g=>g.category===category.key);
        if (!groups.length) return null;
        return <section key={category.key} className="mt-5">
          <h4 className="font-semibold text-gray-900 dark:text-gray-100">{category.label}</h4>
          <p className="text-sm text-gray-500 dark:text-gray-400">{category.action}</p>
          <ul className="mt-2 divide-y divide-gray-200 dark:divide-gray-700">
            {groups.map(group=><li key={group.key} className="py-3 text-sm text-gray-700 dark:text-gray-300">
              {group.familyName && <p className="font-medium">{group.familyName} family</p>}
              {group.members.map(member=><div key={member.individualId} className="mt-1">
                <AttendanceHistoryPopover people={[{individualId:member.individualId,name:member.name}]}>
                  <span className="font-medium underline decoration-dotted">{member.name}</span>
                </AttendanceHistoryPopover>
                <p>{member.category === 'welcome' ? 'First recorded visit'
                  : member.category === 'returned' ? `Visit ${member.visitCount} · returned at ${member.latestGatheringName}`
                  : `No return recorded over ${member.missedOpportunities} completed weekly ${member.missedOpportunities === 1 ? 'opportunity' : 'opportunities'}`}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">First: {member.firstVisitDate} · {member.firstGatheringName}. Latest: {member.latestVisitDate}.</p>
              </div>)}
              <p className="mt-2 text-xs">Caregiver: {group.caregivers.join(', ') || 'none assigned'}. Contact status unknown.</p>
              {group.familyId && <button className="mt-1 text-primary-600 underline" onClick={()=>setFamilyId(group.familyId)}>{group.caregivers.length ? 'Manage caregiver' : 'Assign caregiver'}</button>}
            </li>)}
          </ul>
        </section>;
      })}
    <CaregiverPicker familyId={familyId ?? 0} open={familyId !== null} onClose={()=>setFamilyId(null)} onChanged={()=>setRevision(v=>v+1)} />
  </div>;
}
