import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';

interface Options {
  /** Auto-advance interval in ms. 0 / omitted = no autoplay. */
  autoplayMs?: number;
  /** Pointer drag / swipe support. Default true. */
  drag?: boolean;
  /** Slide transition length in ms. Default 600. */
  durationMs?: number;
}

const EASING = 'cubic-bezier(0.25, 1, 0.5, 1)';
const DRAG_START_PX = 6;

// Looping carousel. Renders `cardsPerView` clones on each side of the real
// list so moving past either end keeps sliding forward, then silently snaps
// back into the real range once the clone looks identical to the real slide.
//
// Behaviour:
//  - Inputs during a transition aren't dropped: the latest one is queued and
//    runs as soon as the current slide settles (fast arrow clicks feel right).
//  - Drag/swipe starts only after a few px of horizontal movement, so taps and
//    clicks on cards still work; releasing uses distance OR flick velocity.
//  - Autoplay (optional) pauses on mouse hover, keyboard focus, drag, when the
//    carousel is off-screen, when the tab is hidden, and with reduced motion.
//  - Lists that fit in one view (`items <= cardsPerView`) are rendered static.
//  - A timeout fallback guarantees the carousel can never get stuck waiting
//    for a `transitionend` that never fires.
export function useInfiniteCarousel(
  itemsLength: number,
  cardsPerView: number,
  { autoplayMs = 0, drag = true, durationMs = 600 }: Options = {},
) {
  const total = itemsLength;
  const canNavigate = total > cardsPerView;
  const reducedMotion = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );

  const wrapperRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef<1 | -1 | 0>(0);
  const dragRef = useRef({ active: false, captured: false, startX: 0, startY: 0, startT: 0 });

  const [pos, setPos] = useState(0);
  const [isAnimating, setIsAnimating] = useState(false);
  const [transitionEnabled, setTransitionEnabled] = useState(true);
  const [dragOffset, setDragOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [inView, setInView] = useState(true);
  const [docVisible, setDocVisible] = useState(true);

  // Keep pos in range when the list length changes (adjusted during render,
  // React's recommended pattern, so it lands before paint).
  const [prevTotal, setPrevTotal] = useState(total);
  if (prevTotal !== total) {
    setPrevTotal(total);
    setPos((p) => ((p % total) + total) % total);
    setIsAnimating(false);
  }

  const renderIndices = useMemo(() => {
    const arr: number[] = [];
    const pad = canNavigate ? cardsPerView : 0;
    for (let i = -pad; i < itemsLength + pad; i++) {
      arr.push(((i % itemsLength) + itemsLength) % itemsLength);
    }
    return arr;
  }, [itemsLength, cardsPerView, canNavigate]);

  const move = useCallback(
    (dir: 1 | -1) => {
      if (!canNavigate) return;
      if (isAnimating) {
        pendingRef.current = dir;
        return;
      }
      setIsAnimating(true);
      setPos((p) => p + dir);
    },
    [canNavigate, isAnimating],
  );

  const flushPending = useCallback(() => {
    const dir = pendingRef.current;
    pendingRef.current = 0;
    if (dir) move(dir);
  }, [move]);

  // Called when a slide transition ends (or the fallback timer fires).
  const settle = useCallback(() => {
    if (!isAnimating) return;
    setIsAnimating(false);
    if (pos > total - 1 || pos < 0) {
      setTransitionEnabled(false);
      setPos(((pos % total) + total) % total);
    }
    // Queued input is drained by the effect below once isAnimating is false.
  }, [isAnimating, pos, total]);

  // After an instant snap: wait two frames so the no-transition position is
  // painted, then re-enable the transition. Also drains any queued input once
  // the carousel is idle again.
  useEffect(() => {
    if (isAnimating) return;
    if (!transitionEnabled) {
      let id2 = 0;
      const id1 = requestAnimationFrame(() => {
        id2 = requestAnimationFrame(() => {
          setTransitionEnabled(true);
          flushPending();
        });
      });
      return () => {
        cancelAnimationFrame(id1);
        cancelAnimationFrame(id2);
      };
    }
    flushPending();
  }, [isAnimating, transitionEnabled, flushPending]);

  // Fallback: never stay locked if `transitionend` doesn't fire (hidden tab,
  // reduced motion, interrupted transition, resize mid-slide).
  useEffect(() => {
    if (!isAnimating) return;
    const id = setTimeout(settle, reducedMotion ? 0 : durationMs + 250);
    return () => clearTimeout(id);
  }, [isAnimating, settle, durationMs, reducedMotion]);

  const handleTransitionEnd = (e: React.TransitionEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.propertyName !== 'transform') return;
    settle();
  };

  // --- Pause conditions for autoplay -------------------------------------
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { threshold: 0.2 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const onVis = () => setDocVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const paused = hovered || focused || isDragging || !inView || !docVisible || reducedMotion;

  // Restarts after every slide change, so a manual interaction always gets a
  // full interval of rest before the next automatic advance.
  useEffect(() => {
    if (!autoplayMs || !canNavigate || paused || isAnimating) return;
    const id = setTimeout(() => move(1), autoplayMs);
    return () => clearTimeout(id);
  }, [autoplayMs, canNavigate, paused, isAnimating, pos, move]);

  // --- Drag / swipe ------------------------------------------------------
  const resetDrag = () => {
    dragRef.current.active = false;
    dragRef.current.captured = false;
    setIsDragging(false);
    setDragOffset(0);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag || !canNavigate || isAnimating || e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button, a, input, textarea, select')) return;
    dragRef.current = { active: true, captured: false, startX: e.clientX, startY: e.clientY, startT: e.timeStamp };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d.active) return;
    const dx = e.clientX - d.startX;
    if (!d.captured) {
      if (Math.abs(dx) < DRAG_START_PX) return;
      if (Math.abs(e.clientY - d.startY) > Math.abs(dx)) {
        d.active = false; // vertical gesture: let the page scroll
        return;
      }
      d.captured = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      setIsDragging(true);
    }
    setDragOffset(dx);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d.active) return;
    if (!d.captured) {
      d.active = false;
      return;
    }
    const dx = e.clientX - d.startX;
    const velocity = Math.abs(dx) / Math.max(e.timeStamp - d.startT, 1);
    const threshold = Math.max(40, e.currentTarget.clientWidth * 0.12);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* capture already released */
    }
    const flick = Math.abs(dx) > 20 && velocity > 0.5;
    const dir = dx < 0 ? 1 : -1;
    resetDrag();
    if (Math.abs(dx) > threshold || flick) move(dir);
  };

  const onPointerCancel = () => {
    if (dragRef.current.active) resetDrag();
  };

  const wrapperProps = {
    ref: wrapperRef,
    role: 'region' as const,
    'aria-roledescription': 'carousel',
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onPointerEnter: (e: React.PointerEvent) => e.pointerType === 'mouse' && setHovered(true),
    onPointerLeave: (e: React.PointerEvent) => e.pointerType === 'mouse' && setHovered(false),
    onFocus: (e: React.FocusEvent) => {
      if (e.target.matches(':focus-visible')) setFocused(true);
    },
    onBlur: () => setFocused(false),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowLeft') move(-1);
      else if (e.key === 'ArrowRight') move(1);
    },
    style: {
      touchAction: 'pan-y' as const,
      cursor: canNavigate && drag ? (isDragging ? 'grabbing' : 'grab') : undefined,
    },
  };

  const trackProps = {
    onTransitionEnd: handleTransitionEnd,
    style: {
      transform: `translateX(calc(-${canNavigate ? (pos + cardsPerView) * (100 / cardsPerView) : 0}% + ${dragOffset}px))`,
      transition:
        isDragging || !transitionEnabled || reducedMotion ? 'none' : `transform ${durationMs}ms ${EASING}`,
      pointerEvents: isDragging ? ('none' as const) : ('auto' as const),
    },
  };

  /** True for the cloned padding slides (hide them from AT / tab order). */
  const isClone = (renderIndex: number) =>
    canNavigate && (renderIndex < cardsPerView || renderIndex >= total + cardsPerView);

  const activeDot = ((pos % total) + total) % total;
  const goTo = (index: number) => {
    if (!canNavigate || isAnimating) return;
    setPos(index);
  };

  return {
    total,
    activeDot,
    goTo,
    renderIndices,
    wrapperProps,
    trackProps,
    isClone,
    canNavigate,
    next: () => move(1),
    prev: () => move(-1),
  };
}
