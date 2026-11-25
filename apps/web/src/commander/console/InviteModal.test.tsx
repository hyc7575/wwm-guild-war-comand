// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { InviteModal } from './InviteModal';

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});
afterEach(cleanup);

const mount = (sub?: string) =>
  render(
    <MantineProvider forceColorScheme="dark">
      <InviteModal opened onClose={vi.fn()} code="K7M2QX" subCommanderToken={sub} />
    </MantineProvider>,
  );

describe('InviteModal phone remote', () => {
  it('keeps the remote QR and links hidden until 리모컨 QR 보기 is pressed', async () => {
    mount('subtok');
    expect(screen.queryByTestId('remote-qr')).toBeNull();
    expect(screen.queryByTestId('remote-link')).toBeNull();
    expect(screen.queryByTestId('sub-link')).toBeNull();
    expect(screen.queryByTestId('authority-warning')).toBeNull();
    fireEvent.click(screen.getByTestId('remote-reveal'));
    expect(screen.getByTestId('authority-warning')).toHaveTextContent('이 QR을 찍은 사람은 명령 권한을 갖는다. 화면 공유 중에는 열지 마세요');
    await waitFor(() => expect(screen.getByTestId('remote-qr')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('remote-hide'));
    expect(screen.queryByTestId('remote-qr')).toBeNull();
  });

  it('shows the /r/:code#token link, QR and the shared-token warning', async () => {
    mount('subtok');
    fireEvent.click(screen.getByTestId('remote-reveal'));
    expect(screen.getByTestId('remote-link')).toHaveValue(`${location.origin}/r/K7M2QX#subtok`);
    await waitFor(() => expect(screen.getByTestId('remote-qr')).toHaveAttribute('src', expect.stringMatching(/^data:image\/png/)));
    expect(screen.getByTestId('remote-section')).toHaveTextContent('같은 권한');
  });

  it('copies the remote link', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mount('subtok');
    fireEvent.click(screen.getByTestId('remote-reveal'));
    screen.getByTestId('remote-link-copy').click();
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${location.origin}/r/K7M2QX#subtok`));
  });

  it('hides the section without a sub-commander token', () => {
    mount();
    expect(screen.queryByTestId('remote-reveal')).toBeNull();
  });
});
