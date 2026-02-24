import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { kioskAPI } from '../../services/api';
import {
  ClockIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ArrowDownTrayIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';

interface HistorySession {
  date: string;
  records: Array<{
    id: number;
    individualId: number;
    action: 'checkin' | 'checkout';
    signerName: string | null;
    createdAt: string;
    firstName: string;
    lastName: string;
    familyName: string | null;
  }>;
}

interface HistoryDetail {
  date: string;
  individuals: Array<{
    individualId: number;
    firstName: string;
    lastName: string;
    familyName: string | null;
    checkins: Array<{ time: string; signerName: string | null; userName?: string | null }>;
    checkouts: Array<{ time: string; signerName: string | null; userName?: string | null }>;
  }>;
}

interface CheckInHistoryProps {
  gatheringId: number;
  gatheringName: string;
}

const CheckInHistory: React.FC<CheckInHistoryProps> = ({ gatheringId, gatheringName }) => {
  const { user } = useAuth();
  const [historySessions, setHistorySessions] = useState<HistorySession[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [expandedDate, setExpandedDate] = useState<string | null>(null);
  const [historyDetail, setHistoryDetail] = useState<HistoryDetail | null>(null);
  const [historyDetailLoading, setHistoryDetailLoading] = useState(false);
  const [deletingSession, setDeletingSession] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      setHistoryLoading(true);
      const response = await kioskAPI.getHistory(gatheringId, 20);
      setHistorySessions(response.data.sessions || []);
    } catch (err) {
      console.error('Failed to load check-in history:', err);
    } finally {
      setHistoryLoading(false);
    }
  }, [gatheringId]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const loadHistoryDetail = async (date: string) => {
    if (expandedDate === date) {
      setExpandedDate(null);
      setHistoryDetail(null);
      return;
    }
    try {
      setHistoryDetailLoading(true);
      setExpandedDate(date);
      const response = await kioskAPI.getHistoryDetail(gatheringId, date);
      setHistoryDetail(response.data);
    } catch (err) {
      console.error('Failed to load check-in history detail:', err);
    } finally {
      setHistoryDetailLoading(false);
    }
  };

  const exportToTSV = () => {
    if (!historyDetail) return;

    const lines: string[] = [];
    lines.push(['Name', 'Family', 'Check-in Time', 'Checked In By', 'User', 'Check-out Time', 'Checked Out By', 'User'].join('\t'));

    for (const person of historyDetail.individuals) {
      const checkinTime = person.checkins.length > 0
        ? new Date(person.checkins[0].time).toLocaleTimeString()
        : '';
      const checkinSigner = person.checkins.length > 0
        ? (person.checkins[0].signerName || '')
        : '';
      const checkinUser = person.checkins.length > 0
        ? (person.checkins[0].userName || '')
        : '';
      const checkoutTime = person.checkouts.length > 0
        ? new Date(person.checkouts[0].time).toLocaleTimeString()
        : '';
      const checkoutSigner = person.checkouts.length > 0
        ? (person.checkouts[0].signerName || '')
        : '';
      const checkoutUser = person.checkouts.length > 0
        ? (person.checkouts[0].userName || '')
        : '';

      lines.push([
        `${person.firstName} ${person.lastName}`,
        person.familyName || '',
        checkinTime,
        checkinSigner,
        checkinUser,
        checkoutTime,
        checkoutSigner,
        checkoutUser,
      ].join('\t'));
    }

    const tsv = lines.join('\n');
    const blob = new Blob([tsv], { type: 'text/tab-separated-values;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const dateFormatted = historyDetail.date;
    link.download = `checkins-${gatheringName.replace(/\s+/g, '-')}-${dateFormatted}.tsv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleDeleteSession = async (date: string) => {
    const formattedDate = new Date(date + 'T00:00:00').toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    if (!window.confirm(`Delete the check-in session for ${formattedDate}?\n\nThis will permanently remove all check-in/check-out records for this date. Attendance records will not be affected.`)) {
      return;
    }
    try {
      setDeletingSession(date);
      await kioskAPI.deleteSession(gatheringId, date);
      setHistorySessions(prev => prev.filter(s => s.date !== date));
      if (expandedDate === date) {
        setExpandedDate(null);
        setHistoryDetail(null);
      }
    } catch (err) {
      console.error('Failed to delete check-in session:', err);
      alert('Failed to delete check-in session. Please try again.');
    } finally {
      setDeletingSession(null);
    }
  };

  return (
    <div className="mt-8">
      <div className="flex items-center mb-4">
        <ClockIcon className="h-5 w-5 text-gray-400 mr-2" />
        <h2 className="text-lg font-semibold text-gray-900">Past Check-in Sessions</h2>
      </div>

      {historyLoading ? (
        <div className="text-center py-6">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary-600 mx-auto"></div>
          <p className="mt-2 text-sm text-gray-500">Loading history...</p>
        </div>
      ) : historySessions.length === 0 ? (
        <div className="bg-white shadow rounded-lg p-6 text-center">
          <p className="text-sm text-gray-500">No past check-in sessions found for this gathering.</p>
        </div>
      ) : (
        <div className="bg-white shadow rounded-lg divide-y divide-gray-200">
          {historySessions.map(session => {
            const isExpanded = expandedDate === session.date;
            const checkinCount = session.records.filter(r => r.action === 'checkin').length;
            const checkoutCount = session.records.filter(r => r.action === 'checkout').length;
            const uniqueIndividuals = new Set(session.records.filter(r => r.action === 'checkin').map(r => r.individualId)).size;

            return (
              <div key={session.date}>
                <div className="flex items-center">
                  <button
                    onClick={() => loadHistoryDetail(session.date)}
                    className="flex-1 flex items-center justify-between p-4 hover:bg-gray-50 transition-colors text-left"
                  >
                    <div>
                      <div className="font-medium text-gray-900">
                        {new Date(session.date + 'T00:00:00').toLocaleDateString('en-US', {
                          weekday: 'long',
                          year: 'numeric',
                          month: 'long',
                          day: 'numeric',
                        })}
                      </div>
                      <div className="text-sm text-gray-500 mt-0.5">
                        {uniqueIndividuals} checked in &middot; {checkoutCount} check-out{checkoutCount !== 1 ? 's' : ''}
                      </div>
                    </div>
                    {isExpanded ? (
                      <ChevronUpIcon className="h-5 w-5 text-gray-400 flex-shrink-0" />
                    ) : (
                      <ChevronDownIcon className="h-5 w-5 text-gray-400 flex-shrink-0" />
                    )}
                  </button>
                  {user?.role === 'admin' && (
                    <button
                      onClick={() => handleDeleteSession(session.date)}
                      disabled={deletingSession === session.date}
                      className="p-2 mr-2 text-gray-400 hover:text-red-600 transition-colors disabled:opacity-50 flex-shrink-0"
                      title="Delete session"
                    >
                      {deletingSession === session.date ? (
                        <div className="h-4 w-4 animate-spin rounded-full border-2 border-red-400 border-t-transparent" />
                      ) : (
                        <TrashIcon className="h-4 w-4" />
                      )}
                    </button>
                  )}
                </div>

                {isExpanded && (
                  <div className="px-4 pb-4">
                    {historyDetailLoading ? (
                      <div className="text-center py-4">
                        <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary-600 mx-auto"></div>
                      </div>
                    ) : historyDetail ? (
                      <>
                        <div className="flex justify-end mb-3">
                          <button
                            onClick={exportToTSV}
                            className="inline-flex items-center px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                          >
                            <ArrowDownTrayIcon className="h-3.5 w-3.5 mr-1.5" />
                            Export TSV
                          </button>
                        </div>

                        <div className="overflow-x-auto">
                          <table className="min-w-full text-sm">
                            <thead>
                              <tr className="border-b border-gray-200">
                                <th className="text-left py-2 pr-4 font-medium text-gray-700">Name</th>
                                <th className="text-left py-2 pr-4 font-medium text-gray-700">Family</th>
                                <th className="text-left py-2 pr-4 font-medium text-gray-700">Check-in</th>
                                <th className="text-left py-2 pr-4 font-medium text-gray-700">Signed by</th>
                                <th className="text-left py-2 pr-4 font-medium text-gray-700">Check-out</th>
                                <th className="text-left py-2 font-medium text-gray-700">Signed by</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100">
                              {historyDetail.individuals.map(person => (
                                <tr key={person.individualId} className="hover:bg-gray-50">
                                  <td className="py-2 pr-4 text-gray-900">
                                    {person.firstName} {person.lastName}
                                  </td>
                                  <td className="py-2 pr-4 text-gray-500">
                                    {person.familyName || '-'}
                                  </td>
                                  <td className="py-2 pr-4 text-green-600">
                                    {person.checkins.length > 0
                                      ? new Date(person.checkins[0].time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                                      : '-'}
                                  </td>
                                  <td className="py-2 pr-4 text-gray-500">
                                    {person.checkins.length > 0
                                      ? (person.checkins[0].signerName || person.checkins[0].userName || '-')
                                      : '-'}
                                    {person.checkins.length > 0 && person.checkins[0].userName && person.checkins[0].signerName && (
                                      <span className="text-xs text-gray-400 ml-1">({person.checkins[0].userName})</span>
                                    )}
                                  </td>
                                  <td className="py-2 pr-4 text-orange-600">
                                    {person.checkouts.length > 0
                                      ? new Date(person.checkouts[0].time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                                      : '-'}
                                  </td>
                                  <td className="py-2 text-gray-500">
                                    {person.checkouts.length > 0
                                      ? (person.checkouts[0].signerName || person.checkouts[0].userName || '-')
                                      : '-'}
                                    {person.checkouts.length > 0 && person.checkouts[0].userName && person.checkouts[0].signerName && (
                                      <span className="text-xs text-gray-400 ml-1">({person.checkouts[0].userName})</span>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>

                        {historyDetail.individuals.length === 0 && (
                          <p className="text-center text-sm text-gray-500 py-3">No records for this date.</p>
                        )}
                      </>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default CheckInHistory;
