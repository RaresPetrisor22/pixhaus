import { decode } from 'blurhash';
import { useEffect, useRef } from 'react';

// A 32x32 decode stretched by CSS. Cheap enough to do for every tile.
export function Blurhash({ hash, className }: { hash: string; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const context = ref.current?.getContext('2d');
    if (!context) return;

    const image = context.createImageData(32, 32);
    image.data.set(decode(hash, 32, 32));
    context.putImageData(image, 0, 0);
  }, [hash]);

  return <canvas ref={ref} width={32} height={32} className={className} aria-hidden />;
}
