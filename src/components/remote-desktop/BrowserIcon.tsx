import type { BrowserIconName } from './browserTypes';

function BrowserIcon({ name, filled = false }: { name: BrowserIconName; filled?: boolean }) {
  if (name === 'star') {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path
          d="m12 3.6 2.54 5.15 5.69.83-4.12 4.01.97 5.67L12 16.59l-5.08 2.67.97-5.67L3.77 9.58l5.69-.83L12 3.6Z"
          fill={filled ? 'currentColor' : 'none'}
        />
      </svg>
    );
  }

  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      {name === 'arrow-left' ? <path d="m14.5 5-7 7 7 7M8 12h9" /> : null}
      {name === 'arrow-right' ? <path d="m9.5 5 7 7-7 7M16 12H7" /> : null}
      {name === 'clock' ? <path d="M12 7v5l3.5 2M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z" /> : null}
      {name === 'go' ? <path d="M5 12h13M13 6l6 6-6 6" /> : null}
      {name === 'home' ? <path d="M4.75 11.25 12 5.25l7.25 6M6.75 10v8.75h10.5V10M10 18.75v-4.5h4v4.5" /> : null}
      {name === 'more' ? <path d="M12 5.5v.01M12 12v.01M12 18.5v.01" /> : null}
      {name === 'panel' ? <path d="M5 7h14M5 12h14M5 17h9" /> : null}
      {name === 'reload' ? <path d="M18.4 8.2v4.6h-4.6M5.6 15.8v-4.6h4.6M17.65 12.8a5.75 5.75 0 0 1-9.85 3.15L5.6 13.75M6.35 11.2a5.75 5.75 0 0 1 9.85-3.15l2.2 2.2" /> : null}
      {name === 'route' ? <path d="M7 18a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm10-6a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM9.5 14.5l5-5" /> : null}
      {name === 'shield' ? <path d="M12 21s7-3.1 7-9V5l-7-2-7 2v7c0 5.9 7 9 7 9Zm-3.2-9.2 2 2 4.5-5" /> : null}
      {name === 'stop' ? <path d="M7 7h10v10H7z" /> : null}
    </svg>
  );
}

export default BrowserIcon;
