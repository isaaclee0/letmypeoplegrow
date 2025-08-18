/**
 * Shared hooks for people management functionality
 * Used by both AttendancePage and PeoplePage for consistent patterns
 */
import { useState, useCallback, useRef } from 'react';
import { useToast } from '../components/ToastContainer';
import { individualsAPI, familiesAPI } from '../services/api';

export interface Person {
  id: number;
  firstName: string;
  lastName: string;
  peopleType: 'regular' | 'local_visitor' | 'traveller_visitor';
  familyId?: number;
  familyName?: string;
  present?: boolean;
  gatheringAssignments?: Array<{
    id: number;
    name: string;
  }>;
}

export interface Family {
  id: number;
  familyName: string;
  memberCount: number;
  familyType?: 'regular' | 'local_visitor' | 'traveller_visitor';
}

/**
 * Hook for managing people and families data
 */
export const usePeopleData = () => {
  const [people, setPeople] = useState<Person[]>([]);
  const [families, setFamilies] = useState<Family[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const { showSuccess } = useToast();

  const loadPeople = useCallback(async () => {
    try {
      setIsLoading(true);
      setError('');
      const response = await individualsAPI.getAll();
      const peopleData = response.data.people || [];
      
      // Deduplicate people by ID to ensure no duplicates are displayed
      const uniquePeople = Array.from(
        new Map(peopleData.map((person: Person) => [person.id, person])).values()
      ) as Person[];
      
      setPeople(uniquePeople);
    } catch (err: any) {
      const errorMessage = err.response?.data?.error || 'Failed to load people';
      setError(errorMessage);
      console.error('Error loading people:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const loadFamilies = useCallback(async () => {
    try {
      const response = await familiesAPI.getAll();
      setFamilies(response.data.families || []);
    } catch (err: any) {
      console.error('Failed to load families:', err);
    }
  }, []);

  const reloadAll = useCallback(async () => {
    await Promise.all([loadPeople(), loadFamilies()]);
  }, [loadPeople, loadFamilies]);

  return {
    people,
    setPeople,
    families,
    setFamilies,
    isLoading,
    error,
    setError,
    loadPeople,
    loadFamilies,
    reloadAll,
    showSuccess
  };
};

/**
 * Hook for managing selection state
 */
export const useSelection = <T extends { id: number }>() => {
  const [selectedItems, setSelectedItems] = useState<number[]>([]);

  const toggleSelection = useCallback((itemId: number) => {
    setSelectedItems(prev => 
      prev.includes(itemId) 
        ? prev.filter(id => id !== itemId)
        : [...prev, itemId]
    );
  }, []);

  const selectAll = useCallback((items: T[]) => {
    setSelectedItems(items.map(item => item.id));
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedItems([]);
  }, []);

  const toggleGroupSelection = useCallback((items: T[]) => {
    const allSelected = items.every(item => selectedItems.includes(item.id));
    if (allSelected) {
      setSelectedItems(prev => prev.filter(id => !items.map(item => item.id).includes(id)));
    } else {
      setSelectedItems(prev => [...prev, ...items.map(item => item.id)]);
    }
  }, [selectedItems]);

  return {
    selectedItems,
    setSelectedItems,
    toggleSelection,
    selectAll,
    clearSelection,
    toggleGroupSelection
  };
};

/**
 * Hook for managing optimistic updates with rollback capability
 */
export const useOptimisticUpdates = <T extends { id: number }>() => {
  const [items, setItems] = useState<T[]>([]);
  const rollbackRef = useRef<Map<number, T>>(new Map());

  const applyOptimisticUpdate = useCallback((itemId: number, updates: Partial<T>) => {
    setItems(prev => {
      const itemIndex = prev.findIndex(item => item.id === itemId);
      if (itemIndex === -1) return prev;

      // Store original for potential rollback
      if (!rollbackRef.current.has(itemId)) {
        rollbackRef.current.set(itemId, { ...prev[itemIndex] });
      }

      const newItems = [...prev];
      newItems[itemIndex] = { ...newItems[itemIndex], ...updates };
      return newItems;
    });
  }, []);

  const commitUpdate = useCallback((itemId: number) => {
    rollbackRef.current.delete(itemId);
  }, []);

  const rollbackUpdate = useCallback((itemId: number) => {
    const original = rollbackRef.current.get(itemId);
    if (original) {
      setItems(prev => {
        const itemIndex = prev.findIndex(item => item.id === itemId);
        if (itemIndex === -1) return prev;
        
        const newItems = [...prev];
        newItems[itemIndex] = original;
        return newItems;
      });
      rollbackRef.current.delete(itemId);
    }
  }, []);

  const clearRollbacks = useCallback(() => {
    rollbackRef.current.clear();
  }, []);

  return {
    items,
    setItems,
    applyOptimisticUpdate,
    commitUpdate,
    rollbackUpdate,
    clearRollbacks
  };
};

/**
 * Hook for managing async operations with loading states
 */
export const useAsyncOperation = () => {
  const [operationStates, setOperationStates] = useState<Record<string, boolean>>({});
  const { showSuccess } = useToast();

  const executeOperation = useCallback(async <T>(
    key: string,
    operation: () => Promise<T>,
    successMessage?: string
  ): Promise<T | null> => {
    try {
      setOperationStates(prev => ({ ...prev, [key]: true }));
      const result = await operation();
      
      if (successMessage) {
        showSuccess(successMessage);
      }
      
      return result;
    } catch (error) {
      console.error(`Operation ${key} failed:`, error);
      throw error;
    } finally {
      setOperationStates(prev => ({ ...prev, [key]: false }));
    }
  }, [showSuccess]);

  const isOperationLoading = useCallback((key: string) => {
    return operationStates[key] || false;
  }, [operationStates]);

  return {
    executeOperation,
    isOperationLoading
  };
};

/**
 * Hook for managing gathering assignments
 */
export const useGatheringAssignments = () => {
  const executeAssignmentChange = useCallback(async (
    personId: number,
    gatheringId: number,
    isAssigned: boolean
  ) => {
    if (isAssigned) {
      await individualsAPI.assignToGathering(personId, gatheringId);
    } else {
      await individualsAPI.unassignFromGathering(personId, gatheringId);
    }
  }, []);

  const syncAssignments = useCallback(async (
    personId: number,
    currentAssignments: Set<number>,
    targetAssignments: Record<number, boolean>
  ) => {
    const promises: Promise<any>[] = [];
    
    Object.entries(targetAssignments).forEach(([gatheringIdStr, shouldBeAssigned]) => {
      const gatheringId = parseInt(gatheringIdStr);
      const isCurrentlyAssigned = currentAssignments.has(gatheringId);
      
      if (shouldBeAssigned && !isCurrentlyAssigned) {
        promises.push(individualsAPI.assignToGathering(personId, gatheringId));
      } else if (!shouldBeAssigned && isCurrentlyAssigned) {
        promises.push(individualsAPI.unassignFromGathering(personId, gatheringId));
      }
    });
    
    await Promise.all(promises);
  }, []);

  return {
    executeAssignmentChange,
    syncAssignments
  };
};

/**
 * Hook for managing family operations
 */
export const useFamilyOperations = () => {
  const resolveFamilyId = useCallback(async (
    familyInput: string,
    families: Family[]
  ): Promise<number | undefined> => {
    const input = familyInput.trim();
    if (!input) return undefined;
    
    const match = families.find(f => f.familyName.toLowerCase() === input.toLowerCase());
    if (match) {
      return match.id;
    } else {
      const created = await familiesAPI.create({ familyName: input });
      return created.data.id;
    }
  }, []);

  return {
    resolveFamilyId
  };
};
