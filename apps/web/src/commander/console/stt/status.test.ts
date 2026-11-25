import { describe, expect, it } from 'vitest';
import { classifyError, statusView, tabTitle, toServerState, type UiSttState } from './status';

describe('stt status mapping', () => {
  it('maps supervisor states to the protocol OFF/STARTING/LISTENING/ERROR', () => {
    const cases: Array<[UiSttState, string]> = [
      ['IDLE', 'OFF'],
      ['STOPPED', 'OFF'],
      ['PREPARING', 'STARTING'],
      ['READY', 'STARTING'],
      ['RECOVERING', 'STARTING'],
      ['LISTENING', 'LISTENING'],
      ['ERROR', 'ERROR'],
      ['DISCONNECTED', 'ERROR'],
    ];
    for (const [ui, server] of cases) expect(toServerState(ui)).toBe(server);
  });

  it('has a label and color for every state, and the tab title', () => {
    expect(statusView('LISTENING')).toEqual({ label: '듣는 중', color: 'green' });
    expect(statusView('DISCONNECTED').label).toBe('마이크 연결 끊김');
    expect(tabTitle('LISTENING')).toBe('● 듣는 중 - Winds Command');
    expect(tabTitle('STOPPED')).toBe('멈춤 - Winds Command');
  });

  it('detects permission errors', () => {
    expect(classifyError('NotAllowedError: Permission denied')).toBe('permission');
    expect(classifyError('x', 'not-allowed')).toBe('permission');
    expect(classifyError('network down')).toBe('other');
  });
});
