/**
 * The full-bleed cover a gallery opens with. `-mx-6` cancels the padding on
 * <main>, which is what lets it reach the edges of the window without every
 * other page giving up its gutter.
 */
export function Hero({
  src,
  title,
  subtitle,
  onView,
}: {
  src: string;
  title: string;
  subtitle?: string;
  onView: () => void;
}) {
  return (
    <section className="relative -mx-6 flex h-[calc(100vh-3.25rem)] min-h-[420px] items-center justify-center overflow-hidden bg-neutral-900">
      <img src={src} alt="" className="absolute inset-0 h-full w-full object-cover" />

      {/* Photographs are unpredictable; an even scrim is what keeps white text
          readable whether the middle of the frame is a dark suit or a bright
          sky. A gradient would be prettier and would fail on half of them. */}
      <div className="absolute inset-0 bg-black/35" />

      <div className="relative flex flex-col items-center gap-8 px-6 text-center">
        <div className="space-y-3">
          <h1 className="text-3xl font-light tracking-[0.25em] text-white uppercase [text-shadow:0_2px_24px_rgba(0,0,0,0.45)] sm:text-5xl">
            {title}
          </h1>
          {subtitle && (
            <p className="text-xs tracking-[0.3em] text-white/80 uppercase">{subtitle}</p>
          )}
        </div>

        <button
          type="button"
          onClick={onView}
          className="border border-white/70 px-8 py-3 text-[0.7rem] tracking-[0.25em] text-white uppercase transition hover:bg-white hover:text-neutral-900"
        >
          View gallery
        </button>
      </div>
    </section>
  );
}
