import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

export function Field({
  label,
  hint,
  ...input
}: { label: string; hint?: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-neutral-700">{label}</span>
      <input
        className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-500 focus:outline-none"
        {...input}
      />
      {hint && <span className="mt-1 block text-xs text-neutral-500">{hint}</span>}
    </label>
  );
}

export function Button({
  children,
  variant = 'primary',
  ...button
}: { variant?: 'primary' | 'secondary' } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const tone =
    variant === 'primary'
      ? 'bg-neutral-900 text-white hover:bg-neutral-700'
      : 'border border-neutral-300 text-neutral-700 hover:bg-neutral-100';

  return (
    <button
      className={`rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50 ${tone}`}
      {...button}
    >
      {children}
    </button>
  );
}

export function Notice({ tone, children }: { tone: 'error' | 'info'; children: ReactNode }) {
  const style =
    tone === 'error'
      ? 'border-red-200 bg-red-50 text-red-800'
      : 'border-neutral-200 bg-neutral-50 text-neutral-800';

  return <div className={`rounded-md border px-3 py-2 text-sm ${style}`}>{children}</div>;
}

export function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mx-auto mt-12 max-w-sm space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {children}
    </section>
  );
}
