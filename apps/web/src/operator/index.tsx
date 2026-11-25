import { MantineShell } from '../commander/MantineShell';
import OperatorPage from './OperatorPage';

/** Lazy entry for /o/:code. */
export const Operator = () => (
  <MantineShell>
    <OperatorPage />
  </MantineShell>
);
