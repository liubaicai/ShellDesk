import { desktopAppIconSources, type DesktopAppKey } from '../../remoteDesktopCatalog';

export function AllAppsIcon() {
  return (
    <svg className="dock-all-apps-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="4" width="6" height="6" rx="1.6" />
      <rect x="14" y="4" width="6" height="6" rx="1.6" />
      <rect x="4" y="14" width="6" height="6" rx="1.6" />
      <rect x="14" y="14" width="6" height="6" rx="1.6" />
    </svg>
  );
}

export function DesktopAppIcon({ appKey }: { appKey: DesktopAppKey }) {
  const iconSource = desktopAppIconSources[appKey];

  if (iconSource) {
    return (
      <img
        className="desktop-app-icon"
        src={iconSource}
        alt=""
        aria-hidden="true"
        draggable={false}
      />
    );
  }

  const iconProps = {
    className: 'desktop-app-icon',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };

  if (appKey === 'files') {
    return (
      <svg {...iconProps}>
        <path d="M3.5 6.75A2.25 2.25 0 0 1 5.75 4.5h4.05l1.7 2h6.75a2.25 2.25 0 0 1 2.25 2.25v8a2.75 2.75 0 0 1-2.75 2.75H6.25a2.75 2.75 0 0 1-2.75-2.75v-10Z" />
        <path d="M4 9h16" />
      </svg>
    );
  }

  if (appKey === 'terminal') {
    return (
      <svg {...iconProps}>
        <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
        <path d="m7.25 9 2.8 2.5-2.8 2.5" />
        <path d="M12.25 14.25h4.5" />
      </svg>
    );
  }

  if (appKey === 'notepad') {
    return (
      <svg {...iconProps}>
        <path d="M6 3.75h8.25L18 7.5v12.75H6V3.75Z" />
        <path d="M14 4v4h4" />
        <path d="M8.75 10.5h5.5M8.75 14h6.5M8.75 17.5h3.5" />
      </svg>
    );
  }

  if (appKey === 'ai-chat') {
    return (
      <svg {...iconProps}>
        <path d="M5 5h14v10H8l-3 3V5Z" />
        <path d="M8 9h8" />
      </svg>
    );
  }

  if (appKey === 'browser') {
    return (
      <svg {...iconProps}>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M3.75 12h16.5" />
        <path d="M12 3.5c2.2 2.35 3.3 5.18 3.3 8.5s-1.1 6.15-3.3 8.5c-2.2-2.35-3.3-5.18-3.3-8.5S9.8 5.85 12 3.5Z" />
      </svg>
    );
  }

  if (appKey === 'vnc') {
    return (
      <svg {...iconProps}>
        <rect x="3.5" y="5" width="17" height="11.5" rx="2.25" />
        <path d="M8.5 20h7M12 16.5V20" />
        <path d="M7.25 9.5h9.5M7.25 12.5h4.5" />
      </svg>
    );
  }

  if (appKey === 'log-viewer') {
    return (
      <svg {...iconProps}>
        <path d="M6 3.75h8.25L18 7.5v12.75H6V3.75Z" />
        <path d="M14 4v4h4" />
        <path d="M8.75 11h6.5M8.75 14.25h6.5M8.75 17.5h4" />
        <circle cx="17.5" cy="17.5" r="2.25" />
      </svg>
    );
  }

  if (appKey === 'monitor') {
    return (
      <svg {...iconProps}>
        <path d="M4.25 18.75V5.25" />
        <path d="M4.25 18.75h15.5" />
        <path d="m7 15 3.15-3.4 2.75 2.25 4.45-5.2" />
        <path d="M16.75 8.65h2.1v2.1" />
      </svg>
    );
  }

  if (appKey === 'mysql') {
    return (
      <svg {...iconProps}>
        <ellipse cx="12" cy="5.75" rx="6.75" ry="2.75" />
        <path d="M5.25 5.75v8.5C5.25 15.77 8.27 17 12 17s6.75-1.23 6.75-2.75v-8.5" />
        <path d="M5.25 10c0 1.52 3.02 2.75 6.75 2.75S18.75 11.52 18.75 10" />
        <path d="M9.25 20.25h5.5" />
      </svg>
    );
  }

  if (appKey === 'redis') {
    return (
      <svg {...iconProps}>
        <path d="m12 3.75 7 3.4-7 3.35-7-3.35 7-3.4Z" />
        <path d="m5 11 7 3.35L19 11" />
        <path d="m5 14.9 7 3.35 7-3.35" />
      </svg>
    );
  }

  if (appKey === 'service-manager') {
    return (
      <svg {...iconProps}>
        <path d="M5 7h14M5 12h14M5 17h14" />
        <circle cx="9" cy="7" r="1.75" fill="currentColor" stroke="none" />
        <circle cx="15" cy="12" r="1.75" fill="currentColor" stroke="none" />
        <circle cx="11.5" cy="17" r="1.75" fill="currentColor" stroke="none" />
      </svg>
    );
  }

  if (appKey === 'container-manager') {
    return (
      <svg {...iconProps}>
        <path d="M5 8.5h14v8.25H5V8.5Z" />
        <path d="M8.5 8.5v8.25M12 8.5v8.25M15.5 8.5v8.25" />
        <path d="M7 5h10v3.5H7V5Z" />
        <path d="M6.25 19h11.5" />
      </svg>
    );
  }

  if (appKey === 'k8s-manager') {
    return (
      <svg {...iconProps}>
        <circle cx="12" cy="12" r="7.5" />
        <path d="M12 5.5v13M5.5 12h13" />
        <path d="m7.4 7.4 9.2 9.2M16.6 7.4l-9.2 9.2" />
        <circle cx="12" cy="12" r="2.2" />
      </svg>
    );
  }

  if (appKey === 'vm-manager') {
    return (
      <svg {...iconProps}>
        <rect x="4" y="6.5" width="16" height="12" rx="2" />
        <path d="M7 10h10M7 14h4" />
        <path d="m14.5 12 3 1.6v3.2l-3 1.7-3-1.7v-3.2l3-1.6Z" />
      </svg>
    );
  }

  if (appKey === 'frp-manager') {
    return (
      <svg {...iconProps}>
        <path d="M5 6.5h14v11H5v-11Z" />
        <path d="M8 9.5h8" />
        <path d="M8 14.5h8" />
        <path d="M9.5 4.5h5" />
        <path d="M9.5 19.5h5" />
        <circle cx="5" cy="12" r="1.75" />
        <circle cx="19" cy="12" r="1.75" />
      </svg>
    );
  }

  if (appKey === 'frps-manager') {
    return (
      <svg {...iconProps}>
        <path d="M5 5h14v6H5V5Z" />
        <path d="M5 13h14v6H5v-6Z" />
        <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
        <circle cx="8" cy="16" r="1" fill="currentColor" stroke="none" />
        <path d="M11 8h5M11 16h5" />
      </svg>
    );
  }

  if (appKey === 'port-manager') {
    return (
      <svg {...iconProps}>
        <path d="M4.25 7.5h5.25l2.5 4.5h7.75" />
        <path d="M4.25 16.5h5.25l2.5-4.5" />
        <circle cx="4.25" cy="7.5" r="1.75" />
        <circle cx="4.25" cy="16.5" r="1.75" />
        <circle cx="19.75" cy="12" r="1.75" />
        <path d="M13.25 7.5h2.75M15.75 16.5h2.25" />
      </svg>
    );
  }

  if (appKey === 'firewall-manager') {
    return (
      <svg {...iconProps}>
        <path d="M12 3.5 18.75 6v5.3c0 4.05-2.58 7.35-6.75 9.2-4.17-1.85-6.75-5.15-6.75-9.2V6L12 3.5Z" />
        <path d="M8.5 11.5h7" />
        <path d="M10 8.75v5.5M14 8.75v5.5" />
        <path d="M9.25 16.25h5.5" />
      </svg>
    );
  }

  if (appKey === 'network-diagnostics') {
    return (
      <svg {...iconProps}>
        <path d="M4.5 12a7.5 7.5 0 0 1 15 0" />
        <path d="M7.25 12a4.75 4.75 0 0 1 9.5 0" />
        <path d="M10 12a2 2 0 0 1 4 0" />
        <path d="M12 14.25v5" />
        <path d="M8.5 19.25h7" />
        <circle cx="12" cy="4.75" r="1.5" />
      </svg>
    );
  }

  if (appKey === 'disk-analyzer') {
    return (
      <svg {...iconProps}>
        <ellipse cx="12" cy="6" rx="6.5" ry="2.75" />
        <path d="M5.5 6v8.5c0 1.52 2.91 2.75 6.5 2.75s6.5-1.23 6.5-2.75V6" />
        <path d="M5.5 10.25C5.5 11.77 8.41 13 12 13s6.5-1.23 6.5-2.75" />
        <path d="M8.5 20h7" />
        <path d="M15.75 16.75 18.5 20" />
      </svg>
    );
  }

  if (appKey === 'disk-manager') {
    return (
      <svg {...iconProps}>
        <ellipse cx="12" cy="5.75" rx="6.25" ry="2.5" />
        <path d="M5.75 5.75v7.5c0 1.38 2.8 2.5 6.25 2.5s6.25-1.12 6.25-2.5v-7.5" />
        <path d="M5.75 9.5C5.75 10.88 8.55 12 12 12s6.25-1.12 6.25-2.5" />
        <path d="M8.5 19.25h7" />
        <path d="M12 16v5.5" />
        <path d="M15.25 18.25 17 20l2.75-3" />
      </svg>
    );
  }

  if (appKey === 'package-manager') {
    return (
      <svg {...iconProps}>
        <path d="m12 3.75 6.75 3.4v6.95L12 20.25 5.25 14.1V7.15L12 3.75Z" />
        <path d="m5.55 7.35 6.45 3.3 6.45-3.3" />
        <path d="M12 10.75v9" />
        <path d="m8.5 5.6 6.55 3.35" />
      </svg>
    );
  }

  if (appKey === 'scheduled-tasks') {
    return (
      <svg {...iconProps}>
        <rect x="4.25" y="5" width="15.5" height="14.75" rx="2.25" />
        <path d="M7.5 3.75v3M16.5 3.75v3M4.75 9h14.5" />
        <path d="M8 12.25h2.5M13 12.25h3M8 15.5h2.5" />
        <path d="m14.25 16 1.1 1.1 2.15-2.45" />
      </svg>
    );
  }

  if (appKey === 'postgres') {
    return (
      <svg {...iconProps}>
        <ellipse cx="12" cy="5.75" rx="6.75" ry="2.75" />
        <path d="M5.25 5.75v8.5C5.25 15.77 8.27 17 12 17s6.75-1.23 6.75-2.75v-8.5" />
        <path d="M5.25 10c0 1.52 3.02 2.75 6.75 2.75S18.75 11.52 18.75 10" />
        <path d="M8.25 20.25h7.5" />
        <path d="M9.25 15.75 7.75 19M14.75 15.75 16.25 19" />
      </svg>
    );
  }

  if (appKey === 'security-audit') {
    return (
      <svg {...iconProps}>
        <path d="M12 3.5 18.25 6v5.2c0 3.65-2.32 6.72-6.25 8.45-3.93-1.73-6.25-4.8-6.25-8.45V6L12 3.5Z" />
        <path d="m8.75 11.8 2.1 2.1 4.4-5" />
        <path d="M8.5 16.5h7" />
      </svg>
    );
  }

  if (appKey === 'api-debugger') {
    return (
      <svg {...iconProps}>
        <path d="m8.25 8-4 4 4 4" />
        <path d="m15.75 8 4 4-4 4" />
        <path d="m13.25 5.75-2.5 12.5" />
        <path d="M7.25 20.25h9.5" />
      </svg>
    );
  }

  if (appKey === 'procmanager') {
    return (
      <svg {...iconProps}>
        <rect x="7" y="7" width="10" height="10" rx="2" />
        <path d="M10 3.75v2.5M14 3.75v2.5M10 17.75v2.5M14 17.75v2.5M3.75 10h2.5M3.75 14h2.5M17.75 10h2.5M17.75 14h2.5" />
        <path d="M9.75 12h1.7l1.05-2.2 1.35 4.4.95-2.2h1.45" />
      </svg>
    );
  }

  if (appKey === 'settings') {
    return (
      <svg {...iconProps}>
        <path d="M12 8.75a3.25 3.25 0 1 1 0 6.5 3.25 3.25 0 0 1 0-6.5Z" />
        <path d="m18.65 13.5 1.85 1.38-1.75 3.03-2.18-.9a7.18 7.18 0 0 1-1.65.95l-.3 2.29h-3.5l-.3-2.29a7.18 7.18 0 0 1-1.65-.95l-2.18.9-1.75-3.03L7.35 13.5a7.55 7.55 0 0 1 0-1.9L5.5 10.12l1.75-3.03 2.18.9c.5-.39 1.05-.7 1.65-.95l.3-2.29h3.5l.3 2.29c.6.25 1.15.56 1.65.95l2.18-.9 1.75 3.03-1.85 1.48c.08.62.08 1.27 0 1.9Z" />
      </svg>
    );
  }

  return (
    <svg {...iconProps}>
      <path d="M6.25 4.25h9l2.5 2.5v13H6.25V4.25Z" />
      <path d="M15 4.5V7h2.5" />
      <ellipse cx="12" cy="10" rx="4" ry="1.7" />
      <path d="M8 10v5.25c0 .94 1.8 1.7 4 1.7s4-.76 4-1.7V10" />
      <path d="M8 12.75c0 .94 1.8 1.7 4 1.7s4-.76 4-1.7" />
    </svg>
  );
}
