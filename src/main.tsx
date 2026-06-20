import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { getCurrentWindow } from '@tauri-apps/api/window';
import App from './App';
import './tauriBridge';
import './styles/index.scss';

let didRequestInitialShow = false;

function ShellDeskRoot() {
  useEffect(() => {
    if (didRequestInitialShow) {
      return;
    }
    didRequestInitialShow = true;

    const frame = requestAnimationFrame(() => {
      void getCurrentWindow().show().catch((error) => {
        console.error('Failed to show ShellDesk window after first paint:', error);
      });
    });

    return () => {
      cancelAnimationFrame(frame);
    };
  }, []);

  return <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ShellDeskRoot />
  </StrictMode>,
);
