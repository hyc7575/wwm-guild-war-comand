import type { ReactNode } from 'react';
import { MantineProvider, createTheme } from '@mantine/core';
import '@mantine/core/styles.css';

const theme = createTheme({ primaryColor: 'blue', defaultRadius: 'md' });

/** Mantine is confined to commander/operator screens; this shell is lazy-loaded with them. */
export function MantineShell({ children }: { children: ReactNode }) {
  return (
    <MantineProvider theme={theme} defaultColorScheme="dark" forceColorScheme="dark">
      {children}
    </MantineProvider>
  );
}
