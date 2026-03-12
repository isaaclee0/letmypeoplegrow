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
  // Tab slider drag state
  const [isDragging, setIsDragging] = useState(false);
  const [startX, setStartX] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [showRightFade, setShowRightFade] = useState(true);
  const [showDesktopRightFade, setShowDesktopRightFade] = useState(true);
  const [showLeftFade, setShowLeftFade] = useState(false);
  const [showDesktopLeftFade, setShowDesktopLeftFade] = useState(false);
  const tabSliderRef = useRef<HTMLDivElement>(null);
  const desktopTabSliderRef = useRef<HTMLDivElement>(null);

  // Performance optimization refs
  const animationFrameRef = useRef<number | null>(null);
  const lastTouchTimeRef = useRef<number>(0);
  const touchThrottleDelay = 16; // ~60fps

  // Tab slider drag handlers
  const handleMouseDown = (e: React.MouseEvent, sliderRef: React.RefObject<HTMLDivElement>) => {
    if (!sliderRef.current) return;
    setIsDragging(true);
    setStartX(e.pageX - sliderRef.current.offsetLeft);
    setScrollLeft(sliderRef.current.scrollLeft);
    sliderRef.current.style.cursor = 'grabbing';
  };

  const handleMouseLeave = (sliderRef: React.RefObject<HTMLDivElement>) => {
    if (!sliderRef.current) return;
    setIsDragging(false);
    sliderRef.current.style.cursor = 'grab';
  };

  const handleMouseUp = (sliderRef: React.RefObject<HTMLDivElement>) => {
    if (!sliderRef.current) return;
    setIsDragging(false);
    sliderRef.current.style.cursor = 'grab';
  };

  const handleMouseMove = (e: React.MouseEvent, sliderRef: React.RefObject<HTMLDivElement>) => {
    if (!isDragging || !sliderRef.current) return;
    e.preventDefault();
    const x = e.pageX - sliderRef.current.offsetLeft;
    const walk = (x - startX) * 2; // Scroll speed multiplier
    sliderRef.current.scrollLeft = scrollLeft - walk;
  };

  // Optimized touch handlers for mobile with better performance
  const handleTouchStart = (e: React.TouchEvent, sliderRef: React.RefObject<HTMLDivElement>) => {
    if (!sliderRef.current) return;

    // Cancel any pending animation frame
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    setIsDragging(true);
    setStartX(e.touches[0].pageX - sliderRef.current.offsetLeft);
    setScrollLeft(sliderRef.current.scrollLeft);
    lastTouchTimeRef.current = Date.now();
  };

  const handleTouchMove = (e: React.TouchEvent, sliderRef: React.RefObject<HTMLDivElement>) => {
    if (!isDragging || !sliderRef.current) return;

    // Throttle touch events for better performance
    const now = Date.now();
    if (now - lastTouchTimeRef.current < touchThrottleDelay) {
      return;
    }
    lastTouchTimeRef.current = now;

    e.preventDefault();

    // Use requestAnimationFrame for smooth scrolling
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }

    animationFrameRef.current = requestAnimationFrame(() => {
      if (!sliderRef.current) return;
      const x = e.touches[0].pageX - sliderRef.current.offsetLeft;
      const walk = (x - startX) * 2;
      sliderRef.current.scrollLeft = scrollLeft - walk;
    });
  };

  const handleTouchEnd = () => {
    setIsDragging(false);

    // Clean up animation frame
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  };

  // Cleanup animation frames on unmount
  useEffect(() => {
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  // Check scroll position and update fade indicators
  const checkScrollPosition = useCallback((sliderRef: React.RefObject<HTMLDivElement>, isMobile: boolean) => {
    if (!sliderRef.current) return;
    const { scrollLeft, scrollWidth, clientWidth } = sliderRef.current;
    const isAtEnd = scrollLeft + clientWidth >= scrollWidth - 5; // 5px tolerance
    const isAtStart = scrollLeft <= 5; // 5px tolerance

    if (isMobile) {
      setShowRightFade(!isAtEnd);
      setShowLeftFade(!isAtStart);
    } else {
      setShowDesktopRightFade(!isAtEnd);
      setShowDesktopLeftFade(!isAtStart);
    }
  }, []);

  // Add scroll event listeners for fade indicators
  useEffect(() => {
    const handleScroll = () => {
      checkScrollPosition(tabSliderRef, true);
      checkScrollPosition(desktopTabSliderRef, false);
    };

    const mobileSlider = tabSliderRef.current;
    const desktopSlider = desktopTabSliderRef.current;

    if (mobileSlider) {
      mobileSlider.addEventListener('scroll', handleScroll);
    }
    if (desktopSlider) {
      desktopSlider.addEventListener('scroll', handleScroll);
    }

    // Initial check
    handleScroll();

    return () => {
      if (mobileSlider) {
        mobileSlider.removeEventListener('scroll', handleScroll);
      }
      if (desktopSlider) {
        desktopSlider.removeEventListener('scroll', handleScroll);
      }
    };
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
