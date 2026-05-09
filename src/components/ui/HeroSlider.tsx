"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Image from "next/image";
import Link from "next/link";

export interface HeroSlide {
  url: string;
  alt: string;
  href?: string;          // if set, slide is a link
  caption?: string;       // optional title/caption overlay
  cta?: string;           // optional CTA label (e.g. "from $20 AUD")
  width?: number;
  height?: number;
}

interface HeroSliderProps {
  slides: HeroSlide[];
  autoAdvanceMs?: number;
  aspectRatio?: string;
  onSlideClick?: (index: number) => void;
}

export default function HeroSlider({
  slides,
  autoAdvanceMs = 7000,
  aspectRatio = "16/7",
  onSlideClick,
}: HeroSliderProps) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const touchStartX = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Honor user's prefers-reduced-motion setting
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const next = useCallback(() => {
    setIndex((i) => (i + 1) % slides.length);
  }, [slides.length]);

  const prev = useCallback(() => {
    setIndex((i) => (i - 1 + slides.length) % slides.length);
  }, [slides.length]);

  // Auto-advance
  useEffect(() => {
    if (paused || reducedMotion || slides.length <= 1) return;
    const id = setInterval(next, autoAdvanceMs);
    return () => clearInterval(id);
  }, [paused, reducedMotion, autoAdvanceMs, next, slides.length]);

  // Keyboard nav when slider is focused
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: KeyboardEvent) => {
      if (document.activeElement && el.contains(document.activeElement)) {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          prev();
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          next();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [prev, next]);

  if (slides.length === 0) return null;

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  };
  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    if (Math.abs(dx) > 50) {
      if (dx < 0) next();
      else prev();
    }
    touchStartX.current = null;
  };

  return (
    <div
      ref={containerRef}
      className="relative w-full overflow-hidden rounded-2xl bg-surface-900 group"
      style={{ aspectRatio }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      role="region"
      aria-roledescription="carousel"
      aria-label="Featured photos"
    >
      {slides.map((slide, i) => {
        const isActive = i === index;
        const inner = (
          <>
            <Image
              src={slide.url.split("?")[0]}
              alt={slide.alt}
              fill
              sizes="(max-width: 1024px) 100vw, 1024px"
              className="object-cover"
              priority={i === 0}
            />
            {(slide.caption || slide.cta) && (
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 via-black/30 to-transparent p-4 sm:p-6">
                {slide.caption && (
                  <p className="text-white text-base sm:text-lg font-display">{slide.caption}</p>
                )}
                {slide.cta && (
                  <p className="text-accent-300 text-xs sm:text-sm mt-1 font-semibold">{slide.cta}</p>
                )}
              </div>
            )}
          </>
        );

        return (
          <div
            key={i}
            className={`absolute inset-0 transition-opacity duration-700 ${
              isActive ? "opacity-100 z-10" : "opacity-0 z-0"
            }`}
            aria-hidden={!isActive}
          >
            {slide.href ? (
              <Link href={slide.href} className="block w-full h-full">
                {inner}
              </Link>
            ) : onSlideClick ? (
              <button
                type="button"
                onClick={() => onSlideClick(i)}
                className="block w-full h-full text-left"
              >
                {inner}
              </button>
            ) : (
              <div className="w-full h-full">{inner}</div>
            )}
          </div>
        );
      })}

      {/* Arrow controls */}
      {slides.length > 1 && (
        <>
          <button
            type="button"
            onClick={prev}
            aria-label="Previous slide"
            className="absolute left-2 top-1/2 -translate-y-1/2 z-20 w-9 h-9 flex items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60 transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
          </button>
          <button
            type="button"
            onClick={next}
            aria-label="Next slide"
            className="absolute right-2 top-1/2 -translate-y-1/2 z-20 w-9 h-9 flex items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60 transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
            </svg>
          </button>

          {/* Dots */}
          <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-20 flex gap-1.5">
            {slides.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setIndex(i)}
                aria-label={`Go to slide ${i + 1}`}
                className={`w-2 h-2 rounded-full transition-all ${
                  i === index ? "bg-white w-6" : "bg-white/50 hover:bg-white/80"
                }`}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
