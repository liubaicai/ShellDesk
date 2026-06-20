import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './tauriBridge';
import './styles/critical.scss';

let didScheduleInitialReveal = false;

function scheduleInitialReveal() {
  if (didScheduleInitialReveal) {
    return;
  }
  didScheduleInitialReveal = true;

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      void window.guiSSH?.window?.show?.().catch((error) => {
        console.error('Failed to show ShellDesk window after first paint:', error);
      });
      void import('./styles/deferred.scss').catch(() => {});
    });
  });
}

function ShellDeskRoot() {
  useEffect(() => {
    scheduleInitialReveal();
  }, []);

  return <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ShellDeskRoot />
  </StrictMode>,
);
