import { MantineShell } from '../commander/MantineShell';
import OperatorPage from './OperatorPage';

/** Lazy entry for /o/:code. */
export const Operator = () => (
  <MantineShell>
    <OperatorPage role="OPERATOR" />
  </MantineShell>
);

/** Lazy entry for /s/:code. Same screen as the operator, different role. */
export const SubCommander = () => (
  <MantineShell>
    <OperatorPage role="SUB_COMMANDER" />
  </MantineShell>
);
