import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ACTION_ORDER, ACTION_LABEL } from '../shared/labels';
import { ActionIcon } from '../member/hud';
import type { Action } from '@winds/protocol';
import styles from './GuidePage.module.css';

const ACTION_MEANING: Record<Action, string> = {
  GATHER: '한곳으로 모입니다.',
  MOVE: '지정한 곳으로 이동합니다.',
  ATTACK: '공격합니다.',
  DEFEND: '자리를 지키며 방어합니다.',
  RETREAT: '뒤로 물러납니다.',
  SUPPORT: '다른 파티를 도우러 갑니다.',
  HOLD: '지금 자리에서 대기합니다.',
};

const BANNERS: Array<{ text: string; tone: 'warn' | 'dim'; meaning: string }> = [
  { text: '다시 연결 중…', tone: 'warn', meaning: '내 인터넷이 잠깐 끊겼습니다. 화면의 명령이 최신이 아닐 수 있습니다. 음성을 들으세요. 연결되면 자동으로 사라집니다.' },
  { text: '메인오더 연결 끊김', tone: 'warn', meaning: '메인오더의 화면이 서버와 끊겼습니다. 새 명령이 안 올 수 있습니다. 음성을 들으세요.' },
  { text: '음성인식 꺼짐', tone: 'dim', meaning: '메인오더가 음성 자동 입력을 끈 상태입니다. 명령이 늦거나 직접 입력으로 올 수 있습니다.' },
];

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className={styles.card} aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>{title}</h2>
      {children}
    </section>
  );
}

/** /guide: 동맹원 안내 + 메인오더 빠른 시작. Mantine 없이, 모바일 우선. */
export function GuidePage() {
  const [tab, setTab] = useState<'member' | 'commander'>('member');
  return (
    <main className={styles.page}>
      <p className={styles.back}>
        <Link to="/">← 처음으로</Link>
      </p>
      <h1 className={styles.title}>사용 안내</h1>
      <p className={styles.lead}>
        <strong>화면은 보조, 음성이 우선입니다.</strong> 이 화면은 디스코드 음성을 놓쳤을 때 확인하는 용도입니다.
      </p>
      <div className={styles.tabs} role="tablist" aria-label="안내 선택">
        <button type="button" role="tab" aria-selected={tab === 'member'} className={styles.tab} onClick={() => setTab('member')}>
          동맹원
        </button>
        <button type="button" role="tab" aria-selected={tab === 'commander'} className={styles.tab} onClick={() => setTab('commander')}>
          메인오더
        </button>
      </div>

      {tab === 'member' ? (
        <>
          <Section id="join" title="1. 참여하기">
            <ul>
              <li>메인오더가 보낸 <strong>링크</strong>를 누릅니다. 끝입니다.</li>
              <li>링크가 없으면 첫 화면에서 <strong>6자리 방 코드</strong>를 입력합니다.</li>
              <li>PC 화면에 <strong>QR</strong>이 있으면 휴대폰 카메라로 찍습니다.</li>
              <li>회원가입, 로그인, 앱 설치가 없습니다.</li>
            </ul>
          </Section>

          <Section id="party" title="2. 내 파티 고르기">
            <ul>
              <li>처음 들어오면 <strong>어느 파티인가요?</strong> 화면이 나옵니다. 내 파티를 누릅니다.</li>
              <li>잘 모르겠으면 <strong>아직 모름</strong>을 누르세요. 전체 명령만 보입니다.</li>
              <li>바꾸려면 위쪽의 <strong>내 파티 ▼</strong>를 누르고 다시 고릅니다.</li>
              <li>파티를 잘못 고르면 남의 명령을 보게 됩니다. 꼭 확인하세요.</li>
            </ul>
          </Section>

          <Section id="card" title="3. 카드 읽는 법">
            <p>큰 카드에 지금 내 파티가 받아야 할 명령이 하나 보입니다. 전체 명령은 따로 한 줄로 보입니다. 아이콘과 색으로 한눈에 구분합니다.</p>
            <ul className={styles.legend}>
              {ACTION_ORDER.map((a) => (
                <li key={a}>
                  <ActionIcon action={a} size={36} title />
                  <span>
                    <strong>{ACTION_LABEL[a]}</strong>
                    <br />
                    <span className={styles.dim}>{ACTION_MEANING[a]}</span>
                  </span>
                </li>
              ))}
            </ul>
            <p className={styles.dim}>같은 명령을 다시 말하면 카드가 한 번 더 깜박입니다. 명령이 취소되면 이전 명령으로 돌아갑니다.</p>
          </Section>

          <Section id="phone" title="4. 휴대폰 설정">
            <ul>
              <li><strong>화면을 켜 두세요.</strong> 화면이 꺼지면 연결이 끊길 수 있습니다. 앱 안의 &quot;화면 꺼짐 방지&quot;를 켜 두면 도움이 됩니다.</li>
              <li>다른 앱으로 넘어가면 알림이 오지 않을 수 있습니다. 이 화면을 앞에 두세요.</li>
              <li>오른쪽 위 <strong>설정(톱니)</strong>에서 소리, 음량, 진동, 글자 크기를 바꿉니다.</li>
              <li>새 명령이 오면 알림음과 진동이 납니다. 진동은 지원하는 기기에서만 됩니다.</li>
              <li>무음 모드이면 소리가 나지 않을 수 있습니다.</li>
            </ul>
          </Section>

          <Section id="banners" title="5. 이런 표시가 뜨면">
            <ul className={styles.banners}>
              {BANNERS.map((b) => (
                <li key={b.text}>
                  <span className={`${styles.chip} ${b.tone === 'warn' ? styles.warn : ''}`}>{b.text}</span>
                  <p>{b.meaning}</p>
                </li>
              ))}
            </ul>
          </Section>

          <Section id="privacy" title="6. 개인정보">
            <ul>
              <li>계정이 없습니다. 이름이나 연락처를 받지 않습니다.</li>
              <li>음성은 <strong>메인오더의 브라우저 안에서만</strong> 글자로 바뀝니다. 서버로 보내지 않습니다. 동맹원의 마이크는 쓰지 않습니다.</li>
              <li>서버가 받는 것은 명령 글자, 파티 선택, 접속 상태뿐입니다.</li>
              <li>방을 닫으면 방 데이터가 지워집니다. 닫지 않아도 최대 4시간 뒤 자동으로 지워집니다.</li>
            </ul>
          </Section>
        </>
      ) : (
        <>
          <Section id="quick" title="빠른 시작">
            <ol>
              <li><Link to="/create">방 만들기</Link>에서 파티 수와 이름을 정하고 방을 만듭니다.</li>
              <li><strong>초대</strong> 창에서 링크를 복사해 디스코드에 붙입니다. QR도 있습니다.</li>
              <li>동맹원 수와 파티별 인원을 확인합니다. 파티를 안 고른 사람이 있으면 알려 줍니다.</li>
              <li><strong>음성 시작</strong>을 누르고 마이크를 허용합니다. 처음에는 모델을 받느라 시간이 걸립니다.</li>
              <li>&quot;3파티 중앙 집결&quot;처럼 말합니다. 후보가 뜨면 확인하고, 틀리면 바로 정정하거나 취소합니다.</li>
              <li>끝나면 <strong>방 닫기</strong>를 누릅니다. 모든 접속이 끊기고 방 데이터가 지워집니다.</li>
            </ol>
          </Section>
          <Section id="tips" title="알아 두기">
            <ul>
              <li>메인오더 화면은 한 곳에서만 엽니다. 다른 탭에서 열면 먼저 열었던 화면이 끊깁니다.</li>
              <li>메인오더가 30분 동안 없으면 방이 자동으로 닫힙니다.</li>
              <li>음성이 안 잡히면 직접 입력 버튼으로 같은 명령을 낼 수 있습니다.</li>
            </ul>
          </Section>
          <Section id="operator" title="운영자 링크">
            <ul>
              <li>방을 만들 때 <strong>운영자 링크</strong>가 함께 나옵니다. 메인오더 말고 명령을 대신 입력할 사람에게 줍니다.</li>
              <li>운영자는 버튼으로 명령을 내고 음성 인식 결과를 볼 수 있습니다. 방 닫기와 파티 설정은 못 합니다.</li>
              <li>링크를 아는 사람은 누구나 명령을 낼 수 있습니다. 공개 채널에 올리지 말고 믿는 사람에게만 보냅니다.</li>
            </ul>
          </Section>
        </>
      )}
    </main>
  );
}
