import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { format, parseISO } from 'date-fns';
import { individualsAPI } from '../../services/api';
import { buildAttendanceHistoryCsv, filterHistoryByGathering, AttendanceHistoryEntry } from '../../utils/attendanceHistoryCsv';

interface AttendanceHistoryResponse {
  lastAttendance: {
    date: string;
    gatheringName: string;
    gatheringId: number;
    recordedAt: string;
  } | null;
  gatheringRegularity: Array<{
    name: string;
    regularity: string;
    attendanceCount: number;
  }>;
  history: AttendanceHistoryEntry[];
}

interface AttendanceHistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  personId: number | null;
  personName: string;
}

const formatDate = (dateString: string) => {
  try {
    return format(parseISO(dateString), 'MMM d, yyyy');
  } catch {
    return dateString;
  }
};

const AttendanceHistoryModal: React.FC<AttendanceHistoryModalProps> = ({
  isOpen,
  onClose,
  personId,
  personName
}) => {
  const [data, setData] = useState<AttendanceHistoryResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedGatheringId, setSelectedGatheringId] = useState<number | null>(null);

  const fetchHistory = useCallback(async () => {
    if (!personId) return;
    setIsLoading(true);
    setError(null);
    try {
      const response = await individualsAPI.getAttendanceHistory(personId);
      setData(response.data);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to fetch attendance history');
      setData(null);
    } finally {
      setIsLoading(false);
    }
  }, [personId]);

  useEffect(() => {
    if (isOpen && personId) {
      setSelectedGatheringId(null);
      fetchHistory();
    }
  }, [isOpen, personId, fetchHistory]);

  const gatheringOptions = useMemo(() => {
    if (!data) return [];
    const seen = new Map<number, string>();
    data.history.forEach(row => seen.set(row.gatheringId, row.gatheringName));
    return Array.from(seen.entries()).map(([id, name]) => ({ id, name }));
  }, [data]);

  const filteredHistory = useMemo(() => {
    if (!data) return [];
    return filterHistoryByGathering(data.history, selectedGatheringId);
  }, [data, selectedGatheringId]);

  const handleExportCsv = () => {
    const csv = buildAttendanceHistoryCsv(filteredHistory);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `attendance-${personName.replace(/\s+/g, '-').toLowerCase()}-${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (!isOpen || !personId) return null;

  return createPortal(
    <div className="fixed inset-0 bg-gray-600/50 overflow-y-auto h-full w-full z-50">
      <div className="relative top-10 mx-auto p-5 border w-11/12 md:w-3/4 lg:w-2/3 shadow-lg rounded-md bg-white dark:bg-gray-800">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
            Attendance History: {personName}
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          >
            <XMarkIcon className="h-6 w-6" />
          </button>
        </div>

        {isLoading ? (
          <div className="text-center py-8 text-gray-500 dark:text-gray-400">Loading attendance history...</div>
        ) : error ? (
          <div className="text-center py-8">
            <div className="text-red-500 mb-3">{error}</div>
            <button
              onClick={fetchHistory}
              className="px-4 py-2 border border-gray-300 dark:border-gray-600 text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600"
            >
              Retry
            </button>
          </div>
        ) : data ? (
          <div className="space-y-4">
            <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-3 text-sm text-gray-700 dark:text-gray-300">
              {data.lastAttendance ? (
                <div>Last attended {formatDate(data.lastAttendance.date)} at {data.lastAttendance.gatheringName}</div>
              ) : (
                <div>No attendance records</div>
              )}
              {data.gatheringRegularity.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-x-4">
                  {data.gatheringRegularity.map(g => (
                    <span key={g.name}>{g.name}: {g.regularity} ({g.attendanceCount}x)</span>
                  ))}
                </div>
              )}
            </div>

            {gatheringOptions.length > 1 && (
              <div>
                <label htmlFor="gatheringFilter" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Gathering
                </label>
                <select
                  id="gatheringFilter"
                  value={selectedGatheringId ?? ''}
                  onChange={(e) => setSelectedGatheringId(e.target.value ? Number(e.target.value) : null)}
                  className="w-full sm:w-64 px-3 py-2 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
                >
                  <option value="">All gatherings</option>
                  {gatheringOptions.map(g => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
              </div>
            )}

            <div className="max-h-96 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-md">
              {filteredHistory.length === 0 ? (
                <div className="text-center py-8 text-gray-500 dark:text-gray-400">No attendance history recorded</div>
              ) : (
                <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                  <thead className="bg-gray-50 dark:bg-gray-700 sticky top-0">
                    <tr>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Date</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Gathering</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                    {filteredHistory.map((row, index) => (
                      <tr key={`${row.gatheringId}-${row.date}-${index}`}>
                        <td className="px-4 py-2 text-sm text-gray-900 dark:text-gray-100">{formatDate(row.date)}</td>
                        <td className="px-4 py-2 text-sm text-gray-900 dark:text-gray-100">{row.gatheringName}</td>
                        <td className="px-4 py-2 text-sm">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${row.present ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                            {row.present ? 'Present' : 'Absent'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        ) : null}

        <div className="mt-6 flex justify-end space-x-3">
          <button
            onClick={handleExportCsv}
            disabled={!data || filteredHistory.length === 0}
            className="px-4 py-2 border border-gray-300 dark:border-gray-600 text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50"
          >
            Export CSV
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700"
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default AttendanceHistoryModal;
