import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Navigate } from 'react-router';

import { api, type Profile } from './api';

export type Session = { status: 'loading' } | { status: 'out' } | { status: 'in'; me: Profile };

type SessionContextValue = {
  session: Session;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>({ status: 'loading' });

  const refresh = useCallback(
    () =>
      api
        .get<Profile>('/api/auth/me')
        .then((me) => setSession({ status: 'in', me }))
        .catch(() => setSession({ status: 'out' })),
    [],
  );

  const signOut = useCallback(
    () => api.post('/api/auth/logout').then(() => setSession({ status: 'out' })),
    [],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <SessionContext.Provider value={{ session, refresh, signOut }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession outside SessionProvider');
  return value;
}

/** Wraps photographer-only routes. */
export function RequireSession({ children }: { children: ReactNode }) {
  const { session } = useSession();
  if (session.status === 'loading') return null;
  if (session.status === 'out') return <Navigate to="/login" replace />;
  return children;
}
