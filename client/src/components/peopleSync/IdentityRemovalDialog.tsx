import React from 'react';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';

export interface IdentityRemovalDialogProps {
  open: boolean;
  externalName: string;
  pairedIndividualId: number | null;
  onRejectPair: (individualId: number) => void;
  onSkip: () => void;
  onClose: () => void;
}

export default function IdentityRemovalDialog({
  open,
  externalName,
  pairedIndividualId,
  onRejectPair,
  onSkip,
  onClose,
}: IdentityRemovalDialogProps) {
  return (
    <Dialog open={open} onClose={() => onClose()} className="relative z-50">
      <div className="fixed inset-0 bg-black/40" aria-hidden="true" />
      <div className="fixed inset-0 overflow-y-auto p-4">
        <div className="flex min-h-full items-start justify-center py-4 sm:items-center">
          <DialogPanel className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl dark:bg-gray-800">
            <div className="flex items-start justify-between gap-4">
              <DialogTitle className="text-lg font-semibold text-gray-950 dark:text-white">
                Remove matching decision for {externalName}
              </DialogTitle>
              <button
                type="button"
                onClick={() => onClose()}
                aria-label="Close remove matching decision"
                className="rounded-md px-2 py-1 text-2xl leading-none text-gray-500 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:text-gray-300 dark:hover:bg-gray-700"
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>

            <p className="mt-3 text-sm text-gray-600 dark:text-gray-300">
              This changes only the pending review decision. Nothing is changed until you apply the reviewed sync.
            </p>

            <div className="mt-5 space-y-3">
              {pairedIndividualId !== null && (
                <button
                  type="button"
                  aria-label="Reject this match"
                  onClick={() => onRejectPair(pairedIndividualId)}
                  className="block w-full rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-left focus:outline-none focus:ring-2 focus:ring-red-500 dark:border-red-800 dark:bg-red-950/30"
                >
                  <span className="block text-sm font-semibold text-red-800 dark:text-red-200">Reject this match</span>
                  <span className="mt-1 block text-xs text-red-700 dark:text-red-300">
                    Remember this exact pair as rejected and hold it for a later manual review.
                  </span>
                </button>
              )}
              <button
                type="button"
                aria-label="Skip and ask again"
                onClick={() => onSkip()}
                className="block w-full rounded-lg border border-gray-300 bg-white px-4 py-3 text-left focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700"
              >
                <span className="block text-sm font-semibold text-gray-900 dark:text-white">Skip and ask again</span>
                <span className="mt-1 block text-xs text-gray-600 dark:text-gray-300">
                  Hold this provider person for a later manual review without rejecting an exact pair.
                </span>
              </button>
            </div>
          </DialogPanel>
        </div>
      </div>
    </Dialog>
  );
}
