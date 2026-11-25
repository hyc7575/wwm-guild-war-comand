import { Suspense, lazy } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router';
import { HomePage } from './pages/HomePage';
import { JoinPage } from './pages/JoinPage';

// Mantine lives only in these lazy chunks (commander/operator).
const Create = lazy(() => import('./commander').then((m) => ({ default: m.Create })));
const CommanderRoom = lazy(() => import('./commander').then((m) => ({ default: m.CommanderRoom })));
const Bench = lazy(() => import('./bench').then((m) => ({ default: m.BenchPage })));
const Operator = lazy(() => import('./operator').then((m) => ({ default: m.Operator })));

export function AppRoutes() {
  return (
    <Suspense fallback={<p style={{ padding: 16 }}>불러오는 중…</p>}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/r/:code" element={<JoinPage />} />
        <Route path="/create" element={<Create />} />
        <Route path="/c/:code" element={<CommanderRoom />} />
        <Route path="/o/:code" element={<Operator />} />
        <Route path="/bench" element={<Bench />} />
        <Route path="*" element={<HomePage />} />
      </Routes>
    </Suspense>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
