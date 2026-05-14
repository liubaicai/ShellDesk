export type NavIconName = 'hosts' | 'keys' | 'logs' | 'settings';

interface NavIconProps {
  name: NavIconName;
}

function NavIcon({ name }: NavIconProps) {
  if (name === 'hosts') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 5.75A2.75 2.75 0 0 1 7.75 3h8.5A2.75 2.75 0 0 1 19 5.75v2.5A2.75 2.75 0 0 1 16.25 11h-8.5A2.75 2.75 0 0 1 5 8.25v-2.5Z" />
        <path d="M5 15.75A2.75 2.75 0 0 1 7.75 13h8.5A2.75 2.75 0 0 1 19 15.75v2.5A2.75 2.75 0 0 1 16.25 21h-8.5A2.75 2.75 0 0 1 5 18.25v-2.5Z" />
        <path d="M8 7h.01M8 17h.01M11 7h5M11 17h5" />
      </svg>
    );
  }

  if (name === 'keys') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M14.5 8.5a4.5 4.5 0 1 0-3.2 4.3L19 20.5l2-2-1.8-1.8 1.6-1.6-2-2-1.6 1.6-2.5-2.5a4.45 4.45 0 0 0-.2-3.7Z" />
        <path d="M7.5 8.5h.01" />
      </svg>
    );
  }

  if (name === 'logs') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8 4h8l2 2v14H6V4h2Z" />
        <path d="M9 9h6M9 13h6M9 17h4" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7Z" />
      <path d="M19.4 13.5a7.72 7.72 0 0 0 0-3l2-1.4-2-3.5-2.4 1a7.8 7.8 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.6A7.8 7.8 0 0 0 7 6.6l-2.4-1-2 3.5 2 1.4a7.72 7.72 0 0 0 0 3l-2 1.4 2 3.5 2.4-1a7.8 7.8 0 0 0 2.6 1.5l.4 2.6h4l.4-2.6a7.8 7.8 0 0 0 2.6-1.5l2.4 1 2-3.5-2-1.4Z" />
    </svg>
  );
}

export default NavIcon;
