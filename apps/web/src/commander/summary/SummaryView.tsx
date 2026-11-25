import { Button, Group, Stack, Table, Text, Title } from '@mantine/core';
import { downloadSummaryJson } from './export';
import { fmtDateTime, fmtDuration, fmtLatency, publishRate } from './format';
import type { SessionSummary } from './types';

/** FR-F07-8/9: one session summary, as numbers the planner can compare against KR1-KR3. */
export function SummaryView({ summary, temp }: { summary: SessionSummary; temp?: boolean }) {
  const s = summary;
  const byParty = Object.entries(s.peakByParty).sort((a, b) => Number(a[0]) - Number(b[0]));
  const rows: Array<[string, string]> = [
    ['방 코드', s.roomCode],
    ['시작', fmtDateTime(s.startedAt)],
    [temp ? '마지막 저장' : '종료', fmtDateTime(s.endedAt)],
    ['음성인식 작동 시간', fmtDuration(s.sttActiveMs)],
    ['음성인식 자동 복구', `${s.sttRecoveries}회`],
    ['최대 동시 접속', `${s.peakMembers}명`],
    ['파티별 최대 인원', byParty.length ? byParty.map(([n, v]) => `${n}파티 ${v}명`).join(', ') : '-'],
    ['발행 (음성 / 수동)', `${s.issued.voice} / ${s.issued.manual}`],
    [
      '발행자별 (메인오더 / 서브오더 / 운영자)',
      `${s.issued.byRole?.COMMANDER ?? 0} / ${s.issued.byRole?.SUB_COMMANDER ?? 0} / ${s.issued.byRole?.OPERATOR ?? 0}`,
    ],
    ['후보 (표시 / 게시)', `${s.candidates.shown} / ${s.candidates.published} (${publishRate(s)})`],
    ['취소 (오인식 / 변경)', `${s.cancelled.misrecognized} / ${s.cancelled.changed}`],
    ['다른 사람이 한 취소 (서브오더 / 운영자)', `${s.cancelled.byOthers?.SUB_COMMANDER ?? 0} / ${s.cancelled.byOthers?.OPERATOR ?? 0}`],
    ['정정', `${s.corrected}`],
    ['말 끝 → 전달 확인 지연 (p50 / p95)', `${fmtLatency(s.latencyMs.p50)} / ${fmtLatency(s.latencyMs.p95)}`],
  ];
  return (
    <Stack gap="sm" data-testid="summary-view">
      <Group justify="space-between">
        <Title order={3} size="h4">
          {temp ? '마지막 임시 저장본' : '세션 요약'}
        </Title>
        <Button variant="default" size="xs" onClick={() => downloadSummaryJson(s)} data-testid="summary-export">
          JSON 내보내기
        </Button>
      </Group>
      {temp && (
        <Text size="sm" c="dimmed">
          방이 정상 종료되기 전에 브라우저가 꺼져 1분 주기 저장본만 남았습니다.
        </Text>
      )}
      <Table>
        <Table.Tbody>
          {rows.map(([k, v]) => (
            <Table.Tr key={k}>
              <Table.Th w="55%">{k}</Table.Th>
              <Table.Td>{v}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}
