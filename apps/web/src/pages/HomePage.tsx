import { Link } from 'react-router';
import { CodeEntry } from './CodeEntry';
import styles from './pages.module.css';

export function HomePage() {
  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Winds Command</h1>
      <p className={styles.dim}>음성 명령을 동맹원 화면으로 바로 전달합니다.</p>
      <section className={styles.card}>
        <h2>방 들어가기</h2>
        <CodeEntry />
      </section>
      <section className={styles.card}>
        <h2>메인오더</h2>
        <Link to="/create" className={styles.primaryLink}>
          방 만들기
        </Link>
      </section>
    </main>
  );
}
