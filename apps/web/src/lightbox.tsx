import { useEffect, type ReactNode } from 'react';

import { ChevronLeftIcon, ChevronRightIcon, CloseIcon, DownloadIcon } from './icons';

function Round({
  label,
  onClick,
  children,
  className = '',
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={`grid place-items-center rounded-full border border-white/20 bg-black/40 text-white/90 backdrop-blur transition hover:border-white/40 hover:bg-black/70 hover:text-white ${className}`}
    >
      {children}
    </button>
  );
}

/**
 * One photo at a time, sized to the window.
 *
 * The image sits in a flex box with a definite height — `inset-0` gives the
 * backdrop the viewport, and `h-full` passes it down. A percentage max-height
 * against an auto-sized parent resolves to none, which is what let tall photos
 * run off the bottom of the screen.
 */
export function Lightbox({
  src,
  alt,
  position,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  onClose,
  onDownload,
}: {
  src: string | null;
  alt: string;
  position: string;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  onDownload?: () => void;
}) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowLeft') onPrev();
      if (event.key === 'ArrowRight') onNext();
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onPrev, onNext]);

  // The page behind must not scroll while this is open.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return (
    <div onClick={onClose} className="fixed inset-0 z-20 bg-neutral-950/95">
      <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between p-4 sm:p-5">
        <span className="text-xs tracking-[0.2em] text-white/50 tabular-nums">{position}</span>
        <div className="flex items-center gap-2">
          {onDownload && (
            <Round label="Download this photo" onClick={onDownload} className="h-10 w-10">
              <DownloadIcon className="h-[1.1rem] w-[1.1rem]" />
            </Round>
          )}
          <Round label="Close" onClick={onClose} className="h-10 w-10">
            <CloseIcon />
          </Round>
        </div>
      </div>

      <div className="flex h-full items-center justify-center p-4 pt-20 pb-16 sm:p-16">
        {src && (
          <img
            src={src}
            alt={alt}
            onClick={(event) => event.stopPropagation()}
            className="max-h-full max-w-full object-contain"
          />
        )}
      </div>

      {hasPrev && (
        <Round
          label="Previous photo"
          onClick={onPrev}
          className="absolute top-1/2 left-3 h-11 w-11 -translate-y-1/2 sm:left-5"
        >
          <ChevronLeftIcon />
        </Round>
      )}
      {hasNext && (
        <Round
          label="Next photo"
          onClick={onNext}
          className="absolute top-1/2 right-3 h-11 w-11 -translate-y-1/2 sm:right-5"
        >
          <ChevronRightIcon />
        </Round>
      )}
    </div>
  );
}
