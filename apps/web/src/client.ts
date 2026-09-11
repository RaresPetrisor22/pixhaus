import { api, type ClientSession } from './api';

// The client's badge lives here and nowhere else — not localStorage, not a
// cookie. A reload loses it, and the link in the email is the way back in.
let session: ClientSession | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

export function badge(): ClientSession | null {
  return session;
}

export function clearBadge(): void {
  session = null;
  clearTimeout(timer);
}

export function setBadge(next: ClientSession): void {
  session = next;
  clearTimeout(timer);

  // A fraction of the lifetime rather than a fixed lead, so a short TTL still
  // refreshes before it expires rather than after.
  const lifetime = new Date(next.expiresAt).getTime() - Date.now();
  timer = setTimeout(() => void refresh(), Math.max(lifetime * 0.9, 5_000));
}

async function refresh(): Promise<void> {
  if (!session) return;
  try {
    setBadge(
      await api.post<ClientSession>('/api/client/token', undefined, { bearer: session.token }),
    );
  } catch {
    clearBadge();
  }
}

/** The bearer for a client-plane call, or null when there is no badge. */
export function bearer(): string | null {
  return session?.token ?? null;
}
