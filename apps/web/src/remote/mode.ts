const key = (code: string) => `winds.remote.${code}`;

/**
 * /r/:code serves two screens: member join (no fragment) and the phone remote (#token).
 * The remote removes the fragment from the address bar, so a reload would look like a member join;
 * a per-tab flag keeps that tab in remote mode. No token is stored here.
 */
export function isRemoteEntry(code: string, hash: string): boolean {
  try {
    if (hash.length > 1) {
      sessionStorage.setItem(key(code), '1');
      return true;
    }
    return sessionStorage.getItem(key(code)) === '1';
  } catch {
    return hash.length > 1;
  }
}
