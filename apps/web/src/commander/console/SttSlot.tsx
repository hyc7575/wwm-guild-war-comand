import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { Alert, Badge, Button, Group, NativeSelect, Progress, Stack, Text } from '@mantine/core';
import { useRoomStore } from '../../state/roomStore';
import { useConsole } from './ConsoleProvider';
import { ENGINE_OPTIONS, SttController, type EngineChoice, type SttSnapshot } from './stt/SttController';
import { CallwordSetting } from './stt/CallwordSetting';
import { APP_TITLE, statusView, tabTitle } from './stt/status';

const FAKE_ALLOWED = (() => {
  try {
    return import.meta.env.DEV || new URLSearchParams(globalThis.location?.search ?? '').get('fakeStt') === '1';
  } catch {
    return false;
  }
})();
const FAKE_FROM_URL = (() => {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').get('fakeStt') === '1';
  } catch {
    return false;
  }
})();

export function useSttController(): SttController {
  const c = useConsole();
  const roomCode = useRoomStore((s) => s.roomCode) ?? 'room';
  const ctrl = useMemo(
    () =>
      new SttController({
        roomKey: roomCode,
        sink: { onFinal: (t, o) => c.pipeline.onFinalTranscript(t, o), onPartial: (t) => c.pipeline.onPartialTranscript(t) },
        onServerState: (s) => void c.sendSttStatus(s),
        allowFake: FAKE_ALLOWED,
        ...(FAKE_FROM_URL ? { initialEngine: 'fake' as const } : {}),
      }),
    [c, roomCode],
  );
  useEffect(() => {
    c.summary?.setSttStats(() => ctrl.getStats());
    void ctrl.refreshMics();
    return () => {
      ctrl.dispose();
      c.sendSttStatus('OFF');
    };
  }, [c, ctrl]);
  return ctrl;
}

const HELP_PERMISSION = [
  'Chrome: 주소창 왼쪽 자물쇠(또는 설정 아이콘) → 사이트 설정 → 마이크를 "허용"으로 바꾸고 새로고침합니다.',
  'Edge: 주소창 왼쪽 자물쇠 → 이 사이트에 대한 권한 → 마이크를 "허용"으로 바꾸고 새로고침합니다.',
];

function errorText(s: SttSnapshot): string {
  if (s.errorKind === 'unsupported' && /fetch:stt-wasm/.test(s.error ?? '') && !import.meta.env.DEV) {
    return '음성인식 구성 요소를 불러오지 못했습니다. 잠시 뒤 다시 시도하거나 다른 엔진을 고르세요.';
  }
  return s.error ?? '';
}

/**
 * Commander top-bar STT panel (F02): engine + mic choice, start/stop, status, level, last sentence, recovery count.
 * Final text goes to the command pipeline; the mapped state goes to the server as `stt.status`.
 */
export function SttSlot({ children }: { children?: ReactNode }) {
  if (children) return <div data-testid="stt-slot">{children}</div>;
  return (
    <div data-testid="stt-slot">
      <SttPanel />
    </div>
  );
}

function SttPanel() {
  const ctrl = useSttController();
  const s = useSyncExternalStore(ctrl.subscribe, ctrl.getSnapshot);
  const connection = useRoomStore((st) => st.connection);
  const roomStatus = useRoomStore((st) => st.roomStatus);
  const view = statusView(s.state);

  useEffect(() => {
    document.title = tabTitle(s.state);
    return () => {
      document.title = APP_TITLE;
    };
  }, [s.state]);

  useEffect(() => {
    if (connection === 'REPLACED') void ctrl.halt('replaced');
    else if (connection === 'CLOSED' || roomStatus === 'CLOSED') void ctrl.halt('closed');
    else if (connection === 'CONNECTED') ctrl.resendState();
  }, [connection, roomStatus, ctrl]);

  const running = ctrl.isRunning();
  const locked = s.halted !== undefined;
  const pct = s.progress && s.progress.total > 0 ? Math.min(100, Math.round((s.progress.loaded / s.progress.total) * 100)) : undefined;
  const engines = ENGINE_OPTIONS.filter((e) => e.value !== 'fake' || FAKE_ALLOWED);

  if (s.needsRestart && !locked) {
    return (
      <Stack gap={4}>
        <Button size="lg" color="green" onClick={() => void ctrl.start()} data-testid="stt-restart-big">
          음성인식 다시 시작
        </Button>
        <Text size="xs" c="dimmed">
          새로고침으로 음성인식이 멈췄습니다. 눌러서 다시 시작하세요.
        </Text>
      </Stack>
    );
  }

  return (
    <Stack gap={6} maw={560}>
      <Group gap="sm" align="flex-end" wrap="wrap">
        <Badge size="xl" color={view.color} variant="filled" data-testid="stt-status" data-state={s.state}>
          {view.label}
        </Badge>
        {running ? (
          <Button color="red" variant="light" onClick={() => void ctrl.stop()} data-testid="stt-stop">
            멈춤
          </Button>
        ) : (
          <Button onClick={() => void ctrl.start()} loading={s.busy} disabled={locked} data-testid="stt-start">
            {s.state === 'STOPPED' || s.state === 'ERROR' ? '음성인식 다시 시작' : '음성인식 시작'}
          </Button>
        )}
        <NativeSelect
          size="xs"
          aria-label="음성인식 엔진"
          data={engines}
          value={s.engine}
          disabled={running || s.busy}
          onChange={(e) => ctrl.setEngine(e.currentTarget.value as EngineChoice)}
          data-testid="stt-engine-select"
        />
        <NativeSelect
          size="xs"
          aria-label="마이크"
          data={[{ value: '', label: '시스템 기본 마이크' }, ...s.mics.map((m) => ({ value: m.deviceId, label: m.label }))]}
          value={s.deviceId ?? ''}
          disabled={running || s.busy}
          onChange={(e) => ctrl.setMic(e.currentTarget.value || undefined)}
          data-testid="stt-mic-select"
        />
      </Group>

      {s.busy && pct !== undefined && (
        <div data-testid="stt-progress">
          <Text size="xs">모델 준비 중 {pct}% (처음 한 번만 내려받습니다)</Text>
          <Progress value={pct} size="sm" />
        </div>
      )}

      <Progress value={Math.round(Math.min(1, s.level * 3) * 100)} size="xs" color={view.color} aria-label="입력 음량" data-testid="stt-level" />

      <Text size="sm" data-testid="stt-last-final">
        {s.lastFinal ? (
          <>
            마지막 인식 {new Date(s.lastFinal.at).toLocaleTimeString('ko-KR', { hour12: false })}: {s.lastFinal.text}
          </>
        ) : (
          '아직 인식한 문장이 없습니다'
        )}
      </Text>
      <Text size="xs" c="dimmed" data-testid="stt-recoveries">
        자동 복구 {s.recoveries}회
      </Text>

      {s.halted === 'replaced' && (
        <Alert color="orange" data-testid="stt-halted">
          다른 탭에서 열렸습니다. 이 탭의 음성인식을 멈췄습니다.
        </Alert>
      )}
      {s.halted === 'closed' && <Alert color="gray">방이 종료되어 음성인식을 멈췄습니다.</Alert>}
      {s.error && !locked && (
        <Alert color="red" role="alert" data-testid="stt-error">
          <Text size="sm">{errorText(s)}</Text>
          {s.errorKind === 'permission' && (
            <Stack gap={2} mt={4} data-testid="stt-permission-help">
              <Text size="sm" fw={700}>
                마이크 권한이 막혀 있습니다.
              </Text>
              {HELP_PERMISSION.map((t) => (
                <Text size="xs" key={t}>
                  {t}
                </Text>
              ))}
            </Stack>
          )}
        </Alert>
      )}
      <CallwordSetting />
      <Text size="xs" c="dimmed" data-testid="stt-privacy">
        음성은 이 브라우저 안에서만 처리되고 저장하지 않습니다
      </Text>
    </Stack>
  );
}
