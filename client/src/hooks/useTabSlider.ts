import { useState, useRef, useEffect, useCallback } from 'react';

export interface UseTabSliderReturn {
  tabSliderRef: React.RefObject<HTMLDivElement>;
  desktopTabSliderRef: React.RefObject<HTMLDivElement>;
  showRightFade: boolean;
  showDesktopRightFade: boolean;
  showLeftFade: boolean;
  showDesktopLeftFade: boolean;
  handleMouseDown: (e: React.MouseEvent, sliderRef: React.RefObject<HTMLDivElement>) => void;
  handleMouseLeave: (sliderRef: React.RefObject<HTMLDivElement>) => void;
  handleMouseUp: (sliderRef: React.RefObject<HTMLDivElement>) => void;
  handleMouseMove: (e: React.MouseEvent, sliderRef: React.RefObject<HTMLDivElement>) => void;
  handleTouchStart: (e: React.TouchEvent, sliderRef: React.RefObject<HTMLDivElement>) => void;
  handleTouchMove: (e: React.TouchEvent, sliderRef: React.RefObject<HTMLDivElement>) => void;
  handleTouchEnd: () => void;
}

export function useTabSlider(deps: any[]): UseTabSliderReturn {
  // Fade indicator state (the only things that need re-renders)
  const [showRightFade, setShowRightFade] = useState(false);
  const [showDesktopRightFade, setShowDesktopRightFade] = useState(false);
  const [showLeftFade, setShowLeftFade] = useState(false);
  const [showDesktopLeftFade, setShowDesktopLeftFade] = useState(false);

  const tabSliderRef = useRef<HTMLDivElement>(null);
  const desktopTabSliderRef = useRef<HTMLDivElement>(null);

  // Drag state as refs — no re-renders during drag, no stale closures
  const isDraggingRef = useRef(false);
  const startXRef = useRef(0);
  const scrollLeftRef = useRef(0);

  // Tab slider drag handlers
  const handleMouseDown = useCallback((e: React.MouseEvent, sliderRef: React.RefObject<HTMLDivElement>) => {
    if (!sliderRef.current) return;
    isDraggingRef.current = true;
    startXRef.current = e.pageX - sliderRef.current.offsetLeft;
    scrollLeftRef.current = sliderRef.current.scrollLeft;
    sliderRef.current.style.cursor = 'grabbing';
  }, []);

  const handleMouseLeave = useCallback((sliderRef: React.RefObject<HTMLDivElement>) => {
    if (!sliderRef.current) return;
    isDraggingRef.current = false;
    sliderRef.current.style.cursor = 'grab';
  }, []);

  const handleMouseUp = useCallback((sliderRef: React.RefObject<HTMLDivElement>) => {
    if (!sliderRef.current) return;
    isDraggingRef.current = false;
    sliderRef.current.style.cursor = 'grab';
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent, sliderRef: React.RefObject<HTMLDivElement>) => {
    if (!isDraggingRef.current || !sliderRef.current) return;
    e.preventDefault();
    const x = e.pageX - sliderRef.current.offsetLeft;
    const walk = (x - startXRef.current) * 2;
    sliderRef.current.scrollLeft = scrollLeftRef.current - walk;
  }, []);

  // Touch handlers — extract pageX synchronously, then apply in rAF
  const handleTouchStart = useCallback((e: React.TouchEvent, sliderRef: React.RefObject<HTMLDivElement>) => {
    if (!sliderRef.current) return;
    isDraggingRef.current = true;
    startXRef.current = e.touches[0].pageX - sliderRef.current.offsetLeft;
    scrollLeftRef.current = sliderRef.current.scrollLeft;
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent, sliderRef: React.RefObject<HTMLDivElement>) => {
    if (!isDraggingRef.current || !sliderRef.current) return;

    // Extract the value synchronously before the synthetic event is recycled
    const pageX = e.touches[0].pageX;
    const offsetLeft = sliderRef.current.offsetLeft;
    const el = sliderRef.current;

    const x = pageX - offsetLeft;
    const walk = (x - startXRef.current) * 2;
    el.scrollLeft = scrollLeftRef.current - walk;
  }, []);

  const handleTouchEnd = useCallback(() => {
    isDraggingRef.current = false;
  }, []);

  // Check scroll position and update fade indicators
  const checkScrollPosition = useCallback((sliderRef: React.RefObject<HTMLDivElement>, isMobile: boolean) => {
    if (!sliderRef.current) return;
    const { scrollLeft, scrollWidth, clientWidth } = sliderRef.current;
    const canScroll = scrollWidth > clientWidth + 1; // 1px tolerance for sub-pixel rounding
    const isAtEnd = scrollLeft + clientWidth >= scrollWidth - 5;
    const isAtStart = scrollLeft <= 5;

    if (isMobile) {
      setShowRightFade(canScroll && !isAtEnd);
      setShowLeftFade(canScroll && !isAtStart);
    } else {
      setShowDesktopRightFade(canScroll && !isAtEnd);
      setShowDesktopLeftFade(canScroll && !isAtStart);
    }
  }, []);

  // Add scroll event listeners and ResizeObserver for fade indicators
  useEffect(() => {
    const handleScroll = () => {
      checkScrollPosition(tabSliderRef, true);
      checkScrollPosition(desktopTabSliderRef, false);
    };

    const mobileSlider = tabSliderRef.current;
    const desktopSlider = desktopTabSliderRef.current;

    if (mobileSlider) {
      mobileSlider.addEventListener('scroll', handleScroll, { passive: true });
    }
    if (desktopSlider) {
      desktopSlider.addEventListener('scroll', handleScroll, { passive: true });
    }

    // Use ResizeObserver to detect when content or container size changes
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        handleScroll();
      });
      if (mobileSlider) resizeObserver.observe(mobileSlider);
      if (desktopSlider) resizeObserver.observe(desktopSlider);
    }

    // Initial check — defer to next frame so DOM has laid out
    requestAnimationFrame(handleScroll);

    return () => {
      if (mobileSlider) {
        mobileSlider.removeEventListener('scroll', handleScroll);
      }
      if (desktopSlider) {
        desktopSlider.removeEventListener('scroll', handleScroll);
      }
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return {
    tabSliderRef,
    desktopTabSliderRef,
    showRightFade,
    showDesktopRightFade,
    showLeftFade,
    showDesktopLeftFade,
    handleMouseDown,
    handleMouseLeave,
    handleMouseUp,
    handleMouseMove,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
  };
}
