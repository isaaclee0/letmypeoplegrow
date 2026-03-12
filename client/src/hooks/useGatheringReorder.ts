import { useState, useRef, useCallback, useEffect } from 'react';
import { GatheringType } from '../services/api';
import { userPreferences } from '../services/userPreferences';
import logger from '../utils/logger';

interface UseGatheringReorderParams {
  gatherings: GatheringType[];
  userId: number | undefined;
}

interface UseGatheringReorderReturn {
  orderedGatherings: GatheringType[];
  showReorderModal: boolean;
  reorderList: GatheringType[];
  openReorderModal: () => void;
  closeReorderModal: () => void;
  onReorderDragStart: (index: number) => void;
  onReorderDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onReorderDrop: (index: number) => void;
  moveItemUp: (index: number) => void;
  saveReorder: () => Promise<void>;
}

export function useGatheringReorder({
  gatherings,
  userId,
}: UseGatheringReorderParams): UseGatheringReorderReturn {
  const [orderedGatherings, setOrderedGatherings] = useState<GatheringType[]>([]);
  const [showReorderModal, setShowReorderModal] = useState(false);
  const [reorderList, setReorderList] = useState<GatheringType[]>([]);
  const dragIndexRef = useRef<number | null>(null);

  const loadSavedOrder = useCallback(async (items: GatheringType[]) => {
    if (!userId) return items;
    try {
      const savedOrder = await userPreferences.getGatheringOrder();
      if (!savedOrder?.order) return items;

      const orderIds: number[] = savedOrder.order;
      const idToItem = new Map(items.map(i => [i.id, i]));
      const ordered: GatheringType[] = [];
      orderIds.forEach(id => {
        const item = idToItem.get(id);
        if (item) ordered.push(item);
      });
      items.forEach(i => { if (!orderIds.includes(i.id)) ordered.push(i); });
      return ordered;
    } catch (e) {
      logger.warn('Failed to load saved gathering order', e);
      return items;
    }
  }, [userId]);

  useEffect(() => {
    const loadOrder = async () => {
      const ordered = await loadSavedOrder(gatherings);
      setOrderedGatherings(ordered);
    };
    loadOrder();
  }, [gatherings, loadSavedOrder]);

  const saveOrder = useCallback(async (items: GatheringType[]) => {
    if (!userId) return;
    const ids = items.map(i => i.id);
    try {
      await userPreferences.setGatheringOrder(ids);
    } catch (e) {
      logger.warn('Failed to save gathering order', e);
    }
  }, [userId]);

  const openReorderModal = () => {
    const items = (orderedGatherings.length ? orderedGatherings : gatherings).slice();
    setReorderList(items);
    setShowReorderModal(true);
  };

  const closeReorderModal = () => setShowReorderModal(false);

  const onReorderDragStart = (index: number) => {
    dragIndexRef.current = index;
  };

  const onReorderDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  const onReorderDrop = (index: number) => {
    const fromIndex = dragIndexRef.current;
    dragIndexRef.current = null;
    if (fromIndex == null || fromIndex === index) return;
    setReorderList(prev => {
      const next = prev.slice();
      const [moved] = next.splice(fromIndex, 1);
      next.splice(index, 0, moved);
      return next;
    });
  };

  const moveItemUp = (index: number) => {
    if (index <= 0) return;
    setReorderList(prev => {
      const next = prev.slice();
      const [moved] = next.splice(index, 1);
      next.splice(index - 1, 0, moved);
      return next;
    });
  };

  const saveReorder = async () => {
    setOrderedGatherings(reorderList);
    await saveOrder(reorderList);
    // Persist default gathering as first item for cross-page defaults
    if (userId && reorderList.length > 0) {
      localStorage.setItem(`user_${userId}_default_gathering_id`, String(reorderList[0].id));
    }
    setShowReorderModal(false);
  };

  return {
    orderedGatherings,
    showReorderModal,
    reorderList,
    openReorderModal,
    closeReorderModal,
    onReorderDragStart,
    onReorderDragOver,
    onReorderDrop,
    moveItemUp,
    saveReorder,
  };
}
