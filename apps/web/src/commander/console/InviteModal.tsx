import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Alert, Button, Divider, Group, Image, Modal, Paper, Stack, Text, TextInput } from '@mantine/core';

const absolute = (path: string) => `${location.origin}${path}`;

/** FR-F01-2: code, invite link (one-click copy), QR, and the operator link with a warning. */
export function InviteModal({
  opened,
  onClose,
  code,
  operatorToken,
  subCommanderToken,
}: {
  opened: boolean;
  onClose(): void;
  code: string;
  operatorToken?: string;
  subCommanderToken?: string;
}) {
  const joinUrl = absolute(`/r/${code}`);
  const operatorUrl = operatorToken ? absolute(`/o/${code}#${operatorToken}`) : null;
  const subUrl = subCommanderToken ? absolute(`/s/${code}#${subCommanderToken}`) : null;
  const remoteUrl = subCommanderToken ? absolute(`/r/${code}#${subCommanderToken}`) : null;
  const [remoteQr, setRemoteQr] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  // Command-authority links stay hidden until asked for: the modal opens by itself after room creation, so screen shares and captures would leak them.
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!opened) return;
    let live = true;
    QRCode.toDataURL(joinUrl, { margin: 1, width: 192 })
      .then((u) => live && setQr(u))
      .catch(() => live && setQr(null));
    return () => {
      live = false;
    };
  }, [joinUrl, opened]);

  useEffect(() => {
    if (!opened) setRevealed(false);
  }, [opened]);

  useEffect(() => {
    if (!opened || !revealed || !remoteUrl) {
      setRemoteQr(null);
      return;
    }
    let live = true;
    // Generated in the browser: the token (URL fragment) never goes to a server or an image service.
    QRCode.toDataURL(remoteUrl, { margin: 1, width: 192 })
      .then((u) => live && setRemoteQr(u))
      .catch(() => live && setRemoteQr(null));
    return () => {
      live = false;
    };
  }, [remoteUrl, opened, revealed]);

  const copy = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setCopied(null);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="초대" centered transitionProps={{ duration: 0 }}>
      <Stack gap="sm">
        <Text c="dimmed" size="sm">
          방 코드
        </Text>
        <Text fz={32} fw={700} style={{ letterSpacing: '0.1em' }} data-testid="invite-code">
          {code}
        </Text>
        <TextInput readOnly value={joinUrl} aria-label="초대 링크" data-testid="invite-link" onFocus={(e) => e.currentTarget.select()} />
        <Group>
          <Button onClick={() => void copy('join', joinUrl)} data-testid="invite-copy">
            {copied === 'join' ? '복사됨' : '초대 링크 복사'}
          </Button>
        </Group>
        {qr && <Image src={qr} alt={`${code} 입장 QR`} w={192} h={192} />}
        {(subUrl || operatorUrl) && (
          <>
            <Divider my="sm" color="red" label="명령 권한 링크 (입장 링크와 다름)" labelPosition="center" />
            {!revealed ? (
              <Button color="red" variant="light" onClick={() => setRevealed(true)} data-testid="remote-reveal">
                리모컨 QR 보기
              </Button>
            ) : (
              <Paper withBorder p="sm" style={{ borderColor: 'var(--mantine-color-red-6)' }} data-testid="authority-section">
                <Stack gap="sm">
                  <Alert color="red" title="화면 공유 중에는 열지 마세요" data-testid="authority-warning">
                    이 QR을 찍은 사람은 명령 권한을 갖는다. 화면 공유 중에는 열지 마세요.
                  </Alert>
                  <Button variant="subtle" size="xs" onClick={() => setRevealed(false)} data-testid="remote-hide">
                    숨기기
                  </Button>
                {operatorUrl && (
                  <Stack gap="xs" mt="sm">
                    <Alert color="yellow" title="운영자 링크 주의">
                      이 링크를 받은 사람은 명령을 발행·정정·취소할 수 있습니다. 믿을 수 있는 사람에게만 보내세요.
                    </Alert>
                    <TextInput readOnly value={operatorUrl} aria-label="운영자 링크" data-testid="operator-link" onFocus={(e) => e.currentTarget.select()} />
                    <Button variant="default" onClick={() => void copy('op', operatorUrl)} data-testid="operator-link-copy">
                      {copied === 'op' ? '복사됨' : '운영자 링크 복사'}
                    </Button>
                  </Stack>
                )}
                  {subUrl && (
                    <Stack gap="xs" mt="sm">
                      <Alert color="yellow" title="서브오더 링크 주의">
                        서브오더: 전체 파티에 명령 가능, 방 설정은 못 함. 믿을 수 있는 사람에게만 보내세요.
                      </Alert>
                      <TextInput readOnly value={subUrl} aria-label="서브오더 링크" data-testid="sub-link" onFocus={(e) => e.currentTarget.select()} />
                      <Button variant="default" onClick={() => void copy('sub', subUrl)} data-testid="sub-link-copy">
                        {copied === 'sub' ? '복사됨' : '서브오더 링크 복사'}
                      </Button>
                    </Stack>
                  )}
                  {remoteUrl && (
                    <Stack gap="xs" mt="sm" data-testid="remote-section">
                      <Text fw={700}>휴대폰 리모컨</Text>
                      <Alert color="yellow" title="리모컨 링크 주의">
                        서브오더 권한을 휴대폰에 넘기는 링크입니다. 링크·QR을 가진 모든 기기가 같은 권한으로 명령을 내릴 수 있고, 기기별로 막을 수 없습니다.
                        본인 휴대폰에서만 여세요.
                      </Alert>
                      {remoteQr && <Image src={remoteQr} alt="휴대폰 리모컨 QR" w={192} h={192} data-testid="remote-qr" />}
                      <TextInput
                        readOnly
                        value={remoteUrl}
                        aria-label="휴대폰 리모컨 링크"
                        data-testid="remote-link"
                        onFocus={(e) => e.currentTarget.select()}
                      />
                      <Button variant="default" onClick={() => void copy('remote', remoteUrl)} data-testid="remote-link-copy">
                        {copied === 'remote' ? '복사됨' : '리모컨 링크 복사'}
                      </Button>
                    </Stack>
                  )}
                  {subUrl && (
                    <Text size="xs" c="dimmed">
                      서브오더·리모컨 링크는 같은 토큰을 씁니다. 여러 기기가 동시에 쓸 수 있습니다.
                    </Text>
                  )}
                </Stack>
              </Paper>
            )}
          </>
        )}
      </Stack>
    </Modal>
  );
}
