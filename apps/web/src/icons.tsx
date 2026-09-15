/** Thin stroke icons, sized by the text they sit in. No icon dependency. */
const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

export function DownloadIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg {...base} className={className}>
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M4 20h16" />
    </svg>
  );
}

export function ChevronLeftIcon({ className = 'h-6 w-6' }: { className?: string }) {
  return (
    <svg {...base} className={className}>
      <path d="m15 5-7 7 7 7" />
    </svg>
  );
}

export function ChevronRightIcon({ className = 'h-6 w-6' }: { className?: string }) {
  return (
    <svg {...base} className={className}>
      <path d="m9 5 7 7-7 7" />
    </svg>
  );
}

export function CloseIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg {...base} className={className}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function StarIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg {...base} className={className}>
      <path d="m12 4 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.6-4.8 2.6.9-5.4L4.2 9.7l5.4-.8z" />
    </svg>
  );
}
