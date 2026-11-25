import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { makeDefaultParties } from '@winds/protocol';
import { HomePage } from './HomePage';
import { JoinPage } from './JoinPage';
import { PartyPicker } from '../member/PartyPicker';
import { wsUrl } from '../config';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Where() {
  return <div data-testid="loc">{useLocation().pathname}</div>;
}

describe('HomePage', () => {
  it('upper-cases the entered code (case-insensitive) and navigates to /r/:code', () => {
    render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/r/:code" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText('방 코드'), { target: { value: ' ab3k7m ' } });
    fireEvent.click(screen.getByRole('button', { name: '입장' }));
    expect(screen.getByTestId('loc')).toHaveTextContent('/r/AB3K7M');
  });
});

describe('JoinPage', () => {
  it('shows "방을 찾을 수 없습니다" with a code input when the room is 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    render(
      <MemoryRouter initialEntries={['/r/ab3k7m']}>
        <Routes>
          <Route path="/r/:code" element={<JoinPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('방을 찾을 수 없습니다')).toBeInTheDocument();
    expect(screen.getByLabelText('방 코드')).toBeInTheDocument();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/rooms/AB3K7M', expect.anything()));
  });

  it('treats a malformed code as not found without calling the server', () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    render(
      <MemoryRouter initialEntries={['/r/OOO']}>
        <Routes>
          <Route path="/r/:code" element={<JoinPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('방을 찾을 수 없습니다')).toBeInTheDocument();
    expect(f).not.toHaveBeenCalled();
  });
});

describe('PartyPicker', () => {
  it('lists parties with number/name/count plus "아직 모름"', () => {
    const parties = makeDefaultParties(3).map((p, i) => (i === 1 ? { ...p, name: '돌격대' } : p));
    const onPick = vi.fn();
    render(<PartyPicker parties={parties} counts={{ p2: 7 }} hasCounts selected={undefined} onPick={onPick} />);
    const btn = screen.getByRole('button', { name: /돌격대/ });
    expect(btn).toHaveTextContent('2');
    expect(btn).toHaveTextContent('7명');
    fireEvent.click(btn);
    expect(onPick).toHaveBeenCalledWith('p2');
    fireEvent.click(screen.getByRole('button', { name: '아직 모름' }));
    expect(onPick).toHaveBeenLastCalledWith(null);
  });
});

describe('wsUrl', () => {
  it('derives ws(s) from same origin or VITE_API_BASE', () => {
    expect(wsUrl('ABC234', '', { origin: 'https://x.dev' })).toBe('wss://x.dev/api/rooms/ABC234/ws');
    expect(wsUrl('ABC234', 'http://localhost:8787', { origin: 'https://x.dev' })).toBe('ws://localhost:8787/api/rooms/ABC234/ws');
  });
});
