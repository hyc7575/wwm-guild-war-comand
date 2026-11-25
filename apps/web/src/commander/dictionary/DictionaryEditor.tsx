import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Alert, Badge, Button, CloseButton, Group, Modal, Paper, Select, Stack, Tabs, Text, TextInput, Textarea } from '@mantine/core';
import { makeDefaultParties, type Action } from '@winds/protocol';
import { findDictionaryConflicts, parse, serializeDictionary, validateDictionaryImport, type Dictionary } from '@winds/parser';
import { useRoomStore } from '../../state/roomStore';
import { ACTION_LABEL, ACTION_ORDER } from '../../shared/labels';
import { describeDraft, describePatch } from '../labels';
import { IdbTuningLog, type TuningEntry } from '../pipeline/tuningLog';
import {
  addActionExpression,
  addLocation,
  addLocationAlias,
  findActionOwner,
  hasMergeDiff,
  isDisabled,
  removeActionExpression,
  removeLocation,
  removeLocationAlias,
  setBaseDisabled,
  type MergeDiff,
} from './editing';
import { getDictionaryStore, type DictionaryStore } from './store';
import { suggestFromTuningLog } from './suggest';

interface Props {
  opened: boolean;
  onClose(): void;
  store?: DictionaryStore;
  readTuningLog?: () => Promise<TuningEntry[]>;
}

/** F09: alliance dictionary editor (add / disable / delete expressions, conflicts, test, import/export, tuning suggestions). */
export function DictionaryEditor({ opened, onClose, store, readTuningLog }: Props) {
  return (
    <Modal opened={opened} onClose={onClose} title="동맹 사전" size="xl" centered transitionProps={{ duration: 0 }}>
      {opened && <Body store={store ?? getDictionaryStore()} readTuningLog={readTuningLog} />}
    </Modal>
  );
}

function useStore(store: DictionaryStore) {
  const alliance = useSyncExternalStore(store.subscribe, () => store.getAlliance());
  return { alliance, merged: store.getMerged(), base: store.getBase() };
}

/** Runs a store update; a schema violation (too long, too many) is shown instead of thrown. */
function useApply(store: DictionaryStore) {
  const [error, setError] = useState<string | null>(null);
  const apply = (next: Dictionary): boolean => {
    try {
      store.set(next);
      setError(null);
      return true;
    } catch {
      setError('사전 형식 한도를 넘었습니다. (표현 40자, 위치 이름 20자, 목록 길이 제한)');
      return false;
    }
  };
  return { apply, error };
}

function Body({ store, readTuningLog }: { store: DictionaryStore; readTuningLog?: Props['readTuningLog'] }) {
  const { alliance, merged, base } = useStore(store);
  const { apply, error } = useApply(store);
  const conflicts = findDictionaryConflicts(alliance);
  return (
    <Stack gap="sm">
      {error && <Alert color="red" data-testid="dict-error">{error}</Alert>}
      {store.getLoadNote() && <Alert color="orange" data-testid="dict-load-note">{store.getLoadNote()}</Alert>}
      {store.getSaveError() && <Alert color="red" data-testid="dict-save-error">{store.getSaveError()}</Alert>}
      {conflicts.length > 0 && (
        <Alert color="yellow" title="충돌 경고" data-testid="dict-conflicts">
          {conflicts.map((c) => (
            <Text key={c.expression} size="sm">
              "{c.expression}"이(가) 여러 행동에 있습니다: {c.actions.map((a) => ACTION_LABEL[a]).join(', ')}
            </Text>
          ))}
        </Alert>
      )}
      <Tabs defaultValue="actions" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="actions">행동어</Tabs.Tab>
          <Tabs.Tab value="locations">위치</Tabs.Tab>
          <Tabs.Tab value="test">사전 테스트</Tabs.Tab>
          <Tabs.Tab value="share">내보내기·가져오기</Tabs.Tab>
          <Tabs.Tab value="tuning">추천</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="actions" pt="sm">
          <ActionsTab alliance={alliance} merged={merged} base={base} apply={apply} />
        </Tabs.Panel>
        <Tabs.Panel value="locations" pt="sm">
          <LocationsTab alliance={alliance} base={base} apply={apply} />
        </Tabs.Panel>
        <Tabs.Panel value="test" pt="sm">
          <TestTab dictionary={merged} />
        </Tabs.Panel>
        <Tabs.Panel value="share" pt="sm">
          <ShareTab store={store} alliance={alliance} />
        </Tabs.Panel>
        <Tabs.Panel value="tuning" pt="sm">
          <TuningTab merged={merged} apply={apply} alliance={alliance} readTuningLog={readTuningLog} />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}

interface TabProps {
  alliance: Dictionary;
  apply(d: Dictionary): boolean;
}

// ---------- 행동어 ----------

function ActionsTab({ alliance, merged, base, apply }: TabProps & { merged: Dictionary; base: Dictionary }) {
  const [action, setAction] = useState<Action>('ATTACK');
  const [text, setText] = useState('');
  const [pending, setPending] = useState<{ expr: string; owner: Action } | null>(null);

  const add = (expr: string, force = false) => {
    const e = expr.trim();
    if (!e) return;
    const owner = findActionOwner(merged, e, action);
    if (owner && !force) {
      setPending({ expr: e, owner });
      return;
    }
    if (apply(addActionExpression(alliance, action, e))) {
      setText('');
      setPending(null);
    }
  };

  return (
    <Stack gap="sm">
      <Group align="flex-end" gap="xs">
        <Select
          label="행동"
          data={ACTION_ORDER.map((a) => ({ value: a, label: ACTION_LABEL[a] }))}
          value={action}
          onChange={(v) => v && setAction(v as Action)}
          allowDeselect={false}
          w={120}
          comboboxProps={{ transitionProps: { duration: 0 } }}
          data-testid="dict-action-select"
        />
        <TextInput
          label="표현"
          placeholder="예: 박아넣어"
          value={text}
          onChange={(e) => {
            setText(e.currentTarget.value);
            setPending(null);
          }}
          onKeyDown={(e) => e.key === 'Enter' && add(text)}
          data-testid="dict-action-input"
        />
        <Button onClick={() => add(text)} data-testid="dict-action-add">
          추가
        </Button>
      </Group>
      {pending && (
        <Alert color="yellow" title="다른 행동에 이미 있는 표현" data-testid="dict-action-conflict">
          <Text size="sm">
            "{pending.expr}"은(는) 지금 {ACTION_LABEL[pending.owner]}에 있습니다. 어느 쪽에 둘까요?
          </Text>
          <Group gap="xs" mt="xs">
            <Button size="xs" onClick={() => add(pending.expr, true)} data-testid="dict-conflict-move">
              {ACTION_LABEL[action]}에 둔다
            </Button>
            <Button size="xs" variant="default" onClick={() => setPending(null)}>
              {ACTION_LABEL[pending.owner]} 유지
            </Button>
          </Group>
        </Alert>
      )}
      {ACTION_ORDER.map((a) => (
        <Paper key={a} withBorder p="xs" data-testid={`dict-action-${a}`}>
          <Text fw={600} size="sm" mb={4}>
            {ACTION_LABEL[a]}
          </Text>
          <Group gap={6}>
            {base.actions[a].map((e) => {
              const off = isDisabled(alliance, e);
              return (
                <Badge
                  key={`b-${e}`}
                  variant={off ? 'outline' : 'light'}
                  color={off ? 'gray' : 'blue'}
                  style={{ cursor: 'pointer', textDecoration: off ? 'line-through' : undefined }}
                  onClick={() => apply(setBaseDisabled(alliance, e, !off))}
                  title={off ? '꺼짐 · 누르면 켭니다' : '기본 · 누르면 끕니다'}
                  data-testid={`dict-base-${a}-${e}`}
                >
                  {e}
                </Badge>
              );
            })}
            {alliance.actions[a].map((e) => (
              <Badge
                key={`o-${e}`}
                color="teal"
                rightSection={<CloseButton size="xs" aria-label={`${e} 삭제`} onClick={() => apply(removeActionExpression(alliance, a, e))} />}
                data-testid={`dict-own-${a}-${e}`}
              >
                {e}
              </Badge>
            ))}
          </Group>
        </Paper>
      ))}
      <Text size="xs" c="dimmed">
        파란색은 기본 사전(누르면 끄기/켜기), 초록색은 우리 동맹이 추가한 표현입니다.
      </Text>
    </Stack>
  );
}

// ---------- 위치 ----------

function LocationsTab({ alliance, base, apply }: TabProps & { base: Dictionary }) {
  const [label, setLabel] = useState('');
  const [aliases, setAliases] = useState('');
  const [aliasDraft, setAliasDraft] = useState<Record<string, string>>({});
  const baseIds = useMemo(() => new Set(base.locations.map((l) => l.id)), [base]);
  const rows = [
    ...base.locations.map((b) => ({ id: b.id, label: b.label, baseAliases: b.aliases, own: alliance.locations.find((l) => l.id === b.id)?.aliases ?? [], custom: false })),
    ...alliance.locations.filter((l) => !baseIds.has(l.id)).map((l) => ({ id: l.id, label: l.label, baseAliases: [] as string[], own: l.aliases, custom: true })),
  ];
  return (
    <Stack gap="sm">
      <Group align="flex-end" gap="xs">
        <TextInput label="새 위치 이름" placeholder="예: 북문" value={label} onChange={(e) => setLabel(e.currentTarget.value)} data-testid="dict-loc-label" />
        <TextInput label="별칭 (쉼표로 구분)" placeholder="예: 위쪽 문, 북쪽 문" value={aliases} onChange={(e) => setAliases(e.currentTarget.value)} data-testid="dict-loc-aliases" />
        <Button
          onClick={() => {
            if (apply(addLocation(alliance, label, aliases.split(',')))) {
              setLabel('');
              setAliases('');
            }
          }}
          data-testid="dict-loc-add"
        >
          위치 추가
        </Button>
      </Group>
      {rows.map((r) => (
        <Paper key={r.id} withBorder p="xs" data-testid={`dict-loc-${r.id}`}>
          <Group justify="space-between" mb={4}>
            <Text fw={600} size="sm">
              {r.label} {r.custom ? <Badge size="xs" color="teal">추가됨</Badge> : <Badge size="xs" variant="light">기본</Badge>}
            </Text>
            {r.custom && (
              <Button size="compact-xs" color="red" variant="light" onClick={() => apply(removeLocation(alliance, r.id))} data-testid={`dict-loc-del-${r.id}`}>
                삭제
              </Button>
            )}
          </Group>
          <Group gap={6} align="center">
            {r.baseAliases.map((e) => {
              const off = isDisabled(alliance, e);
              return (
                <Badge key={`b-${e}`} variant={off ? 'outline' : 'light'} color={off ? 'gray' : 'blue'} style={{ cursor: 'pointer', textDecoration: off ? 'line-through' : undefined }} onClick={() => apply(setBaseDisabled(alliance, e, !off))}>
                  {e}
                </Badge>
              );
            })}
            {r.own.map((e) => (
              <Badge key={`o-${e}`} color="teal" rightSection={<CloseButton size="xs" aria-label={`${e} 삭제`} onClick={() => apply(removeLocationAlias(alliance, r.id, e, baseIds))} />}>
                {e}
              </Badge>
            ))}
            <TextInput
              size="xs"
              placeholder="별칭 추가"
              w={110}
              value={aliasDraft[r.id] ?? ''}
              onChange={(e) => setAliasDraft({ ...aliasDraft, [r.id]: e.currentTarget.value })}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                if (apply(addLocationAlias(alliance, r.id, r.label, aliasDraft[r.id] ?? ''))) setAliasDraft({ ...aliasDraft, [r.id]: '' });
              }}
              data-testid={`dict-loc-alias-${r.id}`}
            />
          </Group>
        </Paper>
      ))}
    </Stack>
  );
}

// ---------- 사전 테스트 ----------

export function TestTab({ dictionary }: { dictionary: Dictionary }) {
  const [text, setText] = useState('');
  const roomParties = useRoomStore((s) => s.parties);
  const targetlessAsAll = useRoomStore((s) => s.settings.targetlessAsAll);
  const parties = roomParties.length ? roomParties : makeDefaultParties(3);
  const results = useMemo(
    () => (text.trim() ? parse(text.trim(), { parties, dictionary, now: Date.now(), options: { targetlessAsAll } }) : []),
    [text, parties, dictionary, targetlessAsAll],
  );
  return (
    <Stack gap="sm">
      <TextInput label="문장" placeholder="예: 1파티 박아넣어" value={text} onChange={(e) => setText(e.currentTarget.value)} data-testid="dict-test-input" />
      <Stack gap={4} data-testid="dict-test-result">
        {results.map((r, i) => (
          <Paper key={i} withBorder p="xs">
            {r.kind === 'ISSUE' && (
              <>
                <Text size="sm">
                  명령: <b>{describeDraft(r.draft, parties)}</b> <Badge color={r.confidence === 'HIGH' ? 'green' : 'yellow'}>신뢰도 {r.confidence === 'HIGH' ? '높음' : '중간(후보)'}</Badge>
                </Text>
                <Text size="xs" c="dimmed">근거: {r.evidence.map((m) => `${m.slot}:${m.text}`).join(' · ')}</Text>
              </>
            )}
            {r.kind === 'CORRECT' && (
              <Text size="sm">
                정정: <b>{describePatch(r.patch, parties)}</b> <Badge color={r.confidence === 'HIGH' ? 'green' : 'yellow'}>신뢰도 {r.confidence === 'HIGH' ? '높음' : '중간(후보)'}</Badge>
              </Text>
            )}
            {r.kind === 'CANCEL' && <Text size="sm">직전 명령 취소</Text>}
            {r.kind === 'NONE' && (
              <Text size="sm" c="dimmed">
                버려짐: {r.reason}
              </Text>
            )}
          </Paper>
        ))}
      </Stack>
      <Text size="xs" c="dimmed">
        지금 방의 파티와 저장된 동맹 사전으로 해석합니다. 방에 정정·취소 대상 명령이 없으면 정정·취소는 나오지 않습니다.
      </Text>
    </Stack>
  );
}

// ---------- 내보내기·가져오기 ----------

function ShareTab({ store, alliance }: { store: DictionaryStore; alliance: Dictionary }) {
  const [raw, setRaw] = useState('');
  const [review, setReview] = useState<{ dictionary: Dictionary; warnings: string[] } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [done, setDone] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);

  /** Merge/overwrite can break the schema limits (list 500, locations 100): show it instead of throwing. */
  const runImport = (dictionary: Dictionary, mode: 'merge' | 'overwrite') => {
    try {
      store.importDictionary(dictionary, mode);
    } catch {
      setApplyError(
        mode === 'merge'
          ? '합친 결과가 사전 한도(행동별 표현 500개, 위치 100개 등)를 넘어 적용하지 못했습니다. 현재 사전은 그대로입니다. 필요 없는 표현을 지운 뒤 다시 시도하세요.'
          : '가져온 사전을 적용하지 못했습니다. 현재 사전은 그대로입니다.',
      );
      return;
    }
    setApplyError(null);
    setReview(null);
    setDone(mode === 'merge' ? '합쳤습니다.' : '덮어썼습니다.');
  };

  const doExport = () => {
    const blob = new Blob([serializeDictionary(alliance)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `winds-dictionary-${alliance.name}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const check = (text: string) => {
    setDone(null);
    setApplyError(null);
    setReview(null);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      setErrors(['JSON 형식이 아닙니다.']);
      return;
    }
    const r = validateDictionaryImport(json);
    if (r.ok) {
      setErrors([]);
      setReview({ dictionary: r.dictionary, warnings: r.warnings });
    } else setErrors(r.errors);
  };

  return (
    <Stack gap="sm">
      <Group>
        <Button onClick={doExport} data-testid="dict-export">
          JSON 파일로 내보내기
        </Button>
        <Button variant="default" onClick={() => setRaw(serializeDictionary(alliance))} data-testid="dict-export-show">
          아래에 JSON 보이기
        </Button>
      </Group>
      <Textarea label="가져올 JSON (붙여넣기)" rows={6} value={raw} onChange={(e) => setRaw(e.currentTarget.value)} data-testid="dict-import-text" />
      <Group>
        <input
          type="file"
          accept="application/json,.json"
          data-testid="dict-import-file"
          onChange={async (e) => {
            const f = e.currentTarget.files?.[0];
            if (!f) return;
            const t = await f.text();
            setRaw(t);
            check(t);
          }}
        />
        <Button variant="default" onClick={() => check(raw)} data-testid="dict-import-check">
          검토
        </Button>
      </Group>
      {errors.length > 0 && (
        <Alert color="red" title="가져올 수 없습니다" data-testid="dict-import-errors">
          {errors.map((e, i) => (
            <Text key={i} size="sm">{e}</Text>
          ))}
        </Alert>
      )}
      {review && (
        <Alert color="blue" title={`"${review.dictionary.name}" 사전을 가져옵니다`} data-testid="dict-import-review">
          {review.warnings.map((w, i) => (
            <Text key={i} size="sm" c="orange">{w}</Text>
          ))}
          <MergeDiffView diff={store.previewMerge(review.dictionary).diff} />
          <Text size="sm">현재 동맹 사전을 어떻게 할까요?</Text>
          <Group gap="xs" mt="xs">
            <Button
              size="xs"
              onClick={() => runImport(review.dictionary, 'merge')}
              data-testid="dict-import-merge"
            >
              합치기
            </Button>
            <Button
              size="xs"
              color="red"
              onClick={() => runImport(review.dictionary, 'overwrite')}
              data-testid="dict-import-overwrite"
            >
              덮어쓰기
            </Button>
          </Group>
        </Alert>
      )}
      {applyError && <Alert color="red" data-testid="dict-import-apply-error">{applyError}</Alert>}
      {done && <Alert color="green" data-testid="dict-import-done">{done}</Alert>}
      <Text size="xs" c="dimmed">사전은 이 브라우저에만 저장되고 서버로 올라가지 않습니다. 다른 지휘관과 나누려면 파일로 내보내 주세요.</Text>
    </Stack>
  );
}

function MergeDiffView({ diff }: { diff: MergeDiff }) {
  if (!hasMergeDiff(diff)) return <Text size="sm" data-testid="dict-merge-diff-none">합쳐도 현재 사전의 기존 항목이 바뀌지 않습니다.</Text>;
  return (
    <Stack gap={2} my="xs" data-testid="dict-merge-diff">
      <Text size="sm" fw={600}>합치면 달라지는 점</Text>
      {diff.renamedLocations.map((r) => (
        <Text key={r.to} size="sm" c="orange">
          위치 id 충돌: 내 "{r.clashedWith}"과(와) 가져온 "{r.label}"이(가) 같은 id({r.from})입니다. 가져온 쪽에 새 id({r.to})를 붙여 둘 다 유지합니다.
        </Text>
      ))}
      {diff.labelChanges.map((l) => (
        <Text key={l.id} size="sm" c="orange">
          위치 {l.id}의 이름이 "{l.from}"에서 "{l.to}"(으)로 바뀝니다.
        </Text>
      ))}
      {diff.movedExpressions.map((m) => (
        <Text key={m.expression} size="sm" c="orange">
          "{m.expression}": {ACTION_LABEL[m.from]} → {ACTION_LABEL[m.to]}(으)로 행동이 바뀝니다.
        </Text>
      ))}
    </Stack>
  );
}

// ---------- 튜닝 제안 (FR-F09-8) ----------

function TuningTab({ merged, alliance, apply, readTuningLog }: TabProps & { merged: Dictionary; readTuningLog?: Props['readTuningLog'] }) {
  const [entries, setEntries] = useState<TuningEntry[] | null>(null);
  const [picked, setPicked] = useState<Record<string, Action>>({});
  useEffect(() => {
    let live = true;
    const read = readTuningLog ?? (() => new IdbTuningLog().read());
    void read().then((e) => live && setEntries(e));
    return () => {
      live = false;
    };
  }, [readTuningLog]);
  const suggestions = useMemo(() => (entries ? suggestFromTuningLog(entries, merged) : []), [entries, merged]);

  if (!entries) return <Text size="sm">불러오는 중…</Text>;
  if (suggestions.length === 0) return <Text size="sm" c="dimmed" data-testid="dict-tuning-empty">추천할 표현이 아직 없습니다. 인식 못 한 문장에 같은 단어가 두 번 이상 나오면 여기에 보입니다.</Text>;
  return (
    <Stack gap="xs" data-testid="dict-tuning-list">
      <Text size="sm">인식하지 못해 버린 문장에서 자주 나온 단어입니다. 행동을 골라 사전에 추가하세요.</Text>
      {suggestions.map((s) => (
        <Paper key={s.word} withBorder p="xs" data-testid={`dict-suggest-${s.word}`}>
          <Group justify="space-between" wrap="nowrap">
            <div>
              <Text fw={600} size="sm">{s.word} <Badge size="xs" variant="light">{s.count}회</Badge></Text>
              <Text size="xs" c="dimmed">{s.examples.map((x) => `"${x}"`).join(' · ')}</Text>
            </div>
            <Group gap="xs" wrap="nowrap">
              <Select
                size="xs"
                w={90}
                aria-label={`${s.word} 행동`}
                placeholder="행동"
                data={ACTION_ORDER.map((a) => ({ value: a, label: ACTION_LABEL[a] }))}
                value={picked[s.word] ?? null}
                onChange={(v) => v && setPicked({ ...picked, [s.word]: v as Action })}
                comboboxProps={{ transitionProps: { duration: 0 } }}
              />
              <Button size="xs" disabled={!picked[s.word]} onClick={() => apply(addActionExpression(alliance, picked[s.word]!, s.word))} data-testid={`dict-suggest-add-${s.word}`}>
                사전에 추가
              </Button>
            </Group>
          </Group>
        </Paper>
      ))}
    </Stack>
  );
}
