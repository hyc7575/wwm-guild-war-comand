import { CodeEntry } from './CodeEntry';
import styles from './pages.module.css';

/** Shown for a missing / closed room: message plus the code input to try again. */
export function RoomMessage({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <main className={styles.page}>
      <div className={styles.message}>
        <h1 role="alert">{title}</h1>
        {children}
      </div>
      <section className={styles.card}>
        <CodeEntry autoFocus />
      </section>
    </main>
  );
}
