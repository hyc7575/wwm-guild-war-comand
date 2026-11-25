// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { loadRoomTokens, saveRoomTokens } from '../net/session';

const roles: string[] = [];
vi.mock('../net/RoomSession', () => ({
  RoomSession: ({ role, token, children }: { role: string; token: string; children: unknown }) => {
    roles.push(`${role}:${token}`);
    return (
      <div data-testid="session">
        {role}
        {children as never}
      </div>
    );
  },
}));
vi.mock('../commander/console/Console', () => ({
  Console: ({ roleLabel }: { roleLabel?: string }) => <div>{roleLabel}</div>,
}));
vi.mock('../commander/console/ConsoleProvider', () => ({ ConsoleProvider: ({ children }: { children: unknown }) => <>{children as never}</> }));
vi.mock('../shared/StatusBar', () => ({ StatusBar: () => null }));
vi.mock('../shared/NoticeToast', () => ({ NoticeToast: () => null }));

import { SubCommander } from './index';

if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false, onchange: null })) as never;
}

function renderSub(path: string) {
  return render(
    <MantineProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/s/:code" element={<SubCommander />} />
        </Routes>
      </MemoryRouter>
    </MantineProvider>,
  );
}

describe('/s/:code', () => {
  it('uses the stored sub token even when older saved tokens lack it', () => {
    localStorage.clear();
    saveRoomTokens('K7M2QX', { commanderToken: 'c' }); // legacy shape
    expect(loadRoomTokens('K7M2QX').subCommanderToken).toBeUndefined();
    renderSub('/s/K7M2QX');
    expect(screen.getByText('서브오더 링크가 올바르지 않습니다')).toBeInTheDocument();
  });

  it('connects as SUB_COMMANDER with the stored token', () => {
    localStorage.clear();
    saveRoomTokens('K7M2QX', { operatorToken: 'o', subCommanderToken: 'subtok' });
    renderSub('/s/K7M2QX');
    expect(screen.getByTestId('session')).toHaveTextContent('SUB_COMMANDER');
    expect(roles).toContain('SUB_COMMANDER:subtok');
    expect(screen.getByText('서브오더')).toBeInTheDocument();
  });
});
