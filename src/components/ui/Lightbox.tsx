"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";

interface LightboxProps {
  images: { src: string; alt?: string }[];
  startIndex?: number;
  onClose: () => void;
}

export function Lightbox({ images, startIndex = 0, onClose }: LightboxProps) {
  const [index, setIndex] = useState(startIndex);
  const [visible, setVisible] = useState(false);
  const [animClass, setAnimClass] = useState("");
  const [transitioning, setTransitioning] = useState(false);
  const hasMultiple = images.length > 1;
  const touchStartX = useRef<number | null>(null);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

  const close = useCallback(() => {
    setVisible(false);
    setTimeout(onClose, 250);
  }, [onClose]);

  const goTo = useCallback((dir: "left" | "right") => {
    if (transitioning) return;
    setTransitioning(true);

    // Slide current image out fully
    setAnimClass(dir === "right" ? "lightbox-slide-out-left" : "lightbox-slide-out-right");

    setTimeout(() => {
      // Change image while off-screen
      setIndex((i) => dir === "right"
        ? (i < images.length - 1 ? i + 1 : 0)
        : (i > 0 ? i - 1 : images.length - 1)
      );
      // New image slides in from the opposite side
      setAnimClass(dir === "right" ? "lightbox-slide-in-right" : "lightbox-slide-in-left");

      setTimeout(() => {
        setAnimClass("");
        setTransitioning(false);
      }, 300);
    }, 300);
  }, [transitioning, images.length]);

  const prev = useCallback(() => goTo("left"), [goTo]);
  const next = useCallback(() => goTo("right"), [goTo]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "ArrowLeft") prev();
      if (e.key === "ArrowRight") next();
    };
    document.addEventListener("keydown", handleKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = "";
    };
  }, [close, prev, next]);

  const handleTouchStart = (e: React.TouchEvent) => {
    if (!hasMultiple) return;
    touchStartX.current = e.touches[0].clientX;
  };
  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null || !hasMultiple) return;
    const diff = e.changedTouches[0].clientX - touchStartX.current;
    if (diff > 60) prev();
    else if (diff < -60) next();
    touchStartX.current = null;
  };

  return (
    <div
      className={`lightbox-overlay transition-opacity duration-250 ${visible ? "opacity-100" : "opacity-0"}`}
      onClick={close}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* Close */}
      <button
        onClick={close}
        className="absolute top-4 right-4 z-10 text-white/70 hover:text-white transition-colors"
        aria-label="Close"
      >
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>

      {/* Counter */}
      {hasMultiple && (
        <div className="absolute top-4 left-4 text-white/50 text-sm">
          {index + 1} / {images.length}
        </div>
      )}

      {/* Prev */}
      {hasMultiple && (
        <button
          onClick={(e) => { e.stopPropagation(); prev(); }}
          className="absolute left-4 top-1/2 -translate-y-1/2 z-10 text-white/50 hover:text-white transition-colors p-2"
        >
          <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      )}

      {/* Image + caption */}
      <div
        className={`flex flex-col items-center ${animClass}`}
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={images[index].src}
          alt={images[index].alt || ""}
          className={`max-w-[90vw] max-h-[85vh] object-contain select-none transition-transform duration-250 ${visible ? "scale-100" : "scale-95"}`}
          draggable={false}
        />
        {images[index].alt && (
          <p className="mt-3 text-white/60 text-sm text-center max-w-2xl">
            {images[index].alt}
          </p>
        )}
      </div>

      {/* Next */}
      {hasMultiple && (
        <button
          onClick={(e) => { e.stopPropagation(); next(); }}
          className="absolute right-4 top-1/2 -translate-y-1/2 z-10 text-white/50 hover:text-white transition-colors p-2"
        >
          <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      )}
    </div>
  );
}

/**
 * ALT badge shown on images with alt text.
 * Click to show the alt text in a popup.
 */
function AltBadge({ alt }: { alt: string }) {
  const [open, setOpen] = useState(false);

  return (
    <span className="absolute bottom-2 right-2 z-10">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        className="bg-black/80 text-white text-[10px] font-bold px-1.5 py-0.5 rounded hover:bg-black transition-colors"
      >
        ALT
      </button>
      {open && (
        <div
          className="absolute bottom-7 right-0 bg-black/95 text-white text-xs p-3 rounded-lg max-w-xs shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          {alt}
          <button
            onClick={() => setOpen(false)}
            className="block mt-2 text-white/50 hover:text-white text-[10px] uppercase"
          >
            Close
          </button>
        </div>
      )}
    </span>
  );
}

/**
 * Wrap around a gallery of images. Opens lightbox on click.
 * Shows ALT badge on images with alt text.
 */
export function LightboxGallery({ children }: { children: React.ReactNode }) {
  const [lightbox, setLightbox] = useState<{ images: { src: string; alt?: string }[]; index: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [imgAlts, setImgAlts] = useState<{ el: HTMLImageElement; alt: string }[]>([]);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new MutationObserver(() => scanImages());
    observer.observe(containerRef.current, { childList: true, subtree: true });
    // Also scan after images load
    const timer = setTimeout(scanImages, 100);
    return () => { observer.disconnect(); clearTimeout(timer); };

    function scanImages() {
      if (!containerRef.current) return;
      const imgs = Array.from(containerRef.current.querySelectorAll("img"));
      setImgAlts(imgs.filter((img) => img.alt && !img.alt.startsWith("Photo ")).map((img) => ({ el: img, alt: img.alt })));
    }
  }, [children]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName !== "IMG") return;

    const img = target as HTMLImageElement;
    const container = containerRef.current;
    if (!container) return;
    const allImgs = Array.from(container.querySelectorAll("img"));
    const images = allImgs.map((el) => ({ src: el.src, alt: el.alt }));
    const index = allImgs.indexOf(img);

    if (images.length > 0 && index >= 0) {
      setLightbox({ images, index });
    }
  }, []);

  return (
    <>
      <div ref={containerRef} onClick={handleClick} className="cursor-zoom-in">
        {children}
      </div>
      {/* Render ALT badges as portals positioned over each image */}
      {imgAlts.map((item, i) => (
        <AltBadgePortal key={i} imgEl={item.el} alt={item.alt} />
      ))}
      {lightbox && createPortal(
        <Lightbox
          images={lightbox.images}
          startIndex={lightbox.index}
          onClose={() => setLightbox(null)}
        />,
        document.body
      )}
    </>
  );
}

/** Positions an ALT badge over a specific img element */
function AltBadgePortal({ imgEl, alt }: { imgEl: HTMLImageElement; alt: string }) {
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);

  const handleClose = () => {
    setClosing(true);
    setTimeout(() => { setOpen(false); setClosing(false); }, 150);
  };

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (open) handleClose();
    else setOpen(true);
  };

  useEffect(() => {
    function update() {
      const rect = imgEl.getBoundingClientRect();
      setPos({
        top: rect.bottom + window.scrollY - 32,
        left: rect.right + window.scrollX - 48,
        width: rect.width,
      });
    }
    update();
    if (!imgEl.complete) imgEl.addEventListener("load", update, { once: true });
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update);
    return () => { window.removeEventListener("resize", update); window.removeEventListener("scroll", update); };
  }, [imgEl]);

  if (!pos) return null;

  const popupWidth = Math.min(pos.width * 0.8, 480);

  return (
    <span className="absolute z-10" style={{ top: pos.top, left: pos.left }}>
      <button
        onClick={handleToggle}
        className="bg-black/70 text-white text-[10px] font-bold px-2 py-0.5 rounded hover:bg-black/90 transition-colors cursor-pointer backdrop-blur-sm"
      >
        ALT
      </button>
      {open && (
        <div
          className={`absolute bottom-8 right-0 bg-black/85 backdrop-blur-md text-white/90 text-sm p-4 rounded-xl shadow-2xl z-20 leading-relaxed ${closing ? "alt-popup-exit" : "alt-popup-enter"}`}
          style={{ width: popupWidth }}
          onClick={(e) => e.stopPropagation()}
        >
          {alt}
        </div>
      )}
    </span>
  );
}
