import { useEffect, useState } from 'react';

type Me = { user: { email: string }; studio: { name: string } };

type State = { kind: 'loading' } | { kind: 'signed-out' } | { kind: 'signed-in'; me: Me };

export default function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    fetch('/api/auth/me')
      .then(async (response) =>
        response.ok
          ? setState({ kind: 'signed-in', me: (await response.json()) as Me })
          : setState({ kind: 'signed-out' }),
      )
      .catch(() => setState({ kind: 'signed-out' }));
  }, []);

  return (
    <main className="mx-auto max-w-2xl p-8 font-sans">
      <h1 className="text-3xl font-semibold tracking-tight">Pixhaus</h1>
      <p className="mt-4 text-neutral-600">
        {state.kind === 'loading' && 'Checking session…'}
        {state.kind === 'signed-out' && 'Signed out.'}
        {state.kind === 'signed-in' &&
          `Signed in to ${state.me.studio.name} as ${state.me.user.email}.`}
      </p>
    </main>
  );
}
