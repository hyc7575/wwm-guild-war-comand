import { MantineShell } from '../commander/MantineShell';
import RemotePage from './RemotePage';

/** Lazy entry for /r/:code#token (phone remote). */
export const Remote = () => (
  <MantineShell>
    <RemotePage />
  </MantineShell>
);
