import { Suspense, lazy, useState } from 'react';
import { BrowserRouter, Route, Routes, useParams } from 'react-router';
import { normalizeRoomCode } from '@winds/protocol';
import { isRemoteEntry } from './remote/mode';
import { HomePage } from './pages/HomePage';
import { JoinPage } from './pages/JoinPage';

// Mantine lives only in these lazy chunks (commander/operator).
const Create = lazy(() => import('./commander').then((m) => ({ default: m.Create })));
const CommanderRoom = lazy(() => import('./commander').then((m) => ({ default: m.CommanderRoom })));
const Bench = lazy(() => import('./bench').then((m) => ({ default: m.BenchPage })));
const Guide = lazy(() => import('./guide').then((m) => ({ default: m.GuidePage })));
const Operator = lazy(() => import('./operator').then((m) => ({ default: m.Operator })));
const Remote = lazy(() => import('./remote').then((m) => ({ default: m.Remote })));
const SubCommander = lazy(() => import('./operator').then((m) => ({ default: m.SubCommander })));

/** /r/:code is the member join page; with a #token fragment it is the phone remote. Decided once at mount (the remote strips the hash afterwards; a per-tab flag survives reload). */
function JoinOrRemote() {
  const code = normalizeRoomCode(useParams().code ?? '');
  const [remote] = useState(() => isRemoteEntry(code, location.hash));
  return remote ? <Remote /> : <JoinPage />;
}

export function AppRoutes() {
  return (
    <Suspense fallback={<p style={{ padding: 16 }}>불러오는 중…</p>}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/r/:code" element={<JoinOrRemote />} />
        <Route path="/create" element={<Create />} />
        <Route path="/c/:code" element={<CommanderRoom />} />
        <Route path="/o/:code" element={<Operator />} />
        <Route path="/s/:code" element={<SubCommander />} />
        <Route path="/guide" element={<Guide />} />
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
