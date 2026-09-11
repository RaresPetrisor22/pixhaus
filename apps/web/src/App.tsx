import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router';

import ClientEntry from './pages/ClientEntry';
import ClientGallery from './pages/ClientGallery';
import Galleries from './pages/Galleries';
import Gallery from './pages/Gallery';
import Login from './pages/Login';
import Register from './pages/Register';
import VerifyEmail from './pages/VerifyEmail';
import { RequireSession, SessionProvider, useSession } from './session';
import { Button } from './ui';

function Header() {
  const { session, signOut } = useSession();

  return (
    <header className="flex items-center justify-between border-b border-neutral-200 px-6 py-3">
      <Link to="/" className="text-lg font-semibold tracking-tight">
        Pixhaus
      </Link>
      {session.status === 'in' && (
        <div className="flex items-center gap-3 text-sm text-neutral-600">
          <span>{session.me.user.email}</span>
          <Button variant="secondary" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      )}
    </header>
  );
}

function Home() {
  const { session } = useSession();
  if (session.status === 'loading') return null;
  return <Navigate to={session.status === 'in' ? '/galleries' : '/login'} replace />;
}

function NotFound() {
  return <p className="p-8 text-neutral-600">There is nothing here.</p>;
}

export default function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <Header />
        <main className="px-6">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/verify-email" element={<VerifyEmail />} />
            <Route
              path="/galleries"
              element={
                <RequireSession>
                  <Galleries />
                </RequireSession>
              }
            />
            <Route
              path="/galleries/:id"
              element={
                <RequireSession>
                  <Gallery />
                </RequireSession>
              }
            />
            <Route path="/g/:token" element={<ClientEntry />} />
            <Route path="/gallery" element={<ClientGallery />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </main>
      </SessionProvider>
    </BrowserRouter>
  );
}
