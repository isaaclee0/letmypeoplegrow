import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUnsavedReviewGuard } from './useUnsavedReviewGuard';

function GuardHarness({
  dirty,
  onConfirmDiscard,
  onBack = vi.fn(),
  onRefresh = vi.fn(),
}: {
  dirty: boolean;
  onConfirmDiscard: () => void;
  onBack?: () => void;
  onRefresh?: () => void;
}) {
  const { confirmAction } = useUnsavedReviewGuard({ dirty, onConfirmDiscard });
  return <>
    <button type="button" onClick={() => confirmAction(onBack)}>Back to integration</button>
    <button type="button" onClick={() => confirmAction(onRefresh)}>Refresh plan</button>
    <a href="/app/settings">Settings</a>
  </>;
}

function capturedClickListener(spy: ReturnType<typeof vi.spyOn>) {
  const registration = spy.mock.calls.find(([type, , options]) => type === 'click' && options === true);
  if (!registration) throw new Error('The captured internal-link listener was not registered.');
  return registration[1] as EventListener;
}

function anchorEvent(anchor: HTMLAnchorElement, overrides: Partial<MouseEvent> = {}) {
  const preventDefault = vi.fn();
  const stopImmediatePropagation = vi.fn();
  const event = {
    target: anchor,
    button: 0,
    defaultPrevented: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault,
    stopImmediatePropagation,
    ...overrides,
  } as unknown as MouseEvent;
  return { event, preventDefault, stopImmediatePropagation };
}

describe('useUnsavedReviewGuard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs clean explicit back and refresh actions without prompting', () => {
    const onBack = vi.fn();
    const onRefresh = vi.fn();
    render(<GuardHarness dirty={false} onConfirmDiscard={vi.fn()} onBack={onBack} onRefresh={onRefresh} />);

    fireEvent.click(screen.getByRole('button', { name: 'Back to integration' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh plan' }));

    expect(window.confirm).not.toHaveBeenCalled();
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('keeps dirty explicit actions in place when cancelled and discards before confirmed actions', () => {
    const onConfirmDiscard = vi.fn();
    const onBack = vi.fn();
    const onRefresh = vi.fn();
    vi.mocked(window.confirm).mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<GuardHarness dirty onConfirmDiscard={onConfirmDiscard} onBack={onBack} onRefresh={onRefresh} />);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh plan' }));
    expect(onRefresh).not.toHaveBeenCalled();
    expect(onConfirmDiscard).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Back to integration' }));
    expect(onConfirmDiscard).toHaveBeenCalledTimes(1);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('captures dirty internal anchors and only lets a confirmed discard continue', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const onConfirmDiscard = vi.fn();
    vi.mocked(window.confirm).mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<GuardHarness dirty onConfirmDiscard={onConfirmDiscard} />);
    const listener = capturedClickListener(addSpy);
    const anchor = screen.getByRole('link', { name: 'Settings' }) as HTMLAnchorElement;

    const cancelled = anchorEvent(anchor);
    listener(cancelled.event);
    expect(cancelled.preventDefault).toHaveBeenCalledTimes(1);
    expect(cancelled.stopImmediatePropagation).toHaveBeenCalledTimes(1);
    expect(onConfirmDiscard).not.toHaveBeenCalled();

    const confirmed = anchorEvent(anchor);
    listener(confirmed.event);
    expect(confirmed.preventDefault).not.toHaveBeenCalled();
    expect(onConfirmDiscard).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['modified clicks', { metaKey: true }, {}],
    ['downloads', {}, { download: 'people.csv' }],
    ['new tabs', {}, { target: '_blank' }],
    ['same-page hashes', {}, { href: `${window.location.pathname}${window.location.search}#review` }],
    ['external origins', {}, { href: 'https://example.net/leave' }],
  ])('does not intercept %s', (_label, eventOverrides, anchorAttributes) => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    render(<GuardHarness dirty onConfirmDiscard={vi.fn()} />);
    const listener = capturedClickListener(addSpy);
    const anchor = document.createElement('a');
    anchor.href = '/app/settings';
    for (const [name, value] of Object.entries(anchorAttributes)) anchor.setAttribute(name, value);
    const click = anchorEvent(anchor, eventOverrides as Partial<MouseEvent>);

    listener(click.event);

    expect(window.confirm).not.toHaveBeenCalled();
    expect(click.preventDefault).not.toHaveBeenCalled();
  });

  it('marks a dirty browser unload as requiring native confirmation', () => {
    render(<GuardHarness dirty onConfirmDiscard={vi.fn()} />);
    const event = new Event('beforeunload', { cancelable: true });

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(event.returnValue).toBe(false);
  });

  it('restores the prior history entry when dirty browser back navigation is cancelled', () => {
    const onConfirmDiscard = vi.fn();
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => undefined);
    vi.mocked(window.confirm).mockReturnValue(false);
    render(<GuardHarness dirty onConfirmDiscard={onConfirmDiscard} />);

    window.dispatchEvent(new PopStateEvent('popstate'));

    expect(go).toHaveBeenCalledWith(1);
    expect(onConfirmDiscard).not.toHaveBeenCalled();
  });

  it('reverses cancelled forward navigation without prompting again for the restoration event', () => {
    const originalState = window.history.state;
    window.history.replaceState({ ...originalState, idx: 5 }, '');
    const onConfirmDiscard = vi.fn();
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => undefined);
    vi.mocked(window.confirm).mockReturnValue(false);
    render(<GuardHarness dirty onConfirmDiscard={onConfirmDiscard} />);

    window.dispatchEvent(new PopStateEvent('popstate', { state: { idx: 6 } }));
    expect(go).toHaveBeenCalledWith(-1);
    expect(window.confirm).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new PopStateEvent('popstate', { state: { idx: 5 } }));
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenCalledTimes(1);
    window.history.replaceState(originalState, '');
  });

  it('allows confirmed browser back navigation and reports the discarded review', () => {
    const onConfirmDiscard = vi.fn();
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => undefined);
    render(<GuardHarness dirty onConfirmDiscard={onConfirmDiscard} />);

    window.dispatchEvent(new PopStateEvent('popstate'));

    expect(go).not.toHaveBeenCalled();
    expect(onConfirmDiscard).toHaveBeenCalledTimes(1);
  });

  it('removes dirty listeners after apply makes the review clean and again on unmount', () => {
    const addWindow = vi.spyOn(window, 'addEventListener');
    const removeWindow = vi.spyOn(window, 'removeEventListener');
    const addDocument = vi.spyOn(document, 'addEventListener');
    const removeDocument = vi.spyOn(document, 'removeEventListener');
    const { rerender, unmount } = render(<GuardHarness dirty onConfirmDiscard={vi.fn()} />);

    const beforeUnload = addWindow.mock.calls.find(([type]) => type === 'beforeunload')?.[1];
    const popState = addWindow.mock.calls.find(([type]) => type === 'popstate')?.[1];
    const internalClick = addDocument.mock.calls.find(([type, , options]) => type === 'click' && options === true)?.[1];
    expect(beforeUnload).toBeDefined();
    expect(popState).toBeDefined();
    expect(internalClick).toBeDefined();

    rerender(<GuardHarness dirty={false} onConfirmDiscard={vi.fn()} />);
    expect(removeWindow).toHaveBeenCalledWith('beforeunload', beforeUnload);
    expect(removeWindow).toHaveBeenCalledWith('popstate', popState);
    expect(removeDocument).toHaveBeenCalledWith('click', internalClick, true);

    rerender(<GuardHarness dirty onConfirmDiscard={vi.fn()} />);
    const latestBeforeUnload = [...addWindow.mock.calls].reverse().find(([type]) => type === 'beforeunload')?.[1];
    unmount();
    expect(removeWindow).toHaveBeenCalledWith('beforeunload', latestBeforeUnload);
  });
});
