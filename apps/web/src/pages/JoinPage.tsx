import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { isValidRoomCode, normalizeRoomCode } from '@winds/protocol';
import { getRoom, type GetRoomResult } from '../net/api';
import { RoomSession } from '../net/RoomSession';
import { MemberRoom } from '../member/MemberRoom';
import { RoomMessage } from './NotFoundRoom';
import styles from './pages.module.css';

/** /r/:code. Checks the room over HTTP first so "방을 찾을 수 없습니다" shows before any WebSocket. */
export function JoinPage() {
  const code = normalizeRoomCode(useParams().code ?? '');
  const valid = isValidRoomCode(code);
  const [result, setResult] = useState<GetRoomResult | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!valid) return;
    setResult(null);
    const ctl = new AbortController();
    void getRoom(code, ctl.signal).then((r) => {
      if (!ctl.signal.aborted) setResult(r);
    });
    return () => ctl.abort();
  }, [code, valid, attempt]);

  if (!valid || result?.kind === 'not-found') return <RoomMessage title="방을 찾을 수 없습니다" />;
  if (!result) return <p className={styles.message}>방 확인 중…</p>;
  if (result.kind === 'error') {
    return (
      <RoomMessage title="서버에 연결할 수 없습니다">
        <button type="button" className={styles.primary} onClick={() => setAttempt((n) => n + 1)}>
          다시 시도
        </button>
      </RoomMessage>
    );
  }
  return (
    <RoomSession code={code} role="MEMBER">
      <MemberRoom code={code} fallbackParties={result.room.parties} />
    </RoomSession>
  );
}
