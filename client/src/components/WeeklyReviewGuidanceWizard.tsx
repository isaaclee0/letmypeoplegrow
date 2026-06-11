import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { aiAPI, gatheringsAPI } from '../services/api';

interface GatheringNote {
  name: string;
  note: string;
}

interface Answers {
  focus: string;
  gatheringNotes: GatheringNote[];
  avoid: string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSaved?: (guidance: string) => void;
}

const WeeklyReviewGuidanceWizard: React.FC<Props> = ({ isOpen, onClose, onSaved }) => {
  const [stage, setStage] = useState<'edit' | 'distilling' | 'review'>('edit');
  const [answers, setAnswers] = useState<Answers>({ focus: '', gatheringNotes: [], avoid: '' });
  const [summary, setSummary] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isOpen) return;
    setStage('edit');
    setError('');
    setSummary('');
    setLoading(true);
    (async () => {
      try {
        const [gRes, gdRes] = await Promise.all([
          gatheringsAPI.getAll(),
          aiAPI.getWeeklyGuidance(),
        ]);
        const gatherings = (gRes.data?.gatherings || []).filter(
          (g: any) => g.isActive === true || g.isActive === undefined
        );
        const savedInputs = gdRes.data?.inputs as Answers | null;
        const noteByName = new Map<string, string>(
          (savedInputs?.gatheringNotes || []).map((n: GatheringNote) => [n.name, n.note])
        );
        setAnswers({
          focus: savedInputs?.focus || '',
          avoid: savedInputs?.avoid || '',
          gatheringNotes: gatherings.map((g: any) => ({
            name: g.name,
            note: noteByName.get(g.name) || '',
          })),
        });
      } catch {
        setError('Could not load your gatherings. Please try again.');
      } finally {
        setLoading(false);
      }
    })();
  }, [isOpen]);

  const updateNote = (idx: number, note: string) =>
    setAnswers(a => ({
      ...a,
      gatheringNotes: a.gatheringNotes.map((n, i) => (i === idx ? { ...n, note } : n)),
    }));

  const handleDistill = async () => {
    setStage('distilling');
    setError('');
    try {
      const res = await aiAPI.distillWeeklyGuidance(answers);
      const s = (res.data?.summary || '').trim();
      if (!s) {
        setError(
          'We could not build any guidance from those answers. Add a little more detail and try again.'
        );
        setStage('edit');
        return;
      }
      setSummary(s);
      setStage('review');
    } catch {
      setError('Something went wrong generating your guidance. Please try again.');
      setStage('edit');
    }
  };

  const handleSave = async () => {
    try {
      await aiAPI.saveWeeklyGuidance({ guidance: summary, inputs: answers });
      onSaved?.(summary);
      onClose();
    } catch {
      setError('Failed to save. Please try again.');
    }
  };

  if (!isOpen) return null;

  const modalRoot = document.getElementById('modal-root') || document.body;

  return createPortal(
    <div className="fixed inset-0 bg-gray-600/50 overflow-y-auto h-full w-full z-[9999]">
      <div className="flex items-center justify-center min-h-screen p-4">
        <div className="relative w-11/12 md:w-3/4 lg:w-1/2 max-w-lg p-5 border shadow-lg rounded-md bg-white dark:bg-gray-800 dark:border-gray-700">
          {/* Header */}
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
              Customize AI insights
            </h3>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            >
              <XMarkIcon className="h-6 w-6" />
            </button>
          </div>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            A few optional notes help the weekly email understand your church.
          </p>

          {/* Error */}
          {error && (
            <div className="mb-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md p-3">
              <div className="text-sm text-red-700 dark:text-red-400">{error}</div>
            </div>
          )}

          {/* Loading */}
          {loading ? (
            <div className="py-8 text-center text-gray-500 dark:text-gray-400">Loading…</div>
          ) : stage === 'edit' ? (
            <div className="space-y-4">
              {/* Focus question */}
              <label className="block">
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  What does your church most want to keep an eye on this season?
                </span>
                <textarea
                  className="mt-1 w-full border border-gray-300 dark:border-gray-600 rounded-md p-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  rows={2}
                  value={answers.focus}
                  maxLength={1000}
                  onChange={e => setAnswers(a => ({ ...a, focus: e.target.value }))}
                />
              </label>

              {/* Per-gathering notes */}
              {answers.gatheringNotes.length > 0 && (
                <div>
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    Anything unusual about who attends these gatherings?
                  </span>
                  <div className="mt-1 space-y-2">
                    {answers.gatheringNotes.map((g, i) => (
                      <div key={g.name}>
                        <div className="text-xs text-gray-500 dark:text-gray-400 mb-0.5">
                          {g.name}
                        </div>
                        <input
                          className="w-full border border-gray-300 dark:border-gray-600 rounded-md p-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                          maxLength={500}
                          placeholder="e.g. youth group — adults present are leaders"
                          value={g.note}
                          onChange={e => updateNote(i, e.target.value)}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Avoid question */}
              <label className="block">
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  Anything the weekly email should avoid mentioning?
                </span>
                <textarea
                  className="mt-1 w-full border border-gray-300 dark:border-gray-600 rounded-md p-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  rows={2}
                  value={answers.avoid}
                  maxLength={1000}
                  onChange={e => setAnswers(a => ({ ...a, avoid: e.target.value }))}
                />
              </label>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600"
                  onClick={onClose}
                >
                  Cancel
                </button>
                <button
                  className="px-4 py-2 border border-transparent rounded-md text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
                  onClick={handleDistill}
                >
                  Generate guidance
                </button>
              </div>
            </div>
          ) : stage === 'distilling' ? (
            <div className="py-8 text-center text-gray-500 dark:text-gray-400">
              Generating your guidance…
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Here's what the weekly insight will know about your church. Save it, or go back
                and adjust your answers.
              </p>
              <div className="bg-gray-50 dark:bg-gray-700/50 border border-gray-200 dark:border-gray-600 rounded-md p-3 text-sm whitespace-pre-wrap text-gray-800 dark:text-gray-200">
                {summary}
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600"
                  onClick={() => setStage('edit')}
                >
                  Back to answers
                </button>
                <button
                  className="px-4 py-2 border border-transparent rounded-md text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
                  onClick={handleSave}
                >
                  Save guidance
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    modalRoot
  );
};

export default WeeklyReviewGuidanceWizard;
