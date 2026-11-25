import type { ReactNode } from 'react';
import { MantineShell } from './MantineShell';
import CreateRoomPage from './CreateRoomPage';
import CommanderRoomPage from './CommanderRoomPage';

/** Lazy entry points: each wraps its page in the Mantine shell. Not imported by the member route. */
const shell = (n: ReactNode) => <MantineShell>{n}</MantineShell>;

export const Create = () => shell(<CreateRoomPage />);
export const CommanderRoom = () => shell(<CommanderRoomPage />);
