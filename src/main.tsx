import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './tauriBridge';
import './styles/critical.scss';
import { clearThemePreloadTokens } from './theme/appearance';

let didScheduleInitialReveal = false;

async function loadDeferredStylesAndShow() {
  try {
    await import('./styles/deferred.scss');
  } catch (error) {
    console.error('Failed to load ShellDesk deferred styles:', error);
  }

  try {
    await window.guiSSH?.window?.show?.();
  } catch (error) {
    console.error('Failed to show ShellDesk window after first paint:', error);
  }
}

function scheduleInitialReveal() {
  if (didScheduleInitialReveal) {
    return;
  }
  didScheduleInitialReveal = true;

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      void loadDeferredStylesAndShow();
    });
  });
}

function ShellDeskRoot() {
  useEffect(() => {
    scheduleInitialReveal();
  }, []);

  return <App />;
}

clearThemePreloadTokens();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ShellDeskRoot />
  </StrictMode>,
);
