import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { ROOM_CODE_LENGTH, normalizeRoomCode } from '@winds/protocol';
import styles from './pages.module.css';

/** Room code input. Case-insensitive: the code is upper-cased before navigating. */
export function CodeEntry({ autoFocus = false }: { autoFocus?: boolean }) {
  const [value, setValue] = useState('');
  const navigate = useNavigate();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const code = normalizeRoomCode(value);
    if (code) navigate(`/r/${code}`);
  };
  return (
    <form onSubmit={submit} className={styles.codeForm}>
      <label htmlFor="room-code" className={styles.label}>
        방 코드
      </label>
      <div className={styles.row}>
        <input
          id="room-code"
          className={styles.input}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          maxLength={ROOM_CODE_LENGTH + 2}
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          autoFocus={autoFocus}
          placeholder="예: AB3K7M"
        />
        <button type="submit" className={styles.primary} disabled={!value.trim()}>
          입장
        </button>
      </div>
    </form>
  );
}
