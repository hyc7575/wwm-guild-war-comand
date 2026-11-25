import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Button, Group, Image, Paper, Stack, Text } from '@mantine/core';

function absolute(path: string): string {
  return `${location.origin}${path}`;
}

/** Invite link + QR (F01 FR-F01-2). Optionally shows the operator link. */
export function InvitePanel({ code, operatorToken }: { code: string; operatorToken?: string }) {
  const joinUrl = absolute(`/r/${code}`);
  const operatorUrl = operatorToken ? absolute(`/o/${code}#${operatorToken}`) : null;
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    QRCode.toDataURL(joinUrl, { margin: 1, width: 192 })
      .then((u) => live && setQr(u))
      .catch(() => live && setQr(null));
    return () => {
      live = false;
    };
  }, [joinUrl]);

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
    <Paper withBorder p="md" m="md">
      <Stack gap="xs">
        <Text size="sm" c="dimmed">
          방 코드
        </Text>
        <Text fz={32} fw={700} style={{ letterSpacing: '0.1em' }}>
          {code}
        </Text>
        <Group>
          <Button onClick={() => void copy('join', joinUrl)}>{copied === 'join' ? '복사됨' : '초대 링크 복사'}</Button>
          {operatorUrl && (
            <Button variant="default" onClick={() => void copy('op', operatorUrl)}>
              {copied === 'op' ? '복사됨' : '운영자 링크 복사'}
            </Button>
          )}
        </Group>
        {qr && <Image src={qr} alt={`${code} 입장 QR`} w={192} h={192} />}
      </Stack>
    </Paper>
  );
}
