import React, { useId, useState } from 'react';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import Modal from '../Modal';

interface GatheringAutoRemoveControlProps {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

export default function GatheringAutoRemoveControl({
  checked,
  disabled = false,
  onChange,
}: GatheringAutoRemoveControlProps) {
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const headingId = useId();

  const toggle = () => {
    if (checked) {
      onChange(false);
      return;
    }

    setConfirmationOpen(true);
  };

  const enable = () => {
    onChange(true);
    setConfirmationOpen(false);
  };

  return (
    <>
      <div className="flex items-start justify-between gap-4 rounded-lg border border-gray-200 bg-gray-50/60 p-4 dark:border-gray-700 dark:bg-gray-800/40">
        <div>
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
            Remove people who no longer match
          </p>
          <p className="mt-1 text-xs leading-5 text-gray-500 dark:text-gray-400">
            Automatically remove people from this gathering when they stop matching this batch.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-label="Automatically remove people from this gathering"
          aria-checked={checked}
          disabled={disabled}
          onClick={toggle}
          className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 dark:focus:ring-offset-gray-900 disabled:cursor-not-allowed disabled:opacity-50 ${
            checked ? 'bg-green-600' : 'bg-gray-200 dark:bg-gray-600'
          }`}
        >
          <span
            aria-hidden="true"
            className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
              checked ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      <Modal isOpen={confirmationOpen} onClose={() => setConfirmationOpen(false)}>
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={headingId}
          className="relative w-full max-w-md rounded-lg bg-white p-6 shadow-xl dark:bg-gray-800"
        >
          <div className="flex items-start gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/30">
              <ExclamationTriangleIcon className="h-6 w-6 text-amber-600 dark:text-amber-400" aria-hidden="true" />
            </div>
            <div>
              <h3 id={headingId} className="text-lg font-medium text-gray-900 dark:text-gray-100">
                Enable automatic removal for this batch?
              </h3>
              <p className="mt-2 text-sm leading-6 text-gray-600 dark:text-gray-400">
                People who stop matching this batch will be removed from its gathering. Their person records and attendance history will remain.
              </p>
            </div>
          </div>
          <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={() => setConfirmationOpen(false)}
              className="inline-flex justify-center rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={enable}
              className="inline-flex justify-center rounded-md border border-transparent bg-amber-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-amber-700 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2"
            >
              Enable automatic removal
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
