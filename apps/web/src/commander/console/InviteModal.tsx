import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Alert, Button, Group, Image, Modal, Stack, Text, TextInput } from '@mantine/core';

const absolute = (path: string) => `${location.origin}${path}`;

/** FR-F01-2: code, invite link (one-click copy), QR, and the operator link with a warning. */
export function InviteModal({
  opened,
  onClose,
  code,
  operatorToken,
}: {
  opened: boolean;
  onClose(): void;
  code: string;
  operatorToken?: string;
}) {
  const joinUrl = absolute(`/r/${code}`);
  const operatorUrl = operatorToken ? absolute(`/o/${code}#${operatorToken}`) : null;
  const [qr, setQr] = useState<string | null>(null);
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
      </Stack>
    </Modal>
  );
}
