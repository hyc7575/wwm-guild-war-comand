/** Server tokens are base64url (43 chars today). Any other fragment is not a remote link, so it must not pin the tab to remote mode. */
const TOKEN_HASH = /^#[A-Za-z0-9_-]{16,128}$/;
const key = (code: string) => `winds.remote.${code}`;

/**
 * /r/:code serves two screens: member join (no fragment) and the phone remote (#token).
 * The remote removes the fragment from the address bar, so a reload would look like a member join;
 * a per-tab flag keeps that tab in remote mode. No token is stored here.
 */
export function isRemoteEntry(code: string, hash: string): boolean {
  const tokenLike = TOKEN_HASH.test(hash);
  try {
    if (tokenLike) {
      sessionStorage.setItem(key(code), '1');
      return true;
    }
    return sessionStorage.getItem(key(code)) === '1';
  } catch {
    return tokenLike;
  }
}
