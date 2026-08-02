import { useCallback, useEffect } from 'react';

const DISCARD_PROMPT = 'You have unsaved review choices. Discard them and continue?';

export interface UnsavedReviewGuardOptions {
  dirty: boolean;
  onConfirmDiscard: () => void;
}

export interface UnsavedReviewGuard {
  confirmAction: <T>(action: () => T) => T | undefined;
}

function shouldGuardAnchor(event: MouseEvent): HTMLAnchorElement | null {
  if (event.defaultPrevented
    || event.button !== 0
    || event.altKey
    || event.ctrlKey
    || event.metaKey
    || event.shiftKey) return null;

  const target = event.target;
  if (!(target instanceof Element)) return null;
  const anchor = target.closest('a[href]');
  if (!(anchor instanceof HTMLAnchorElement)) return null;
  if (anchor.hasAttribute('download')) return null;
  if (anchor.target && anchor.target.toLowerCase() !== '_self') return null;

  const destination = new URL(anchor.href, window.location.href);
  const current = new URL(window.location.href);
  if (destination.origin !== current.origin) return null;
  if (destination.pathname === current.pathname && destination.search === current.search) {
    if (destination.hash !== current.hash || destination.href === current.href) return null;
  }
  return anchor;
}

export function useUnsavedReviewGuard({
  dirty,
  onConfirmDiscard,
}: UnsavedReviewGuardOptions): UnsavedReviewGuard {
  const confirmAction = useCallback(<T,>(action: () => T): T | undefined => {
    if (dirty && !window.confirm(DISCARD_PROMPT)) return undefined;
    if (dirty) onConfirmDiscard();
    return action();
  }, [dirty, onConfirmDiscard]);

  useEffect(() => {
    if (!dirty) return undefined;

    const currentEntryIndex = typeof window.history.state?.idx === 'number'
      ? window.history.state.idx as number
      : null;
    let restoringHistory = false;

    const confirmDiscard = () => {
      if (!window.confirm(DISCARD_PROMPT)) return false;
      onConfirmDiscard();
      return true;
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    const internalLink = (event: MouseEvent) => {
      if (!shouldGuardAnchor(event)) return;
      if (confirmDiscard()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const popState = (event: PopStateEvent) => {
      if (restoringHistory) {
        restoringHistory = false;
        return;
      }
      if (confirmDiscard()) return;
      const destinationIndex = typeof event.state?.idx === 'number' ? event.state.idx as number : null;
      const restoreDelta = currentEntryIndex !== null && destinationIndex !== null
        ? currentEntryIndex - destinationIndex
        : 1;
      restoringHistory = true;
      window.history.go(restoreDelta || 1);
    };

    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('popstate', popState);
    document.addEventListener('click', internalLink, true);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('popstate', popState);
      document.removeEventListener('click', internalLink, true);
    };
  }, [dirty, onConfirmDiscard]);

  return { confirmAction };
}
