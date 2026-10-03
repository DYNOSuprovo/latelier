import React from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { Notifications } from '@mantine/notifications';
import ConnectionManager from './pages/ConnectionManager';
import NewConnection from './pages/NewConnection';
import Workspace from './pages/Workspace';
import { HintsProvider } from './hints/HintsProvider';
import { SettingsProvider } from './pages/SettingsContext';
import { ConnectionTransferProvider } from './features/connections/ConnectionTransferProvider';
import { PreSigningNotice } from './features/connections/PreSigningNotice';
import { CommandPaletteRoot } from './commands/CommandPalette';
import { PaletteContextProvider } from './commands/PaletteContext';
import { GlobalCommands } from './commands/GlobalCommands';
import { ConnectionPaletteCommands } from './commands/ConnectionPaletteCommands';
import { TroubleshootingProvider } from './troubleshooting/TroubleshootingProvider';
import { TroubleshootingPaletteCommand } from './troubleshooting/TroubleshootingPaletteCommand';
import { Splash } from './components/Splash';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useTheme } from './ThemeContext';
import { mantineTheme } from './theme/mantineTheme';

const SPLASH_DURATION_MS = 800;

// Skip splash entirely under e2e harness — preload exposes a flag based on
// NODE_ENV=test + ATELIER_USER_DATA_DIR. Tests don't benefit from the
// 800ms cosmetic overlay and it shifts timings onto other animations.
const isTestEnv =
  typeof window !== 'undefined' &&
  (window as unknown as { __atelierEnv__?: { isTest?: boolean } }).__atelierEnv__?.isTest === true;

export default function App() {
  const [splashVisible, setSplashVisible] = React.useState(!isTestEnv);
  React.useEffect(() => {
    if (isTestEnv) return;
    const t = window.setTimeout(() => setSplashVisible(false), SPLASH_DURATION_MS);
    return () => window.clearTimeout(t);
  }, []);
  // X12 Phase 0: drive Mantine's color scheme from the existing useTheme()
  // hook so Mantine and the legacy themeVars stay in lockstep. Routes keep their
  // own useTheme() calls; they share state via api.prefs broadcasts.
  const [dark] = useTheme();
  return (
    <MantineProvider theme={mantineTheme} forceColorScheme={dark ? 'dark' : 'light'}>
      <ModalsProvider>
        <Notifications position="bottom-right" />
        <HintsProvider>
          {splashVisible && <Splash />}
          <HashRouter>
            <PaletteContextProvider>
              <SettingsProvider>
                <ConnectionTransferProvider>
                {/* After the splash, and never under the e2e harness, where a launch dialog would sit on every test. */}
                {!splashVisible && !isTestEnv && <PreSigningNotice />}
                <CommandPaletteRoot>
                  <TroubleshootingProvider>
                    <GlobalCommands />
                    <ConnectionPaletteCommands />
                    <TroubleshootingPaletteCommand />
                    <ErrorBoundary>
                      <Routes>
                      <Route path="/" element={<Navigate to="/workspace" replace />} />
                      {/* Retired list-sidebar screen — the Switcher is how users
                          reach Connections now; send any old bookmark home. */}
                      <Route path="/connections" element={<Navigate to="/workspace" replace />} />
                      <Route path="/connections/:id" element={<ConnectionManager />} />
                      <Route path="/connections/new" element={<NewConnection />} />
                      <Route path="/connections/:id/edit" element={<NewConnection />} />
                      {/* Legacy route, redirect for any bookmarks */}
                      <Route path="/new-connection" element={<Navigate to="/connections/new" replace />} />
                      <Route path="/workspace" element={<Workspace />} />
                      {/* Aggregation lives inside /workspace as a tab kind (A01). */}
                      <Route path="/aggregation" element={<Navigate to="/workspace" replace />} />
                    </Routes>
                    </ErrorBoundary>
                  </TroubleshootingProvider>
                </CommandPaletteRoot>
                </ConnectionTransferProvider>
              </SettingsProvider>
            </PaletteContextProvider>
          </HashRouter>
        </HintsProvider>
      </ModalsProvider>
    </MantineProvider>
  );
}
