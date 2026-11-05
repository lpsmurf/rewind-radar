import React, { lazy, Suspense, useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { isAdminHash } from './lib/adminPanel';
import './ui/styles.css';

// The admin panel is its own chunk: visitors never download it, and the store (live connection, canvas) is not mounted on #admin.
const AdminPanel = lazy(() => import('./ui/AdminPanel'));

function Root() {
  const [admin, setAdmin] = useState(() => isAdminHash(location.hash));
  useEffect(() => {
    const on = () => setAdmin(isAdminHash(location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return admin ? (
    <Suspense fallback={<p className="small">Loading...</p>}>
      <AdminPanel />
    </Suspense>
  ) : (
    <App />
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
