// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { isRemoteEntry } from './mode';

beforeEach(() => sessionStorage.clear());

describe('isRemoteEntry', () => {
  it('plain /r/:code is the member join', () => expect(isRemoteEntry('K7M2QX', '')).toBe(false));
  it('a fragment makes it the remote, and a reload without it stays remote in that tab', () => {
    expect(isRemoteEntry('K7M2QX', '#tok')).toBe(true);
    expect(isRemoteEntry('K7M2QX', '')).toBe(true);
    expect(isRemoteEntry('OTHER1', '')).toBe(false);
  });
});
