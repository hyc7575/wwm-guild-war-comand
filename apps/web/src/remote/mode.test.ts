// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { isRemoteEntry } from './mode';

const TOKEN = '#' + 'Ab3_-'.repeat(8) + 'xyz';

beforeEach(() => sessionStorage.clear());

describe('isRemoteEntry', () => {
  it('plain /r/:code is the member join', () => expect(isRemoteEntry('K7M2QX', '')).toBe(false));
  it('a token fragment makes it the remote, and a reload without it stays remote in that tab', () => {
    expect(isRemoteEntry('K7M2QX', TOKEN)).toBe(true);
    expect(isRemoteEntry('K7M2QX', '')).toBe(true);
    expect(isRemoteEntry('OTHER1', '')).toBe(false);
  });
  it('an arbitrary fragment is not a remote link and sets no flag', () => {
    expect(isRemoteEntry('K7M2QX', '#section')).toBe(false);
    expect(isRemoteEntry('K7M2QX', '#a b!')).toBe(false);
    expect(isRemoteEntry('K7M2QX', '')).toBe(false);
  });
});
