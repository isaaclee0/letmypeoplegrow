import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Bars3Icon, XMarkIcon } from '@heroicons/react/24/outline';
import { REPORT_PANEL_METADATA, type ReportLayout, type ReportPanelId } from './reportLayout';

interface DragState { id: ReportPanelId; pointerId: number; x: number; y: number; order: ReportPanelId[]; target: ReportPanelId | null; }
interface GridContextValue {
  layout: ReportLayout; displayOrder: ReportPanelId[]; editing: boolean;
  unavailable: Partial<Record<ReportPanelId, string>>; onReorder(order: ReportPanelId[]): void; onHide(id: ReportPanelId): void;
  drag: DragState | null; startPointerDrag(id: ReportPanelId, event: React.PointerEvent<HTMLButtonElement>): void;
  registerPanel(id: ReportPanelId, element: HTMLDivElement | null): void;
}
const GridContext = createContext<GridContextValue | null>(null);

interface ReportPanelGridProps { layout: ReportLayout; editing: boolean; unavailable: Partial<Record<ReportPanelId, string>>; onReorder(order: ReportPanelId[]): void; onHide(id: ReportPanelId): void; children: React.ReactNode; }

function visiblePanelIds(order: ReportPanelId[], layout: ReportLayout, unavailable: Partial<Record<ReportPanelId, string>>) {
  return order.filter((id) => !layout.hidden.includes(id) && !unavailable[id]);
}
function mergeAvailableOrder(layout: ReportLayout, unavailable: Partial<Record<ReportPanelId, string>>, availableOrder: ReportPanelId[]) {
  let availableIndex = 0;
  return layout.order.filter((id) => !layout.hidden.includes(id)).map((id) => unavailable[id] ? id : availableOrder[availableIndex++]);
}

export const ReportPanelGrid: React.FC<ReportPanelGridProps> = ({ layout, editing, unavailable, onReorder, onHide, children }) => {
  const [drag, setDrag] = useState<DragState | null>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const panelElements = useRef(new Map<ReportPanelId, HTMLDivElement>());
  const previousRects = useRef(new Map<ReportPanelId, DOMRect>());
  const captureRects = useCallback(() => { previousRects.current = new Map([...panelElements.current].map(([id, element]) => [id, element.getBoundingClientRect()])); }, []);
  const registerPanel = useCallback((id: ReportPanelId, element: HTMLDivElement | null) => { if (element) panelElements.current.set(id, element); else panelElements.current.delete(id); }, []);
  const startPointerDrag = useCallback((id: ReportPanelId, event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button && event.button !== 0) return;
    event.preventDefault(); event.currentTarget.setPointerCapture?.(event.pointerId); captureRects();
    setDrag({ id, pointerId: event.pointerId || 1, x: event.clientX || 0, y: event.clientY || 0, order: layout.order, target: null });
  }, [captureRects, layout.order]);
  const updateDrag = useCallback((event: PointerEvent) => {
    const x = event.clientX || 0;
    const y = event.clientY || 0;
    if (ghostRef.current) ghostRef.current.style.transform = `translate3d(${x + 14}px, ${y + 14}px, 0)`;
    setDrag((current) => {
      if (!current || (event.pointerId && current.pointerId !== event.pointerId)) return current;
      const elements = document.elementsFromPoint?.(event.clientX, event.clientY) ?? [];
      const panel = elements.map((element) => element instanceof HTMLElement ? element.closest<HTMLElement>('[data-report-panel]') : null).find((element): element is HTMLElement => Boolean(element && element.dataset.reportPanel !== current.id));
      const target = panel?.dataset.reportPanel as ReportPanelId | undefined;
      if (!target) return current.target === null ? current : { ...current, target: null };
      const available = visiblePanelIds(current.order, layout, unavailable);
      if (!available.includes(target)) return current.target === null ? current : { ...current, target: null };
      const next = available.filter((id) => id !== current.id);
      const rect = panel.getBoundingClientRect();
      const insertAt = next.indexOf(target) + (event.clientY > rect.top + rect.height / 2 ? 1 : 0);
      next.splice(insertAt, 0, current.id);
      const nextOrder = mergeAvailableOrder(layout, unavailable, next);
      if (nextOrder.some((id, index) => id !== current.order[index])) captureRects();
      const orderChanged = nextOrder.some((id, index) => id !== current.order[index]);
      if (!orderChanged && current.target === target) return current;
      return { ...current, order: nextOrder, target };
    });
  }, [captureRects, layout, unavailable]);
  const finishDrag = useCallback((event: PointerEvent, cancel = false) => {
    setDrag((current) => {
      if (!current || (event.pointerId && current.pointerId !== event.pointerId)) return current;
      if (!cancel && current.order.some((id, index) => id !== layout.order[index])) onReorder(current.order);
      return null;
    });
  }, [layout.order, onReorder]);
  const isDragging = Boolean(drag);
  useEffect(() => {
    if (!isDragging) return undefined;
    const onCancel = (event: PointerEvent) => finishDrag(event, true);
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setDrag(null); } };
    window.addEventListener('pointermove', updateDrag); window.addEventListener('pointerup', finishDrag); window.addEventListener('pointercancel', onCancel); window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('pointermove', updateDrag); window.removeEventListener('pointerup', finishDrag); window.removeEventListener('pointercancel', onCancel); window.removeEventListener('keydown', onKeyDown); };
  }, [finishDrag, isDragging, updateDrag]);
  const displayOrder = drag?.order ?? layout.order;
  const displayOrderKey = displayOrder.join('|');
  useLayoutEffect(() => {
    if (!drag) return;
    const nextRects = new Map([...panelElements.current].map(([id, element]) => [id, element.getBoundingClientRect()]));
    nextRects.forEach((rect, id) => {
      if (id === drag.id) return;
      const previous = previousRects.current.get(id); const x = previous ? previous.left - rect.left : 0; const y = previous ? previous.top - rect.top : 0;
      if ((x || y) && panelElements.current.get(id)?.animate) panelElements.current.get(id)?.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: 'translate(0, 0)' }], { duration: 180, easing: 'ease-out' });
    });
    previousRects.current = nextRects;
  }, [displayOrderKey, drag?.id]);
  const visibleAvailable = visiblePanelIds(displayOrder, layout, unavailable);
  const value = useMemo(() => ({ layout, displayOrder, editing, unavailable, onReorder, onHide, drag, startPointerDrag, registerPanel }), [displayOrder, drag, editing, layout, onHide, onReorder, registerPanel, startPointerDrag, unavailable]);
  return <GridContext.Provider value={value}>
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2" data-report-panel-grid>
      {visibleAvailable.length === 0 ? <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-600 shadow-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 lg:col-span-2"><p className="font-medium text-gray-900 dark:text-gray-100">All report panels are hidden.</p><p className="mt-1">Use Customise layout to restore the panels you want to see.</p></div> : children}
    </div>
    {drag && <div ref={ghostRef} aria-hidden="true" data-testid="report-panel-ghost" className="pointer-events-none fixed left-0 top-0 z-50 w-44 rounded-lg border border-primary-300 bg-white/75 px-3 py-2 text-sm font-semibold text-gray-800 shadow-xl backdrop-blur-sm dark:border-primary-500 dark:bg-gray-800/75 dark:text-gray-100" style={{ transform: `translate3d(${drag.x + 14}px, ${drag.y + 14}px, 0)` }}><Bars3Icon className="mr-2 inline h-4 w-4" />{REPORT_PANEL_METADATA[drag.id].label}</div>}
  </GridContext.Provider>;
};

interface ReportPanelSectionHeadingProps { ids: ReportPanelId[]; children: React.ReactNode; description?: React.ReactNode; }
export const ReportPanelSectionHeading: React.FC<ReportPanelSectionHeadingProps> = ({ ids, children, description }) => {
  const context = useContext(GridContext); if (!context) return null;
  const visibleIds = ids.filter((id) => !context.layout.hidden.includes(id) && !context.unavailable[id]); if (visibleIds.length === 0) return null;
  const firstPanelOrder = Math.min(...visibleIds.map((id) => context.displayOrder.indexOf(id)));
  return <div className="px-1 pt-2 lg:col-span-2" style={{ order: firstPanelOrder * 2 }}><h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{children}</h2>{description && <div className="mt-1 space-y-1 text-sm text-gray-600 dark:text-gray-400">{description}</div>}</div>;
};
interface ReportPanelExpansionProps { after: ReportPanelId; children: React.ReactNode; }
export const ReportPanelExpansion: React.FC<ReportPanelExpansionProps> = ({ after, children }) => {
  const context = useContext(GridContext); if (!context) return <div className="lg:col-span-2">{children}</div>;
  if (context.layout.hidden.includes(after) || context.unavailable[after]) return null;
  const visibleIds = visiblePanelIds(context.displayOrder, context.layout, context.unavailable); const nextVisibleId = visibleIds[visibleIds.indexOf(after) + 1];
  const rowCompanion = nextVisibleId && !REPORT_PANEL_METADATA[after].fullWidth && !REPORT_PANEL_METADATA[nextVisibleId].fullWidth ? nextVisibleId : after;
  return <div className="min-w-0 lg:col-span-2" style={{ order: context.displayOrder.indexOf(rowCompanion) * 2 + 2 }}>{children}</div>;
};
interface ReportPanelProps { id: ReportPanelId; children: React.ReactNode; className?: string; }
export const ReportPanel: React.FC<ReportPanelProps> = ({ id, children, className = '' }) => {
  const context = useContext(GridContext); if (!context) return <>{children}</>;
  const { layout, displayOrder, editing, unavailable, onReorder, onHide, drag, startPointerDrag, registerPanel } = context;
  if (layout.hidden.includes(id) || unavailable[id]) return null;
  const move = (offset: -1 | 1) => { const visibleOrder = visiblePanelIds(displayOrder, layout, unavailable); const index = visibleOrder.indexOf(id); const destination = index + offset; if (index < 0 || destination < 0 || destination >= visibleOrder.length) return; const next = [...visibleOrder]; [next[index], next[destination]] = [next[destination], next[index]]; onReorder(mergeAvailableOrder(layout, unavailable, next)); };
  const fullWidth = REPORT_PANEL_METADATA[id].fullWidth;
  return <div ref={(element) => registerPanel(id, element)} data-report-panel={id} className={`relative flex min-w-0 flex-col transition-opacity ${fullWidth ? 'lg:col-span-2' : ''} ${editing ? 'rounded-xl ring-2 ring-primary-400 ring-offset-2 dark:ring-offset-gray-900' : ''} ${drag?.id === id ? 'opacity-35' : ''} ${drag?.target === id ? 'bg-primary-100/70 ring-primary-500 dark:bg-primary-900/40' : ''} ${className}`} style={{ order: displayOrder.indexOf(id) * 2 + 1 }}>
    {editing && <><button type="button" aria-label={`Drag ${REPORT_PANEL_METADATA[id].label}`} title="Drag to move. Use arrow keys to move without dragging." onPointerDown={(event) => startPointerDrag(id, event)} onKeyDown={(event) => { if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') { event.preventDefault(); move(-1); } else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') { event.preventDefault(); move(1); } }} className="absolute left-2 top-2 z-10 flex h-8 w-8 touch-none cursor-grab items-center justify-center rounded-full border border-gray-300 bg-white text-gray-600 shadow-sm hover:bg-gray-100 active:cursor-grabbing dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"><Bars3Icon className="h-5 w-5" /></button><button type="button" aria-label={`Hide ${REPORT_PANEL_METADATA[id].label}`} title="Hide panel" onClick={() => onHide(id)} className="absolute right-2 top-2 z-10 flex h-8 w-8 items-center justify-center rounded-full border border-gray-300 bg-white text-gray-600 shadow-sm hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"><XMarkIcon className="h-5 w-5" /></button></>}
    <div className={`min-h-0 flex-1 ${editing ? 'pt-11' : ''}`} data-report-panel-content>{children}</div>
  </div>;
};
