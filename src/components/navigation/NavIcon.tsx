export type NavIconName = 'hosts' | 'agent' | 'keys' | 'snippets' | 'proxies' | 'known-hosts' | 'logs' | 'settings';

interface NavIconProps {
  name: NavIconName;
}

function NavIcon({ name }: NavIconProps) {
  if (name === 'agent') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4.5 7.25A2.75 2.75 0 0 1 7.25 4.5h7.5a2.75 2.75 0 0 1 2.75 2.75v7.5a2.75 2.75 0 0 1-2.75 2.75h-7.5a2.75 2.75 0 0 1-2.75-2.75v-7.5Z" />
        <path d="m8 9.5 2.5 2.5L8 14.5M12.5 14.5h2.5" />
        <path d="M18.5 2v3M17 3.5h3M20.5 18v4M18.5 20h4" />
      </svg>
    );
  }

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

  if (name === 'proxies') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 7.5h4.5A3.5 3.5 0 0 1 14 11v2a3.5 3.5 0 0 0 3.5 3.5H18" />
        <path d="M4 5.5h4v4H4v-4ZM16 14.5h4v4h-4v-4Z" />
        <path d="M14 7h4M16 5l2 2-2 2" />
      </svg>
    );
  }

  if (name === 'known-hosts') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3.5 19 6v5.25c0 4.4-2.8 7.55-7 9.25-4.2-1.7-7-4.85-7-9.25V6l7-2.5Z" />
        <path d="M9 12.2 11 14l4-4.5" />
      </svg>
    );
  }

  if (name === 'snippets') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m8 6-5 6 5 6" />
        <path d="m16 6 5 6-5 6" />
        <path d="M13.5 4.5 10.5 19.5" />
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
