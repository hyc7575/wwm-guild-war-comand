import { describe, expect, it } from 'vitest';
import { isTypingContext, mapShortcut } from './shortcuts';

const m = (key: string, code?: string, extra: object = {}) => mapShortcut({ key, code, ...extra }, { partyCount: 5 });

describe('mapShortcut', () => {
  it('digits toggle parties 1-9 within the party count, 0 toggles 전체', () => {
    expect(m('3', 'Digit3')).toEqual({ type: 'toggleParty', number: 3 });
    expect(m('6', 'Digit6')).toBeNull();
    expect(m('0', 'Digit0')).toEqual({ type: 'toggleAll' });
  });
  it('QWERTYU map to the seven actions in order', () => {
    const keys = ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU'];
    expect(keys.map((c) => (m('x', c) as { action: string }).action)).toEqual([
      'GATHER', 'MOVE', 'ATTACK', 'DEFEND', 'RETREAT', 'SUPPORT', 'HOLD',
    ]);
  });
  it('ASDFG map to location slots 0-4', () => {
    expect(['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG'].map((c) => (m('x', c) as { index: number }).index)).toEqual([0, 1, 2, 3, 4]);
  });
  it('works with the Korean IME (code wins over key)', () => {
    expect(m('ㅂ', 'KeyQ')).toEqual({ type: 'action', action: 'GATHER' });
  });
  it('falls back to key when code is missing, case-insensitively', () => {
    expect(m('q')).toEqual({ type: 'action', action: 'GATHER' });
    expect(m('E')).toEqual({ type: 'action', action: 'ATTACK' });
  });
  it('Enter publishes and Esc cancels the last command', () => {
    expect(m('Enter', 'Enter')).toEqual({ type: 'publish' });
    expect(m('Escape', 'Escape')).toEqual({ type: 'cancelLast' });
  });
  it('ignores modified keys (browser shortcuts) and unmapped keys', () => {
    expect(m('q', 'KeyQ', { ctrlKey: true })).toBeNull();
    expect(m('r', 'KeyR', { metaKey: true })).toBeNull();
    expect(m('z', 'KeyZ')).toBeNull();
  });
});

describe('isTypingContext', () => {
  it('is true for inputs and while a dialog is open', () => {
    const input = document.createElement('input');
    expect(isTypingContext(input)).toBe(true);
    expect(isTypingContext(document.body)).toBe(false);
    const d = document.createElement('div');
    d.setAttribute('role', 'dialog');
    document.body.appendChild(d);
    expect(isTypingContext(document.body)).toBe(true);
    d.remove();
  });
  it('is false for switch/checkbox/radio/button inputs so shortcuts survive clicking a toggle', () => {
    for (const type of ['checkbox', 'radio', 'button']) {
      const i = document.createElement('input');
      i.type = type;
      expect(isTypingContext(i)).toBe(false);
    }
    const text = document.createElement('input');
    text.type = 'text';
    expect(isTypingContext(text)).toBe(true);
  });
});
