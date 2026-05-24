import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import RemoteDesktop from './RemoteDesktopShell';
import appIconUrl from './assets/images/icon.png';
import NavIcon, { type NavIconName } from './components/navigation/NavIcon';
import type { RemoteConnectionInfo } from './components/remote-desktop/types';
import KeysPage from './pages/KeysPage';
import LogsPage from './pages/LogsPage';
import SettingsPage from './pages/SettingsPage';

const hostsStorageKey = 'shelldesk:hosts';
const keysStorageKey = 'shelldesk:keys';
const bookmarkStorageKeyPrefix = 'shelldesk:browser-bookmarks:';
const ungroupedKey = '__ungrouped__';
const defaultRemoteDesktopLayout: ShellDeskRemoteDesktopLayout = {
  sortMode: 'custom',
  items: [
    { id: 'app:files', type: 'app', appKey: 'files' },
    { id: 'app:terminal', type: 'app', appKey: 'terminal' },
    { id: 'app:browser', type: 'app', appKey: 'browser' },
    { id: 'app:settings', type: 'app', appKey: 'settings' },
  ],
};
const defaultAppSettings: ShellDeskAppSettings = {
  language: 'zh-CN',
  interfaceFont: 'LXGW WenKai Mono',
  theme: 'dark',
  accentColor: '#43c7ff',
  defaultHostView: 'grid',
  desktopWallpaperMode: 'default',
  desktopWallpaperDataUrl: '',
  desktopWallpaperName: '',
  remoteDesktopLayout: defaultRemoteDesktopLayout,
  rememberPasswords: true,
  rememberKeyPassphrases: true,
  terminalFontSize: 13,
  terminalFontFamily: 'Cascadia Mono',
  terminalFontWeight: 400,
  terminalFontWeightBold: 700,
  terminalFontLigatures: true,
  terminalLineHeight: 1.2,
  terminalTheme: 'shelldesk-dark',
  terminalCursorBlink: true,
  terminalCursorStyle: 'block',
  terminalCursorInactiveStyle: 'outline',
  terminalScrollback: 10000,
  terminalScrollSensitivity: 1,
  terminalFastScrollSensitivity: 5,
  terminalScrollOnUserInput: true,
  terminalScrollOnEraseInDisplay: true,
  terminalCopyOnSelect: true,
  terminalRightClickPaste: true,
  terminalAltClickMovesCursor: true,
  terminalBracketedPasteMode: true,
  terminalMinimumContrastRatio: 1,
  terminalScreenReaderMode: false,
};

type AppPage = 'hosts' | 'keys' | 'logs' | 'settings';
type HostSystemType =
  | 'unknown'
  | 'windows'
  | 'ubuntu'
  | 'debian'
  | 'redhat'
  | 'centos'
  | 'fedora'
  | 'rocky'
  | 'almalinux'
  | 'oracle'
  | 'amazon'
  | 'arch'
  | 'manjaro'
  | 'alpine'
  | 'opensuse'
  | 'linuxmint'
  | 'kali'
  | 'raspbian'
  | 'gentoo'
  | 'nixos'
  | 'popos'
  | 'elementary'
  | 'linux'
  | 'unix';

const navigationItems: ReadonlyArray<{ page: Exclude<AppPage, 'settings'>; icon: NavIconName; label: string }> = [
  { page: 'hosts', icon: 'hosts', label: '主机' },
  { page: 'keys', icon: 'keys', label: '密钥' },
  { page: 'logs', icon: 'logs', label: '日志' },
];

const hostSystemLabels: Record<HostSystemType, string> = {
  unknown: '未识别系统',
  windows: 'Windows',
  ubuntu: 'Ubuntu',
  debian: 'Debian',
  redhat: 'Red Hat Enterprise Linux',
  centos: 'CentOS',
  fedora: 'Fedora',
  rocky: 'Rocky Linux',
  almalinux: 'AlmaLinux',
  oracle: 'Oracle Linux',
  amazon: 'Amazon Linux',
  arch: 'Arch Linux',
  manjaro: 'Manjaro',
  alpine: 'Alpine Linux',
  opensuse: 'openSUSE / SUSE',
  linuxmint: 'Linux Mint',
  kali: 'Kali Linux',
  raspbian: 'Raspberry Pi OS',
  gentoo: 'Gentoo',
  nixos: 'NixOS',
  popos: 'Pop!_OS',
  elementary: 'elementary OS',
  linux: 'Linux',
  unix: 'Unix',
};

function getHostSystemType(value: unknown, systemName?: unknown): HostSystemType {
  const normalizedValue = typeof value === 'string' ? value.toLowerCase() : '';

  if (normalizedValue in hostSystemLabels) {
    return normalizedValue as HostSystemType;
  }

  if (typeof systemName === 'string' && /windows/i.test(systemName)) {
    return 'windows';
  }

  return 'unknown';
}

function readHexColorChannels(hexColor: string) {
  const match = /^#(?<red>[0-9a-f]{2})(?<green>[0-9a-f]{2})(?<blue>[0-9a-f]{2})$/i.exec(hexColor);

  if (!match?.groups) {
    return { red: 67, green: 199, blue: 255 };
  }

  return {
    red: Number.parseInt(match.groups.red, 16),
    green: Number.parseInt(match.groups.green, 16),
    blue: Number.parseInt(match.groups.blue, 16),
  };
}

function toRgba(hexColor: string, alpha: number) {
  const { red, green, blue } = readHexColorChannels(hexColor);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function getReadableTextColor(hexColor: string) {
  const { red, green, blue } = readHexColorChannels(hexColor);
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;

  return luminance > 0.58 ? '#0b1220' : '#ffffff';
}

function HostGroupIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M4.75 8.35c0-1.28 1.04-2.32 2.32-2.32h3.1l1.48 1.72h5.28c1.28 0 2.32 1.04 2.32 2.32v.8H4.75V8.35Z"
        fill="currentColor"
        opacity="0.2"
      />
      <path
        d="M4.75 10.25h14.5v5.38c0 1.28-1.04 2.32-2.32 2.32H7.07a2.32 2.32 0 0 1-2.32-2.32v-5.38Z"
        fill="currentColor"
        opacity="0.32"
      />
      <path
        d="M4.75 10.25V8.35c0-1.28 1.04-2.32 2.32-2.32h3.1l1.48 1.72h5.28c1.28 0 2.32 1.04 2.32 2.32v5.56c0 1.28-1.04 2.32-2.32 2.32H7.07a2.32 2.32 0 0 1-2.32-2.32v-5.38Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.55"
      />
      <path
        d="M8.25 12.85h4.85M8.25 15.15h2.8"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.55"
      />
      <path d="M15.2 14.95h2.3" stroke="currentColor" strokeLinecap="round" strokeWidth="1.55" />
      <circle cx="16.35" cy="14.95" r="1.15" fill="currentColor" />
    </svg>
  );
}

function HostSystemIcon({ systemName, systemType }: { systemName: string; systemType: HostSystemType }) {
  const effectiveSystemType = systemType === 'unknown' && /windows/i.test(systemName) ? 'windows' : systemType;
  const label = systemName || hostSystemLabels[effectiveSystemType];
  const commonProps = { 'aria-hidden': true, focusable: false };
  const icon = (() => {
    switch (effectiveSystemType) {
      case 'windows':
        return (
          <svg viewBox="0 0 64 64" {...commonProps}>
            <path d="M13 17.5 30 15v16H13V17.5ZM34 14.4 51 12v19H34V14.4ZM13 35h17v16l-17-2.5V35ZM34 35h17v17l-17-2.4V35Z" fill="currentColor" />
          </svg>
        );
      case 'ubuntu':
        return (
          <svg viewBox="0 0 64 64" {...commonProps}>
            <circle cx="32" cy="32" r="22" fill="currentColor" opacity="0.14" />
            <circle cx="32" cy="32" r="13" fill="none" stroke="currentColor" strokeWidth="5.5" />
            <circle cx="50" cy="24" r="6.5" fill="currentColor" />
            <circle cx="26" cy="51" r="6.5" fill="currentColor" />
            <circle cx="18" cy="21" r="6.5" fill="currentColor" />
            <path d="M43.3 25.7 38.9 29M28.6 43.8l1.4-5.1M23.6 25.5l4.9 3.4" stroke="currentColor" strokeWidth="5.5" strokeLinecap="round" />
          </svg>
        );
      case 'debian':
        return (
          <svg viewBox="0 0 64 64" {...commonProps}>
            <path
              d="M43.4 18.3c-5.9-5.1-17.2-3.6-23.1 3.3-6.5 7.6-4.8 19.5 4 24.6 7.5 4.4 18.4 2.5 22.7-4.8 3.6-6.1.3-13.3-6.4-14.1-5.7-.7-10.1 3.7-9 7.4.6 2 2.8 2.9 4.9 2.2"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="5.6"
            />
            <path d="M42.7 18.1c3.3 3.2 4.4 7.2 3.2 10.2" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="4" opacity="0.52" />
          </svg>
        );
      case 'redhat':
        return (
          <svg viewBox="0 0 64 64" {...commonProps}>
            <path d="M15 36.5c5.9 4.2 27.9 4.2 34 0l-3.5-10.6c-.7-2.1-2.5-3.4-4.7-3.4H23.2c-2.2 0-4 1.3-4.7 3.4L15 36.5Z" fill="currentColor" />
            <path d="M11.5 38.8c3.4 7 37.8 7 41 0-5.7 3.5-35.2 3.5-41 0Z" fill="currentColor" opacity="0.72" />
            <path d="M24.5 25.8h15l2.3 7c-5.7 1.6-14 1.6-19.7 0l2.4-7Z" fill="#111820" opacity="0.62" />
          </svg>
        );
      case 'centos':
        return (
          <svg viewBox="0 0 64 64" {...commonProps}>
            <path d="M32 13v38M13 32h38M19.5 19.5l25 25M44.5 19.5l-25 25" stroke="currentColor" strokeWidth="4.8" strokeLinecap="round" />
            <rect x="24" y="24" width="16" height="16" rx="3" fill="currentColor" />
            <path d="M32 14 38 20 32 26 26 20 32 14ZM32 38l6 6-6 6-6-6 6-6ZM14 32l6-6 6 6-6 6-6-6ZM38 32l6-6 6 6-6 6-6-6Z" fill="currentColor" opacity="0.72" />
          </svg>
        );
      case 'fedora':
        return (
          <svg viewBox="0 0 64 64" {...commonProps}>
            <path d="M33 12c-11.6 0-21 9.4-21 21 0 10.5 7.7 19 18 20.7V41h-5.4c-5.1 0-9.3-4.1-9.3-9.2s4.2-9.2 9.3-9.2H30v-2.1c0-4.7 3.8-8.5 8.5-8.5H33Z" fill="currentColor" opacity="0.95" />
            <path d="M30 22.6h8.2c4.9 0 8.8 4 8.8 8.9s-3.9 8.9-8.8 8.9H36v12.8C45.4 50.7 52 42.4 52 33c0-9.9-7.2-18.1-16.7-19.7A5.8 5.8 0 0 0 30 19v3.6Zm0 8.2h-5.4a1 1 0 1 0 0 2H30v-2Zm6 2h2.2a1.3 1.3 0 1 0 0-2.6H36v2.6Z" fill="#111820" opacity="0.62" />
          </svg>
        );
      case 'rocky':
        return (
          <svg viewBox="0 0 64 64" {...commonProps}>
            <path d="M12 45.5 27.8 17 36 31.2l5.4-9.4L54 45.5H12Z" fill="currentColor" />
            <path d="M22 45.5 36 31.2l7.9 14.3H22Z" fill="#111820" opacity="0.35" />
            <path d="M27.8 17 18 34.7l13.7-8.8L27.8 17Z" fill="#ffffff" opacity="0.22" />
          </svg>
        );
      case 'almalinux':
        return (
          <svg viewBox="0 0 64 64" {...commonProps}>
            <circle cx="32" cy="32" r="11" fill="currentColor" />
            <circle cx="20" cy="20" r="7" fill="currentColor" opacity="0.78" />
            <circle cx="45" cy="19" r="6.5" fill="currentColor" opacity="0.65" />
            <circle cx="47" cy="44" r="7" fill="currentColor" opacity="0.82" />
            <circle cx="19" cy="44" r="6" fill="currentColor" opacity="0.58" />
            <path d="M25.1 25.1 21.8 21.8M39.5 24.8l4.1-4.1M39.3 39.2l4.6 4.6M24.9 39.1l-4 4" stroke="currentColor" strokeWidth="4" strokeLinecap="round" opacity="0.52" />
          </svg>
        );
      case 'oracle':
        return (
          <svg viewBox="0 0 64 64" {...commonProps}>
            <rect x="13" y="23" width="38" height="18" rx="9" fill="none" stroke="currentColor" strokeWidth="6" />
            <path d="M23 32h18" stroke="currentColor" strokeLinecap="round" strokeWidth="5" opacity="0.5" />
          </svg>
        );
      case 'amazon':
        return (
          <svg viewBox="0 0 64 64" {...commonProps}>
            <path d="M17 23c5.3-5.1 12.2-7.1 20.5-5.8 3.9.6 7.1 2 9.8 4.1" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="5.2" />
            <path d="M17.5 40.5c9 7.4 20 7.3 29-.3" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="5.2" />
            <path d="M40 40.7h8.4v8.1" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="4.6" />
          </svg>
        );
      case 'arch':
        return (
          <svg viewBox="0 0 64 64" {...commonProps}>
            <path d="M32 10 14 52c8.5-5.2 16.8-7.3 25-6.4l-7-17.2 9.7 15.9c3.2 1.1 6.1 2.8 8.8 5.1L32 10Z" fill="currentColor" />
            <path d="M32 10 26 31.2h12L32 10Z" fill="#ffffff" opacity="0.22" />
          </svg>
        );
      case 'manjaro':
        return (
          <svg viewBox="0 0 64 64" {...commonProps}>
            <path d="M15 15h34v34H38V25H27v24H15V15Z" fill="currentColor" />
            <path d="M30 25h8v24h-8V25Z" fill="#111820" opacity="0.54" />
          </svg>
        );
      case 'alpine':
        return (
          <svg viewBox="0 0 64 64" {...commonProps}>
            <path d="M10 48 27 18l7.6 13.2L40 22l14 26H10Z" fill="currentColor" />
            <path d="M27 18 19.2 31.7 29.5 27l-2.5-9ZM34.6 31.2 24 48h20.5L34.6 31.2Z" fill="#ffffff" opacity="0.2" />
          </svg>
        );
      case 'opensuse':
        return (
          <svg viewBox="0 0 64 64" {...commonProps}>
            <path d="M16 35c2.7-10 11.3-16.2 22.1-15.1 6.8.7 11.8 4.2 14.4 9.1-3.5-1.5-7.8-1.6-12.8-.1-5.3 1.6-9.5 4.7-12.5 9.3" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="5.4" />
            <circle cx="42" cy="31.5" r="4.4" fill="currentColor" />
            <path d="M18 41c6 5.4 17 6 25.5.3" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="4.8" opacity="0.68" />
          </svg>
        );
      case 'linuxmint':
        return (
          <svg viewBox="0 0 64 64" {...commonProps}>
            <path d="M18 19h10v18c0 4.4 3.6 8 8 8s8-3.6 8-8V25h-7v12c0 .6-.4 1-1 1s-1-.4-1-1V19h11c4.4 0 8 3.6 8 8v11c0 8.8-7.2 16-16 16H26c-8.8 0-16-7.2-16-16V27c0-4.4 3.6-8 8-8Z" fill="currentColor" />
            <path d="M18 19v18c0 4.4 3.6 8 8 8h7" fill="none" stroke="#111820" strokeLinecap="round" strokeWidth="5" opacity="0.38" />
          </svg>
        );
      case 'kali':
        return (
          <svg viewBox="0 0 64 64" {...commonProps}>
            <path d="M12 39c12.5-11.8 26.8-17.9 43-18.5-4.3 3.6-7.8 7.7-10.5 12.5 4.8.4 8.2 1.6 10.3 3.8-9.2.2-16.4 2.2-21.7 6.1-4.3 3.2-9.4 4.5-15.1 4l9.4-7.4C22 38.8 16.9 38.6 12 39Z" fill="currentColor" />
            <path d="M33 28.4c-4.8 2.5-9.2 5.4-13.3 8.8" stroke="#111820" strokeLinecap="round" strokeWidth="3.8" opacity="0.34" />
          </svg>
        );
      case 'raspbian':
        return (
          <svg viewBox="0 0 64 64" {...commonProps}>
            <path d="M32 17c2.2-4.3 6.6-6.2 12.8-5.5-1.1 5.3-4.8 8.4-11.1 9.4" fill="currentColor" opacity="0.65" />
            <circle cx="25" cy="31" r="8" fill="currentColor" />
            <circle cx="39" cy="31" r="8" fill="currentColor" />
            <circle cx="32" cy="42" r="8" fill="currentColor" />
            <circle cx="23" cy="43" r="6.3" fill="currentColor" opacity="0.8" />
            <circle cx="41" cy="43" r="6.3" fill="currentColor" opacity="0.8" />
          </svg>
        );
      case 'gentoo':
        return (
          <svg viewBox="0 0 64 64" {...commonProps}>
            <path d="M20 18c9.5-5.8 26.4 1.5 28.9 13.2 2.2 10.2-9.2 18.3-22.1 17.5-8.7-.6-14.1-4.5-13.8-10.2.3-5.3 5.7-8.2 13.8-7.4 4.9.5 8.2-.5 9.8-2.9-4.9-4.8-10.3-8.2-16.6-10.2Z" fill="currentColor" />
            <path d="M26.4 31.1c5 .5 8.4-.5 10.2-2.9" fill="none" stroke="#111820" strokeLinecap="round" strokeWidth="4.5" opacity="0.34" />
          </svg>
        );
      case 'nixos':
        return (
          <svg viewBox="0 0 64 64" {...commonProps}>
            <path d="M32 11v42M14 21.5l36 21M14 42.5l36-21" stroke="currentColor" strokeLinecap="round" strokeWidth="5" />
            <path d="M24 16.5 32 21l8-4.5M24 47.5 32 43l8 4.5M16 32h10M38 32h10" stroke="currentColor" strokeLinecap="round" strokeWidth="4" opacity="0.58" />
          </svg>
        );
      case 'popos':
        return (
          <svg viewBox="0 0 64 64" {...commonProps}>
            <path d="M32 12 37.6 25 52 26.3 41.1 35.9 44.4 50 32 42.6 19.6 50l3.3-14.1L12 26.3 26.4 25 32 12Z" fill="currentColor" />
            <circle cx="32" cy="32" r="7.2" fill="#111820" opacity="0.42" />
          </svg>
        );
      case 'elementary':
        return (
          <svg viewBox="0 0 64 64" {...commonProps}>
            <circle cx="32" cy="32" r="21" fill="none" stroke="currentColor" strokeWidth="5.2" />
            <path d="M20 35c2.6 5.1 7 7.5 13.2 7.3 5.1-.2 9.1-2.1 12-5.6M19.5 29c3.1-5.8 7.5-8.4 13.2-7.9 5.8.5 9.8 3.8 12 9.9H22" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="4.5" />
          </svg>
        );
      case 'linux':
        return (
          <svg viewBox="0 0 64 64" {...commonProps}>
            <ellipse cx="32" cy="32" rx="15" ry="21" fill="#12161d" />
            <ellipse cx="32" cy="38" rx="10" ry="13" fill="#f4f7fb" />
            <circle cx="26.5" cy="24" r="2.3" fill="#f4f7fb" />
            <circle cx="37.5" cy="24" r="2.3" fill="#f4f7fb" />
            <path d="M28 30.5h8L32 35l-4-4.5Z" fill="#f5ad31" />
            <path d="M20 51c2.9-3.2 8.4-3.2 11 0H20ZM33 51c2.9-3.2 8.4-3.2 11 0H33Z" fill="#f5ad31" />
          </svg>
        );
      case 'unix':
        return (
          <svg viewBox="0 0 64 64" {...commonProps}>
            <path d="M18 42.5c4.9-9.5 9.5-17.3 14-23.2 4.6 5.9 9.2 13.7 14 23.2" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="5.5" />
            <path d="M22 38h20M27 29h10" stroke="currentColor" strokeLinecap="round" strokeWidth="5.5" opacity="0.62" />
          </svg>
        );
      default:
        return (
          <svg viewBox="0 0 64 64" {...commonProps}>
            <rect x="14" y="18" width="36" height="25" rx="6" fill="none" stroke="currentColor" strokeWidth="4.4" />
            <path d="m23 27 6 5-6 5M32 38h10" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="4.4" />
            <path d="M24 49h16" stroke="currentColor" strokeLinecap="round" strokeWidth="4.4" opacity="0.55" />
          </svg>
        );
    }
  })();

  return (
    <span className={`host-avatar host-system-icon host-system-${effectiveSystemType}`} title={label} aria-label={label}>
      {icon}
    </span>
  );
}

interface SshKey {
  id: string;
  name: string;
  source: 'imported' | 'generated';
  algorithm: string;
  fingerprint: string;
  publicKey: string;
  passphrase: string;
  createdAt: string;
  updatedAt: string;
}

interface LegacyStoredKey {
  id: string;
  name: string;
  keyPath: string;
  passphrase: string;
  createdAt: string;
  updatedAt: string;
}

interface KeyFormState {
  name: string;
  privateKeyPath: string;
  publicKeyPath: string;
  passphrase: string;
  modulusLength: '2048' | '3072' | '4096';
}

const emptyKeyForm: KeyFormState = {
  name: '',
  privateKeyPath: '',
  publicKeyPath: '',
  passphrase: '',
  modulusLength: '4096',
};

const keyPathSeparators = /[\\/]+/;

function getKeyNameFromPath(keyPath: string) {
  const fileName = keyPath.split(keyPathSeparators).filter(Boolean).pop() ?? 'SSH Key';
  return fileName.replace(/\.(pem|key|ppk|openssh)$/i, '') || fileName;
}

function isStoredSshKey(value: unknown): value is SshKey {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const key = value as Partial<SshKey>;
  return (
    typeof key.id === 'string' &&
    typeof key.name === 'string' &&
    (key.source === 'imported' || key.source === 'generated') &&
    typeof key.algorithm === 'string' &&
    typeof key.fingerprint === 'string' &&
    typeof key.publicKey === 'string' &&
    typeof key.passphrase === 'string' &&
    typeof key.createdAt === 'string' &&
    typeof key.updatedAt === 'string'
  );
}

function isLegacyStoredSshKey(value: unknown): value is LegacyStoredKey {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const key = value as Partial<LegacyStoredKey>;
  return (
    typeof key.id === 'string' &&
    typeof key.name === 'string' &&
    typeof key.keyPath === 'string' &&
    typeof key.passphrase === 'string' &&
    typeof key.createdAt === 'string' &&
    typeof key.updatedAt === 'string'
  );
}

function readStoredSshKeys(): LegacyStoredKey[] {
  try {
    const rawKeys = window.localStorage.getItem(keysStorageKey);

    if (!rawKeys) {
      return [];
    }

    const parsedKeys: unknown = JSON.parse(rawKeys);

    if (!Array.isArray(parsedKeys)) {
      return [];
    }

    return parsedKeys.filter(isLegacyStoredSshKey);
  } catch {
    return [];
  }
}

type KeyEditorMode = 'import' | 'generate' | 'edit';

function validateKeyForm(form: KeyFormState, mode: KeyEditorMode) {
  const name = form.name.trim();

  if (!name) {
    return '请输入密钥名称。';
  }

  if (name.length > 80 || form.passphrase.length > 4096) {
    return '密钥信息长度超出限制。';
  }

  if (mode === 'import') {
    if (!form.privateKeyPath.trim()) {
      return '请选择私钥文件。';
    }

    if (form.privateKeyPath.trim().length > 1024 || form.publicKeyPath.trim().length > 1024) {
      return '密钥文件路径过长。';
    }
  }

  if (mode === 'generate' && !['2048', '3072', '4096'].includes(form.modulusLength)) {
    return 'RSA 位数无效。';
  }

  return '';
}

function updateSshKeyFromForm(key: SshKey, form: KeyFormState): SshKey {
  return {
    ...key,
    name: form.name.trim(),
    passphrase: form.passphrase,
    updatedAt: new Date().toISOString(),
  };
}

function toKeyFormState(key: SshKey): KeyFormState {
  return {
    name: key.name,
    privateKeyPath: '',
    publicKeyPath: '',
    passphrase: key.passphrase,
    modulusLength: '4096',
  };
}

type AuthMethod = 'password' | 'key';
type ConnectionAuthMethod = AuthMethod | 'agent';

interface Host {
  id: string;
  name: string;
  address: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  password: string;
  keyId: string;
  keyPath: string;
  passphrase: string;
  systemType: HostSystemType;
  systemName: string;
  group: string;
  tags: string[];
  note: string;
  createdAt: string;
  updatedAt: string;
}

interface ConnectionHost extends Omit<Host, 'authMethod'> {
  authMethod: ConnectionAuthMethod;
}

interface ConnectionErrorNotice {
  hostName: string;
  endpoint: string;
  message: string;
}

type StoredHost = Omit<Host, 'authMethod' | 'password' | 'keyId' | 'keyPath' | 'passphrase' | 'systemType' | 'systemName'> &
  Partial<Pick<Host, 'authMethod' | 'password' | 'keyId' | 'keyPath' | 'passphrase' | 'systemType' | 'systemName'>>;

interface HostFormState {
  name: string;
  address: string;
  port: string;
  username: string;
  authMethod: AuthMethod;
  password: string;
  keyId: string;
  keyPath: string;
  passphrase: string;
  group: string;
  tags: string;
  note: string;
}

interface HostGroup {
  key: string;
  name: string;
  count: number;
}

type DeleteConfirmationRequest =
  | { kind: 'host'; host: Host }
  | { kind: 'ssh-key'; key: SshKey; relatedHostCount: number };

type ViewMode = 'grid' | 'list';

interface ConnectionClosedPayload {
  connectionId: string;
  reason?: string;
}

export type LogCategory = 'connection' | 'host' | 'key' | 'config' | 'system';
export type LogLevel = 'info' | 'success' | 'warning' | 'error';

export interface LogEntry {
  id: string;
  timestamp: string;
  category: LogCategory;
  level: LogLevel;
  message: string;
  detail: string;
}

interface CredentialFormState {
  authMethod: AuthMethod;
  password: string;
  keyId: string;
  passphrase: string;
  saveCredential: boolean;
}

const emptyHostForm: HostFormState = {
  name: '',
  address: '',
  port: '22',
  username: '',
  authMethod: 'password',
  password: '',
  keyId: '',
  keyPath: '',
  passphrase: '',
  group: '',
  tags: '',
  note: '',
};

const emptyCredentialForm: CredentialFormState = {
  authMethod: 'password',
  password: '',
  keyId: '',
  passphrase: '',
  saveCredential: true,
};

function createId() {
  if ('randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
  }

  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }

  return '操作失败。';
}

function isAuthFailureMessage(message: string) {
  return /认证失败|authentication methods failed|password|private key|passphrase|密钥|口令/i.test(message);
}

function parseTags(value: string) {
  return value
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function formatTags(tags: string[]) {
  return tags.join(', ');
}

function getAuthMethod(value: unknown): AuthMethod {
  return value === 'key' ? 'key' : 'password';
}

function getAuthLabel(host: Pick<Host, 'authMethod' | 'password'>, key: SshKey | null) {
  if (host.authMethod === 'key') {
    if (!key) {
      return '密钥登录';
    }

    return key.passphrase ? `密钥 · ${key.name} · 口令已保存` : `密钥 · ${key.name}`;
  }

  return host.password ? '密码登录 · 已保存' : '密码登录';
}

function getHostSystemLabel(host: Pick<Host, 'systemName' | 'systemType'>) {
  return host.systemName || hostSystemLabels[host.systemType];
}

function isStoredHost(value: unknown): value is StoredHost {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const host = value as Partial<StoredHost>;
  return (
    typeof host.id === 'string' &&
    typeof host.name === 'string' &&
    typeof host.address === 'string' &&
    typeof host.port === 'number' &&
    Number.isInteger(host.port) &&
    typeof host.username === 'string' &&
    typeof host.group === 'string' &&
    Array.isArray(host.tags) &&
    host.tags.every((tag) => typeof tag === 'string') &&
    typeof host.note === 'string' &&
    typeof host.createdAt === 'string' &&
    typeof host.updatedAt === 'string'
  );
}

function normalizeStoredHost(host: StoredHost): Host {
  return {
    ...host,
    authMethod: getAuthMethod(host.authMethod),
    password: typeof host.password === 'string' ? host.password : '',
    keyId: typeof host.keyId === 'string' ? host.keyId : '',
    keyPath: typeof host.keyPath === 'string' ? host.keyPath : '',
    passphrase: typeof host.passphrase === 'string' ? host.passphrase : '',
    systemType: getHostSystemType(host.systemType, host.systemName),
    systemName: typeof host.systemName === 'string' ? host.systemName : '',
  };
}

function readStoredHosts(): Host[] {
  try {
    const rawHosts = window.localStorage.getItem(hostsStorageKey);

    if (!rawHosts) {
      return [];
    }

    const parsedHosts: unknown = JSON.parse(rawHosts);

    if (!Array.isArray(parsedHosts)) {
      return [];
    }

    return parsedHosts.filter(isStoredHost).map(normalizeStoredHost);
  } catch {
    return [];
  }
}

function readLegacyBookmarkCollections(): ShellDeskBrowserBookmarkCollection[] {
  try {
    return Object.keys(window.localStorage)
      .filter((key) => key.startsWith(bookmarkStorageKeyPrefix))
      .map((storageKey) => {
        const rawValue = window.localStorage.getItem(storageKey);

        if (!rawValue) {
          return null;
        }

        const parsedValue: unknown = JSON.parse(rawValue);

        if (!Array.isArray(parsedValue)) {
          return null;
        }

        const bookmarks = parsedValue.filter((bookmark): bookmark is ShellDeskBrowserBookmark => {
          if (!bookmark || typeof bookmark !== 'object') {
            return false;
          }

          const value = bookmark as Partial<ShellDeskBrowserBookmark>;
          return (
            typeof value.id === 'string' &&
            typeof value.title === 'string' &&
            typeof value.url === 'string' &&
            typeof value.createdAt === 'string' &&
            typeof value.updatedAt === 'string'
          );
        });

        return {
          scope: storageKey.slice(bookmarkStorageKeyPrefix.length),
          bookmarks,
          updatedAt: new Date().toISOString(),
        };
      })
      .filter((collection): collection is ShellDeskBrowserBookmarkCollection => Boolean(collection));
  } catch {
    return [];
  }
}

function shouldTryLegacyMigration(snapshot: ShellDeskVaultSnapshot) {
  return !snapshot.hosts.length && !snapshot.sshKeys.length && !snapshot.browserBookmarks.length;
}

function readLegacyVaultPayload() {
  return {
    hosts: readStoredHosts(),
    sshKeys: readStoredSshKeys() as unknown as ShellDeskStoredKeyRecord[],
    settings: defaultAppSettings,
    browserBookmarks: readLegacyBookmarkCollections(),
  };
}

function hasLegacyCollections(payload: ReturnType<typeof readLegacyVaultPayload>) {
  return Boolean(payload.hosts.length || payload.sshKeys.length || payload.browserBookmarks.length);
}

function clearLegacyLocalStorage() {
  try {
    window.localStorage.removeItem(hostsStorageKey);
    window.localStorage.removeItem(keysStorageKey);

    for (const storageKey of Object.keys(window.localStorage)) {
      if (storageKey.startsWith(bookmarkStorageKeyPrefix)) {
        window.localStorage.removeItem(storageKey);
      }
    }
  } catch {
    // Legacy cleanup is best-effort only.
  }
}

function validateHostForm(form: HostFormState, keys: SshKey[]) {
  const port = Number(form.port);
  const selectedKey = keys.find((key) => key.id === form.keyId);

  if (!form.name.trim()) {
    return '请输入主机名称。';
  }

  if (!form.address.trim()) {
    return '请输入主机地址。';
  }

  if (!form.username.trim()) {
    return '请输入用户名。';
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return '端口必须是 1 到 65535 之间的整数。';
  }

  if (form.name.trim().length > 80) {
    return '主机名称不能超过 80 个字符。';
  }

  if (form.address.trim().length > 255) {
    return '主机地址不能超过 255 个字符。';
  }

  if (form.username.trim().length > 128) {
    return '用户名不能超过 128 个字符。';
  }

  if (form.authMethod === 'key' && !selectedKey) {
    return '选择密钥登录时需要选择已有密钥。';
  }

  if (form.password.length > 4096) {
    return '密码长度不能超过 4096 个字符。';
  }

  return '';
}

function createHostFromForm(form: HostFormState, selectedKey: SshKey | null): Host {
  const now = new Date().toISOString();

  return {
    id: createId(),
    name: form.name.trim(),
    address: form.address.trim(),
    port: Number(form.port),
    username: form.username.trim(),
    authMethod: form.authMethod,
    password: form.authMethod === 'password' ? form.password : '',
    keyId: form.authMethod === 'key' ? selectedKey?.id ?? '' : '',
    keyPath: '',
    passphrase: '',
    systemType: 'unknown',
    systemName: '',
    group: form.group.trim(),
    tags: parseTags(form.tags),
    note: form.note.trim(),
    createdAt: now,
    updatedAt: now,
  };
}

function updateHostFromForm(host: Host, form: HostFormState, selectedKey: SshKey | null): Host {
  const endpointChanged =
    host.address !== form.address.trim() ||
    host.port !== Number(form.port) ||
    host.username !== form.username.trim();

  return {
    ...host,
    name: form.name.trim(),
    address: form.address.trim(),
    port: Number(form.port),
    username: form.username.trim(),
    authMethod: form.authMethod,
    password: form.authMethod === 'password' ? form.password : '',
    keyId: form.authMethod === 'key' ? selectedKey?.id ?? '' : '',
    keyPath: '',
    passphrase: '',
    systemType: endpointChanged ? 'unknown' : host.systemType,
    systemName: endpointChanged ? '' : host.systemName,
    group: form.group.trim(),
    tags: parseTags(form.tags),
    note: form.note.trim(),
    updatedAt: new Date().toISOString(),
  };
}

function toFormState(host: Host): HostFormState {
  return {
    name: host.name,
    address: host.address,
    port: String(host.port),
    username: host.username,
    authMethod: host.authMethod,
    password: host.password,
    keyId: host.keyId,
    keyPath: host.keyPath,
    passphrase: host.passphrase,
    group: host.group,
    tags: formatTags(host.tags),
    note: host.note,
  };
}

function getHostGroupKey(host: Host) {
  return host.group || ungroupedKey;
}

function readWindowConnectionId() {
  return new URLSearchParams(window.location.search).get('connectionId')?.trim() ?? '';
}

function tokenizeQuickConnectInput(value: string) {
  return Array.from(value.matchAll(/"([^"]*)"|'([^']*)'|[^\s]+/g), (match) => match[1] ?? match[2] ?? match[0]);
}

function isValidQuickConnectPort(value: string) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function parseQuickConnectDestination(value: string) {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return null;
  }

  const atIndex = trimmedValue.lastIndexOf('@');
  const userPart = atIndex >= 0 ? trimmedValue.slice(0, atIndex).trim() : '';
  const hostPart = atIndex >= 0 ? trimmedValue.slice(atIndex + 1).trim() : trimmedValue;
  const lastColonIndex = hostPart.lastIndexOf(':');
  const hasPortSuffix = lastColonIndex > 0 && hostPart.indexOf(']') === -1;
  const address = hasPortSuffix ? hostPart.slice(0, lastColonIndex).trim() : hostPart.trim();
  const portText = hasPortSuffix ? hostPart.slice(lastColonIndex + 1).trim() : '';

  if (!userPart || !address) {
    return null;
  }

  if (portText && !isValidQuickConnectPort(portText)) {
    return null;
  }

  return {
    username: userPart,
    address,
    port: portText ? Number(portText) : 22,
    keyPath: '',
  };
}

function parseQuickConnectCommand(value: string) {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return null;
  }

  if (!trimmedValue.startsWith('ssh ')) {
    return parseQuickConnectDestination(trimmedValue);
  }

  const tokens = tokenizeQuickConnectInput(trimmedValue);

  if (!tokens.length || tokens[0] !== 'ssh') {
    return null;
  }

  let username = '';
  let address = '';
  let port = 22;
  let keyPath = '';

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token === '-p' || token === '-l' || token === '-i') {
      const nextToken = tokens[index + 1];

      if (!nextToken) {
        return null;
      }

      if (token === '-p') {
        if (!isValidQuickConnectPort(nextToken)) {
          return null;
        }

        port = Number(nextToken);
      } else if (token === '-l') {
        username = nextToken.trim();
      } else {
        keyPath = nextToken.trim();
      }

      index += 1;
      continue;
    }

    if (token.startsWith('-p') && token.length > 2) {
      const inlinePort = token.slice(2);

      if (!isValidQuickConnectPort(inlinePort)) {
        return null;
      }

      port = Number(inlinePort);
      continue;
    }

    if (token.startsWith('-l') && token.length > 2) {
      username = token.slice(2).trim();
      continue;
    }

    if (token.startsWith('-i') && token.length > 2) {
      keyPath = token.slice(2).trim();
      continue;
    }

    if (token.startsWith('-')) {
      return null;
    }

    if (address) {
      return null;
    }

    const destination = parseQuickConnectDestination(username ? `${username}@${token}` : token);

    if (!destination) {
      return null;
    }

    username = destination.username;
    address = destination.address;

    if (destination.port !== 22) {
      port = destination.port;
    }
  }

  if (!username || !address) {
    return null;
  }

  return {
    username,
    address,
    port,
    keyPath,
  };
}

function App() {
  const initialPublicSnapshotRef = useRef<ShellDeskVaultSnapshot | null>(window.guiSSH?.vault?.initialPublicSnapshot ?? null);
  const initialPublicSnapshot = initialPublicSnapshotRef.current;
  const [hosts, setHosts] = useState<Host[]>(() => (
    initialPublicSnapshot
      ? initialPublicSnapshot.hosts.filter(isStoredHost).map(normalizeStoredHost)
      : (window.guiSSH?.vault ? [] : readStoredHosts())
  ));
  const [sshKeys, setSshKeys] = useState<SshKey[]>(() => (
    initialPublicSnapshot ? initialPublicSnapshot.sshKeys.filter(isStoredSshKey) : []
  ));
  const [form, setForm] = useState<HostFormState>(emptyHostForm);
  const [keyForm, setKeyForm] = useState<KeyFormState>(emptyKeyForm);
  const [editingHostId, setEditingHostId] = useState<string | null>(null);
  const [editingKeyId, setEditingKeyId] = useState<string | null>(null);
  const [keyEditorMode, setKeyEditorMode] = useState<KeyEditorMode>('import');
  const [activePage, setActivePage] = useState<AppPage>('hosts');
  const [searchQuery, setSearchQuery] = useState('');
  const [keySearchQuery, setKeySearchQuery] = useState('');
  const [activeGroupKey, setActiveGroupKey] = useState<string | null>(null);
  const [formError, setFormError] = useState('');
  const [keyFormError, setKeyFormError] = useState('');
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [isKeyEditorOpen, setIsKeyEditorOpen] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>(initialPublicSnapshot?.settings.defaultHostView ?? defaultAppSettings.defaultHostView);
  const [settings, setSettings] = useState<ShellDeskAppSettings>(initialPublicSnapshot?.settings ?? defaultAppSettings);
  const [storageInfo, setStorageInfo] = useState<ShellDeskStorageInfo | null>(initialPublicSnapshot?.storage ?? null);
  const [bookmarkCount, setBookmarkCount] = useState(() => (
    initialPublicSnapshot?.browserBookmarks.reduce((total, collection) => total + collection.bookmarks.length, 0) ?? 0
  ));
  const [isVaultReady, setIsVaultReady] = useState(Boolean(initialPublicSnapshot) || !window.guiSSH?.vault);
  const [isVaultHydrated, setIsVaultHydrated] = useState(!window.guiSSH?.vault);
  const [isLogsReady, setIsLogsReady] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [connection, setConnection] = useState<RemoteConnectionInfo | null>(null);
  const [windowConnectionId] = useState(readWindowConnectionId);
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);
  const [windowConnectionError, setWindowConnectionError] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectionErrorNotice, setConnectionErrorNotice] = useState<ConnectionErrorNotice | null>(null);
  const [credentialHost, setCredentialHost] = useState<ConnectionHost | null>(null);
  const [credentialForm, setCredentialForm] = useState<CredentialFormState>(emptyCredentialForm);
  const [credentialError, setCredentialError] = useState('');
  const [isConfigTransferPending, setIsConfigTransferPending] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState<DeleteConfirmationRequest | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const lastPersistedCollectionsRef = useRef('');
  const lastPersistedLogsRef = useRef('');
  const platform = window.guiSSH?.platform;
  const windowControls = window.guiSSH?.window;
  const vaultControls = window.guiSSH?.vault;
  const showWindowControls = Boolean(windowControls) && platform !== 'darwin';
  const isConnectionWindow = Boolean(windowConnectionId);
  const titlebarConnectionAddress = connection
    ? `${connection.host.username}@${connection.host.address}:${connection.host.port}`
    : '';
  const editingHost = hosts.find((host) => host.id === editingHostId) ?? null;
  const editingKey = sshKeys.find((key) => key.id === editingKeyId) ?? null;
  const sshKeyById = useMemo(() => new Map(sshKeys.map((key) => [key.id, key])), [sshKeys]);

  const hostGroups = useMemo<HostGroup[]>(() => {
    const groups = new Map<string, HostGroup>();

    for (const host of hosts) {
      const key = getHostGroupKey(host);
      const name = host.group || '未分组';
      const currentGroup = groups.get(key);

      groups.set(key, {
        key,
        name,
        count: (currentGroup?.count ?? 0) + 1,
      });
    }

    return Array.from(groups.values()).sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
  }, [hosts]);

  const filteredHosts = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    return hosts.filter((host) => {
      const hostKey = sshKeyById.get(host.keyId) ?? null;
      const matchesGroup = !activeGroupKey || getHostGroupKey(host) === activeGroupKey;
      const matchesQuery =
        !query ||
        [
          host.name,
          host.address,
          host.username,
          host.group,
          host.note,
          host.systemName,
          hostSystemLabels[host.systemType],
          hostKey?.name,
          hostKey?.fingerprint,
          hostKey?.algorithm,
          getAuthLabel(host, hostKey),
          ...host.tags,
        ]
          .join(' ')
          .toLowerCase()
          .includes(query);

      return matchesGroup && matchesQuery;
    });
  }, [activeGroupKey, hosts, searchQuery, sshKeyById]);

  const filteredKeys = useMemo(() => {
    const query = keySearchQuery.trim().toLowerCase();

    return sshKeys.filter((key) => {
      if (!query) {
        return true;
      }

      return [key.name, key.algorithm, key.fingerprint].join(' ').toLowerCase().includes(query);
    });
  }, [keySearchQuery, sshKeys]);

  const activeGroupName = hostGroups.find((group) => group.key === activeGroupKey)?.name;

  const getSelectedSshKey = (host: Pick<Host, 'keyId'>) => sshKeyById.get(host.keyId) ?? null;

  const applyVaultSnapshot = (snapshot: ShellDeskVaultSnapshot, options: { updateCollections?: boolean; hydrated?: boolean } = {}) => {
    const { updateCollections = true, hydrated = true } = options;

    if (updateCollections) {
      const nextHosts = snapshot.hosts.filter(isStoredHost).map(normalizeStoredHost);
      const nextKeys = snapshot.sshKeys.filter(isStoredSshKey);

      setHosts(nextHosts);
      setSshKeys(nextKeys);

      if (hydrated) {
        lastPersistedCollectionsRef.current = JSON.stringify({
          hosts: nextHosts,
          sshKeys: nextKeys,
          settings: snapshot.settings,
        });
      }
    }

    setSettings(snapshot.settings);
    setStorageInfo(snapshot.storage);
    setBookmarkCount(snapshot.browserBookmarks.reduce((total: number, collection: ShellDeskBrowserBookmarkCollection) => total + collection.bookmarks.length, 0));
    setViewMode(snapshot.settings.defaultHostView);
    setIsVaultReady(true);

    if (hydrated) {
      setIsVaultHydrated(true);
    }
  };

  const refreshHosts = async () => {
    if (!vaultControls) {
      const nextHosts = readStoredHosts();
      setHosts(nextHosts);
      setStatusMessage(`已刷新 ${nextHosts.length} 台主机。`);
      return;
    }

    try {
      const snapshot = await vaultControls.getSnapshot();
      applyVaultSnapshot(snapshot);
      setStatusMessage(`已刷新 ${snapshot.hosts.length} 台主机。`);
    } catch (error) {
      setStatusMessage(`刷新主机列表失败：${getErrorMessage(error)}`);
    }
  };

  useEffect(() => {
    if (!windowConnectionId) {
      return;
    }

    if (!window.guiSSH?.connections) {
      setWindowConnectionError('当前运行环境不支持连接窗口。');
      return;
    }

    let disposed = false;

    window.guiSSH.connections
      .getInfo(windowConnectionId)
      .then((nextConnection) => {
        if (!disposed) {
          setConnection(nextConnection);
          setWindowConnectionError('');
        }
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setWindowConnectionError(getErrorMessage(error));
        }
      });

    return () => {
      disposed = true;
    };
  }, [windowConnectionId]);

  useEffect(() => {
    if (!vaultControls) {
      setIsVaultReady(true);
      setIsVaultHydrated(true);
      return;
    }

    let disposed = false;

    const loadSnapshot = async () => {
      let renderedPublicSnapshot = Boolean(initialPublicSnapshotRef.current);

      if (!renderedPublicSnapshot) {
        try {
          const publicSnapshot = typeof vaultControls.getPublicSnapshot === 'function'
            ? await vaultControls.getPublicSnapshot()
            : null;

          if (!disposed && publicSnapshot) {
            renderedPublicSnapshot = true;
            applyVaultSnapshot(publicSnapshot, { hydrated: false });
          }
        } catch {
          // Fall back to the full vault read below.
        }
      }

      try {
        let snapshot = await vaultControls.getSnapshot();

        if (!isConnectionWindow && shouldTryLegacyMigration(snapshot)) {
          const legacyPayload = readLegacyVaultPayload();

          if (hasLegacyCollections(legacyPayload)) {
            snapshot = await vaultControls.migrateLegacyData(legacyPayload);
            clearLegacyLocalStorage();
          }
        }

        if (!disposed) {
          applyVaultSnapshot(snapshot);
        }
      } catch (error) {
        if (!disposed) {
          setIsVaultReady(true);
          setStatusMessage(renderedPublicSnapshot
            ? `读取本地凭据失败：${getErrorMessage(error)}`
            : `读取本地数据失败：${getErrorMessage(error)}`);
        }
      }
    };

    void loadSnapshot();

    return () => {
      disposed = true;
    };
  }, [isConnectionWindow, vaultControls]);

  useEffect(() => {
    const logsControls = window.guiSSH?.logs;

    if (!logsControls || !isVaultReady || isConnectionWindow) {
      return;
    }

    void logsControls.getEntries().then((entries) => {
      setLogs(entries as unknown as LogEntry[]);
      lastPersistedLogsRef.current = JSON.stringify(entries);
      setIsLogsReady(true);
    }).catch(() => {
      setIsLogsReady(true);
    });
  }, [isConnectionWindow, isVaultReady]);

  useEffect(() => {
    if (!vaultControls || !isVaultReady || !isVaultHydrated) {
      return;
    }

    const payload = { hosts, sshKeys, settings };
    const serializedPayload = JSON.stringify(payload);

    if (serializedPayload === lastPersistedCollectionsRef.current) {
      return;
    }

    let cancelled = false;

    void vaultControls.saveCollections(payload).then((snapshot) => {
      if (cancelled) {
        return;
      }

      lastPersistedCollectionsRef.current = serializedPayload;
      setStorageInfo(snapshot.storage);
      setBookmarkCount(snapshot.browserBookmarks.reduce((total: number, collection: ShellDeskBrowserBookmarkCollection) => total + collection.bookmarks.length, 0));
    }).catch((error: unknown) => {
      if (!cancelled) {
        setStatusMessage(`保存本地数据失败：${getErrorMessage(error)}`);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [hosts, isVaultHydrated, isVaultReady, settings, sshKeys, vaultControls]);

  useEffect(() => {
    const closeOpenHostCardMenus = (target: EventTarget | null) => {
      const targetNode = target instanceof Node ? target : null;

      document.querySelectorAll<HTMLDetailsElement>('details.host-card-menu[open]').forEach((menu) => {
        if (targetNode && menu.contains(targetNode)) {
          return;
        }

        menu.open = false;
      });
    };

    const handlePointerDown = (event: PointerEvent) => {
      closeOpenHostCardMenus(event.target);
    };

    const handleFocusIn = (event: FocusEvent) => {
      closeOpenHostCardMenus(event.target);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeOpenHostCardMenus(null);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  useEffect(() => {
    const logsControls = window.guiSSH?.logs;

    if (!logsControls || !isLogsReady || isConnectionWindow) {
      return;
    }

    const serialized = JSON.stringify(logs);

    if (serialized === lastPersistedLogsRef.current) {
      return;
    }

    lastPersistedLogsRef.current = serialized;

    void logsControls.saveEntries(logs as unknown as ShellDeskLogEntry[]).catch(() => undefined);
  }, [logs, isConnectionWindow, isLogsReady]);

  useEffect(() => {
    if (!statusMessage) {
      return;
    }

    const delay = /失败|超时|断开|拒绝|重置|不可用|无效/.test(statusMessage) ? 8000 : 2400;
    const timer = window.setTimeout(() => setStatusMessage(''), delay);
    return () => window.clearTimeout(timer);
  }, [statusMessage]);

  useEffect(() => {
    const root = document.documentElement;
    const prefersLight = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches;
    const effectiveTheme = settings.theme === 'system' ? (prefersLight ? 'light' : 'dark') : settings.theme;
    const isLightTheme = effectiveTheme === 'light';
    const accentColor = settings.accentColor;
    const accentContrast = getReadableTextColor(accentColor);

    root.style.setProperty('--accent', accentColor);
    root.style.setProperty('--accent-strong', accentColor);
    root.style.setProperty('--accent-contrast', accentContrast);
    root.style.setProperty('--bg', isLightTheme ? '#e7edf5' : '#0b111a');
    root.style.setProperty('--chrome', isLightTheme ? '#dfe7f1' : '#1b222b');
    root.style.setProperty('--sidebar', isLightTheme ? '#dde6f0' : '#20262f');
    root.style.setProperty('--sidebar-active', isLightTheme ? '#ccd8e6' : '#3a3f49');
    root.style.setProperty('--surface', isLightTheme ? '#f8fafc' : '#111820');
    root.style.setProperty('--surface-soft', isLightTheme ? '#eef3f8' : '#161e28');
    root.style.setProperty('--surface-strong', isLightTheme ? '#dfe7f1' : '#1a2330');
    root.style.setProperty('--surface-elevated', isLightTheme ? '#edf2f7' : '#141b25');
    root.style.setProperty('--surface-input', isLightTheme ? '#f8fafc' : '#1a212c');
    root.style.setProperty('--surface-control', isLightTheme ? '#e4ebf4' : '#202733');
    root.style.setProperty('--surface-hover', isLightTheme ? '#e5edf6' : '#141d28');
    root.style.setProperty('--surface-icon', isLightTheme ? '#d2e1f1' : '#12334a');
    root.style.setProperty('--surface-panel', isLightTheme ? '#f2f6fb' : '#151d28');
    root.style.setProperty('--surface-empty', isLightTheme ? 'rgba(16, 32, 51, 0.035)' : 'rgba(255, 255, 255, 0.025)');
    root.style.setProperty('--surface-pill', isLightTheme ? '#d2dce8' : '#1d2632');
    root.style.setProperty('--surface-success-soft', isLightTheme ? 'rgba(34, 160, 90, 0.08)' : 'rgba(119, 244, 197, 0.08)');
    root.style.setProperty('--surface-success-border', isLightTheme ? 'rgba(34, 160, 90, 0.22)' : 'rgba(119, 244, 197, 0.22)');
    root.style.setProperty('--text-success', isLightTheme ? '#1a8a55' : '#d8fff1');
    root.style.setProperty('--toast-bg', isLightTheme ? 'rgba(241, 246, 251, 0.96)' : 'rgba(12, 23, 34, 0.92)');
    root.style.setProperty('--toast-text', isLightTheme ? '#1a6d94' : '#c6efff');
    root.style.setProperty('--text', isLightTheme ? '#18263a' : '#edf4ff');
    root.style.setProperty('--muted', isLightTheme ? '#627890' : '#8b9aad');
    root.style.setProperty('--muted-strong', isLightTheme ? '#415874' : '#bfcede');
    root.style.setProperty('--border', isLightTheme ? 'rgba(20, 42, 68, 0.14)' : 'rgba(139, 164, 195, 0.14)');
    root.style.setProperty('--border-strong', isLightTheme ? 'rgba(20, 42, 68, 0.22)' : 'rgba(139, 164, 195, 0.28)');
    root.style.setProperty('--window-border', isLightTheme ? 'rgba(20, 42, 68, 0.1)' : 'rgba(255, 255, 255, 0.04)');
    root.style.setProperty('--window-divider', isLightTheme ? 'rgba(20, 42, 68, 0.1)' : 'rgba(255, 255, 255, 0.05)');
    root.style.setProperty('--chrome-hover', isLightTheme ? 'rgba(20, 42, 68, 0.06)' : 'rgba(255, 255, 255, 0.08)');
    root.style.setProperty('--danger-hover-bg', isLightTheme ? 'rgba(200, 48, 78, 0.12)' : 'rgba(255, 111, 143, 0.18)');
    root.style.setProperty('--danger-hover-text', isLightTheme ? '#d63a5e' : '#ffd8e1');
    root.style.setProperty('--danger-soft', isLightTheme ? 'rgba(200, 48, 78, 0.08)' : 'rgba(255, 111, 143, 0.12)');
    root.style.setProperty('--danger-border', isLightTheme ? 'rgba(200, 48, 78, 0.32)' : 'rgba(255, 111, 143, 0.42)');
    root.style.setProperty('--danger-text-soft', isLightTheme ? '#c8304e' : '#ffd3dc');
    root.style.setProperty('--focus-border', toRgba(accentColor, isLightTheme ? 0.5 : 0.46));
    root.style.setProperty('--focus-ring', toRgba(accentColor, isLightTheme ? 0.1 : 0.12));
    root.style.setProperty('--accent-soft', toRgba(accentColor, isLightTheme ? 0.12 : 0.16));
    root.style.setProperty('--accent-border', toRgba(accentColor, isLightTheme ? 0.36 : 0.42));
    root.style.setProperty('--accent-strong-border', toRgba(accentColor, isLightTheme ? 0.5 : 0.58));
    root.style.setProperty('--shadow', isLightTheme ? 'rgba(43, 67, 92, 0.12)' : 'rgba(0, 0, 0, 0.34)');
    root.style.setProperty('--shadow-soft', isLightTheme ? '0 6px 18px rgba(43, 67, 92, 0.08)' : '0 12px 28px rgba(0, 0, 0, 0.16)');
    root.style.setProperty('--shadow-float', isLightTheme ? '0 12px 28px rgba(43, 67, 92, 0.16)' : '0 18px 36px rgba(0, 0, 0, 0.32)');
    root.style.setProperty('--shadow-panel', isLightTheme ? '0 16px 48px rgba(43, 67, 92, 0.16)' : '0 24px 70px rgba(0, 0, 0, 0.42)');
    root.style.setProperty('--shadow-panel-strong', isLightTheme ? '0 16px 48px rgba(43, 67, 92, 0.18)' : '0 24px 70px rgba(0, 0, 0, 0.46)');
    root.style.setProperty('--toggle-off', isLightTheme ? '#c3cedb' : '#202938');
    root.style.colorScheme = isLightTheme ? 'light' : 'dark';
    root.setAttribute('data-theme', effectiveTheme);
    const interfaceFontFamily = `"${settings.interfaceFont}", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Source Han Sans SC", "Segoe UI Variable", "Segoe UI", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif`;
    root.style.setProperty('--interface-font-family', interfaceFontFamily);
    document.body.style.fontFamily = interfaceFontFamily;
  }, [settings]);

  useEffect(() => {
    if (!windowControls) {
      return;
    }

    let isMounted = true;
    void windowControls.isMaximized().then((maximized) => {
      if (isMounted) {
        setIsWindowMaximized(maximized);
      }
    }).catch(() => undefined);

    const unsubscribe = window.guiSSH?.events.onWindowMaximizedChange((payload) => {
      setIsWindowMaximized(Boolean(payload.maximized));
    });

    return () => {
      isMounted = false;
      unsubscribe?.();
    };
  }, [windowControls]);

  useEffect(() => {
    if (!connection || !window.guiSSH?.events) {
      return;
    }

    return window.guiSSH.events.onConnectionClosed((payload: ConnectionClosedPayload) => {
      if (payload.connectionId === connection.id) {
        const message = payload.reason || 'SSH 连接已断开。';
        const time = new Date().toLocaleTimeString('zh-CN');
        addLog('connection', 'warning', `连接断开：${connection.host.address}`, `${time} — ${message}`);
        setStatusMessage(message);
        // 不自动关闭窗口，让用户看到断开原因
        setWindowConnectionError(`${time} — ${message}`);
      }
    });
  }, [connection, isConnectionWindow, windowControls]);

  useEffect(() => {
    if (!window.guiSSH?.events.onVaultChanged || !vaultControls) {
      return;
    }

    return window.guiSSH.events.onVaultChanged((payload) => {
      if (payload.kind !== 'bookmarks' && !isConnectionWindow) {
        return;
      }

      void vaultControls.getSnapshot().then((snapshot) => {
        applyVaultSnapshot(snapshot, { updateCollections: isConnectionWindow });
      }).catch(() => undefined);
    });
  }, [isConnectionWindow, vaultControls]);

  const addLog = (category: LogCategory, level: LogLevel, message: string, detail = '') => {
    setLogs((current) => {
      const entry: LogEntry = {
        id: createId(),
        timestamp: new Date().toISOString(),
        category,
        level,
        message,
        detail,
      };
      const next = [entry, ...current];
      return next.length > 500 ? next.slice(0, 500) : next;
    });
  };

  const clearLogs = () => {
    setLogs([]);
  };

  const minimizeWindow = () => {
    void windowControls?.minimize();
  };

  const toggleMaximizeWindow = () => {
    void windowControls?.toggleMaximize().then((maximized) => {
      setIsWindowMaximized(maximized);
    }).catch(() => undefined);
  };

  const closeWindow = () => {
    void windowControls?.close();
  };

  const resetForm = () => {
    setForm(emptyHostForm);
    setEditingHostId(null);
    setFormError('');
  };

  const resetKeyForm = () => {
    setKeyForm(emptyKeyForm);
    setEditingKeyId(null);
    setKeyFormError('');
  };

  const openCreateHost = () => {
    resetForm();
    setIsEditorOpen(true);
  };

  const closeEditor = () => {
    resetForm();
    setIsEditorOpen(false);
  };

  const openCreateKey = () => {
    resetKeyForm();
    setKeyEditorMode('generate');
    setIsKeyEditorOpen(true);
    setActivePage('keys');
  };

  const openImportKey = () => {
    resetKeyForm();
    setKeyEditorMode('import');
    setIsKeyEditorOpen(true);
    setActivePage('keys');
  };

  const closeKeyEditor = () => {
    resetKeyForm();
    setIsKeyEditorOpen(false);
  };

  const updateFormField = <Field extends keyof HostFormState>(field: Field, value: HostFormState[Field]) => {
    setForm((currentForm) => ({ ...currentForm, [field]: value }));
    setFormError('');
  };

  const updateKeyFormField = <Field extends keyof KeyFormState>(field: Field, value: KeyFormState[Field]) => {
    setKeyForm((currentForm) => ({ ...currentForm, [field]: value }));
    setKeyFormError('');
  };

  const selectPrivateKeyFileForKeyForm = async () => {
    const filePath = await window.guiSSH?.files.selectPrivateKeyFile();

    if (!filePath) {
      return;
    }

    setKeyForm((currentForm) => ({
      ...currentForm,
      privateKeyPath: filePath,
      publicKeyPath: currentForm.publicKeyPath || `${filePath}.pub`,
      name: currentForm.name.trim() ? currentForm.name : getKeyNameFromPath(filePath),
    }));
    setKeyFormError('');
  };

  const selectPublicKeyFileForKeyForm = async () => {
    const filePath = await window.guiSSH?.files.selectPublicKeyFile();

    if (!filePath) {
      return;
    }

    setKeyForm((currentForm) => ({
      ...currentForm,
      publicKeyPath: filePath,
    }));
    setKeyFormError('');
  };

  const submitKey = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const mode = editingKey ? 'edit' : keyEditorMode;
    const validationError = validateKeyForm(keyForm, mode);

    if (validationError) {
      setKeyFormError(validationError);
      return;
    }

    if (editingKey) {
      const updatedKey = updateSshKeyFromForm(editingKey, keyForm);
      setSshKeys((currentKeys) => currentKeys.map((key) => (key.id === editingKey.id ? updatedKey : key)));
      addLog('key', 'success', `更新密钥：${updatedKey.name}`);
      setStatusMessage(`已更新密钥：${updatedKey.name}`);
      closeKeyEditor();
      return;
    }

    if (!vaultControls) {
      setKeyFormError('当前运行环境不支持安全密钥库。');
      return;
    }

    const action = keyEditorMode === 'generate'
      ? vaultControls.generateRsaKeyPair({
          name: keyForm.name.trim(),
          passphrase: keyForm.passphrase,
          modulusLength: Number(keyForm.modulusLength),
        })
      : vaultControls.importKeyPair({
          name: keyForm.name.trim(),
          privateKeyPath: keyForm.privateKeyPath.trim(),
          publicKeyPath: keyForm.publicKeyPath.trim(),
          passphrase: keyForm.passphrase,
        });

    action
      .then(({ snapshot, key }) => {
        applyVaultSnapshot(snapshot);
        addLog('key', 'success', keyEditorMode === 'generate' ? `生成密钥：${key.name}` : `导入密钥：${key.name}`);
        setStatusMessage(keyEditorMode === 'generate' ? `已生成密钥：${key.name}` : `已导入密钥：${key.name}`);
        closeKeyEditor();
      })
      .catch((error: unknown) => {
        setKeyFormError(getErrorMessage(error));
      });
  };

  const startEditingKey = (key: SshKey) => {
    setEditingKeyId(key.id);
    setKeyForm(toKeyFormState(key));
    setKeyEditorMode('edit');
    setKeyFormError('');
    setIsKeyEditorOpen(true);
  };

  const copyPublicKey = async (key: SshKey) => {
    if (!key.publicKey) {
      setStatusMessage(`密钥「${key.name}」当前没有可复制的公钥。`);
      return;
    }

    try {
      await navigator.clipboard.writeText(key.publicKey);
      setStatusMessage(`已复制公钥：${key.name}`);
    } catch (error) {
      setStatusMessage(`复制失败：${getErrorMessage(error)}`);
    }
  };

  const deleteSshKey = (key: SshKey) => {
    const relatedHosts = hosts.filter((host) => host.keyId === key.id);
    setDeleteConfirmation({ kind: 'ssh-key', key, relatedHostCount: relatedHosts.length });
  };

  const confirmDeleteSshKey = (key: SshKey) => {
    const relatedHosts = hosts.filter((host) => host.keyId === key.id);
    setSshKeys((currentKeys) => currentKeys.filter((currentKey) => currentKey.id !== key.id));

    if (relatedHosts.length) {
      setHosts((currentHosts) => currentHosts.map((host) => (
        host.keyId === key.id
          ? {
              ...host,
              authMethod: 'password',
              keyId: '',
              keyPath: '',
              passphrase: '',
              password: '',
              updatedAt: new Date().toISOString(),
            }
          : host
      )));
    }

    if (editingKeyId === key.id) {
      closeKeyEditor();
    }

    addLog('key', 'info', `删除密钥：${key.name}`, relatedHosts.length ? `关联 ${relatedHosts.length} 台主机已切换为密码登录` : '');
    setStatusMessage(`已删除密钥：${key.name}`);
  };

  const updateCredentialField = <Field extends keyof CredentialFormState>(
    field: Field,
    value: CredentialFormState[Field],
  ) => {
    setCredentialForm((currentForm) => ({ ...currentForm, [field]: value }));
    setCredentialError('');
  };

  const updateCredentialAuthMethod = (authMethod: AuthMethod) => {
    setCredentialForm((currentForm) => {
      const selectedKey = sshKeyById.get(currentForm.keyId) ??
        (credentialHost?.authMethod === 'key' && credentialHost.keyPath ? null : sshKeys[0] ?? null);

      return {
        ...currentForm,
        authMethod,
        keyId: authMethod === 'key' ? selectedKey?.id ?? '' : currentForm.keyId,
        passphrase: authMethod === 'key' ? selectedKey?.passphrase ?? currentForm.passphrase : currentForm.passphrase,
        saveCredential: authMethod === 'password' ? settings.rememberPasswords : settings.rememberKeyPassphrases,
      };
    });
    setCredentialError('');
  };

  const updateCredentialKeyId = (keyId: string) => {
    const selectedKey = sshKeyById.get(keyId) ?? null;

    setCredentialForm((currentForm) => ({
      ...currentForm,
      keyId,
      passphrase: selectedKey?.passphrase ?? '',
    }));
    setCredentialError('');
  };

  const openCredentialDialog = (host: ConnectionHost, message = '') => {
    const selectedKey = host.authMethod === 'key' ? getSelectedSshKey(host) : null;
    const authMethod: AuthMethod = host.authMethod === 'key' ? 'key' : 'password';

    setCredentialHost(host);
    setCredentialForm({
      authMethod,
      password: host.password,
      keyId: authMethod === 'key' ? selectedKey?.id ?? '' : sshKeys[0]?.id ?? '',
      passphrase: selectedKey?.passphrase ?? host.passphrase,
      saveCredential: authMethod === 'password' ? settings.rememberPasswords : settings.rememberKeyPassphrases,
    });
    setCredentialError(message);
  };

  const closeCredentialDialog = () => {
    setCredentialHost(null);
    setCredentialForm(emptyCredentialForm);
    setCredentialError('');
  };

  const showConnectionError = (host: Pick<ConnectionHost, 'name' | 'username' | 'address' | 'port'>, message: string) => {
    setConnectionErrorNotice({
      hostName: host.name || host.address,
      endpoint: `${host.username}@${host.address}:${host.port}`,
      message,
    });
    setStatusMessage('');
  };

  const submitHost = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const selectedKey = sshKeyById.get(form.keyId) ?? null;
    const validationError = validateHostForm(form, sshKeys);

    if (validationError) {
      setFormError(validationError);
      return;
    }

    if (editingHost) {
      const updatedHost = updateHostFromForm(editingHost, form, selectedKey);
      setHosts((currentHosts) => currentHosts.map((host) => (host.id === editingHost.id ? updatedHost : host)));
      addLog('host', 'success', `更新主机：${updatedHost.name}`, `${updatedHost.username}@${updatedHost.address}:${updatedHost.port}`);
      setStatusMessage(`已更新主机：${updatedHost.name}`);
    } else {
      const nextHost = createHostFromForm(form, selectedKey);
      setHosts((currentHosts) => [nextHost, ...currentHosts]);
      addLog('host', 'success', `添加主机：${nextHost.name}`, `${nextHost.username}@${nextHost.address}:${nextHost.port}`);
      setStatusMessage(`已添加主机：${nextHost.name}`);
    }

    closeEditor();
  };

  const startEditingHost = (host: Host) => {
    setEditingHostId(host.id);
    setForm(toFormState(host));
    setFormError('');
    setIsEditorOpen(true);
  };

  const deleteHost = (host: Host) => {
    setDeleteConfirmation({ kind: 'host', host });
  };

  const confirmDeleteHost = (host: Host) => {
    const nextHosts = hosts.filter((currentHost) => currentHost.id !== host.id);
    setHosts(nextHosts);
    addLog('host', 'info', `删除主机：${host.name}`, `${host.username}@${host.address}:${host.port}`);
    setStatusMessage(`已删除主机：${host.name}`);

    if (editingHostId === host.id) {
      closeEditor();
    }
  };

  const confirmPendingDelete = () => {
    if (!deleteConfirmation) {
      return;
    }

    if (deleteConfirmation.kind === 'ssh-key') {
      confirmDeleteSshKey(deleteConfirmation.key);
    } else {
      confirmDeleteHost(deleteConfirmation.host);
    }

    setDeleteConfirmation(null);
  };

  const closeHostCardMenu = (trigger: HTMLElement | null) => {
    const details = trigger?.closest('details');

    if (details instanceof HTMLDetailsElement) {
      details.open = false;
    }
  };

  const connectHost = async (host: ConnectionHost, credentials?: CredentialFormState) => {
    if (!window.guiSSH?.connections) {
      showConnectionError(host, '当前运行环境不支持 SSH 连接。');
      return false;
    }

    const effectiveAuthMethod = credentials?.authMethod ?? host.authMethod;
    const selectedKey = effectiveAuthMethod === 'key'
      ? sshKeyById.get(credentials?.keyId || host.keyId) ?? null
      : null;
    const shouldUseHostKeyPath = effectiveAuthMethod === 'key' && !selectedKey && Boolean(host.keyPath);

    if (effectiveAuthMethod === 'key' && !selectedKey && !shouldUseHostKeyPath) {
      showConnectionError(host, '该主机未选择有效密钥。');
      return false;
    }

    const hostForConnection: ConnectionHost = {
      ...host,
      authMethod: effectiveAuthMethod,
      password: effectiveAuthMethod === 'password' ? credentials?.password ?? host.password : '',
      keyId: effectiveAuthMethod === 'key' ? selectedKey?.id ?? '' : '',
      keyPath: effectiveAuthMethod === 'key' && !selectedKey ? host.keyPath : '',
      passphrase: effectiveAuthMethod === 'key'
        ? credentials?.passphrase ?? selectedKey?.passphrase ?? host.passphrase
        : '',
    };

    setIsConnecting(true);
    setConnectionErrorNotice(null);
    setStatusMessage(`正在连接 ${host.name}...`);

    try {
      const nextConnection = await window.guiSSH.connections.connect(hostForConnection);
      const detectedSystemType = getHostSystemType(nextConnection.host?.systemType, nextConnection.host?.systemName);
      const detectedSystemName = typeof nextConnection.host?.systemName === 'string' ? nextConnection.host.systemName : '';
      const hasDetectedSystem = detectedSystemType !== 'unknown' || Boolean(detectedSystemName);

      if (credentials?.saveCredential || hasDetectedSystem) {
        setHosts((currentHosts) =>
          currentHosts.map((currentHost) =>
            currentHost.id === host.id
              ? {
                  ...currentHost,
                  ...(credentials?.saveCredential
                    ? {
                        authMethod: effectiveAuthMethod === 'key' ? 'key' : 'password',
                        password: effectiveAuthMethod === 'password' ? credentials.password : '',
                        keyId: effectiveAuthMethod === 'key' ? selectedKey?.id ?? currentHost.keyId : '',
                        keyPath: effectiveAuthMethod === 'key' && !selectedKey ? host.keyPath : '',
                        passphrase: effectiveAuthMethod === 'key' && !selectedKey ? credentials.passphrase : '',
                      }
                    : {}),
                  ...(hasDetectedSystem
                    ? {
                        systemType: detectedSystemType,
                        systemName: detectedSystemName,
                      }
                    : {}),
                  updatedAt: new Date().toISOString(),
                }
              : currentHost,
          ),
        );

        if (credentials?.saveCredential && effectiveAuthMethod === 'key' && selectedKey) {
          setSshKeys((currentKeys) => currentKeys.map((key) => (
            key.id === selectedKey.id
              ? { ...key, passphrase: credentials.passphrase, updatedAt: new Date().toISOString() }
              : key
          )));
        }
      }

      if (isConnectionWindow) {
        setConnection({ ...nextConnection, host: nextConnection.host ?? hostForConnection });
        addLog('connection', 'success', `连接成功：${host.name}`, `${host.username}@${host.address}:${host.port}`);
        setStatusMessage(`已连接：${host.name}`);
      } else {
        addLog('connection', 'success', `打开连接窗口：${host.name}`, `${host.username}@${host.address}:${host.port}`);
        setStatusMessage(`已打开连接窗口：${host.name}`);
      }

      closeCredentialDialog();
      setConnectionErrorNotice(null);
      return true;
    } catch (error) {
      const message = getErrorMessage(error);
      addLog('connection', 'error', `连接失败：${host.name}`, `${host.username}@${host.address}:${host.port} — ${message}`);
      showConnectionError(hostForConnection, message);

      if (isAuthFailureMessage(message)) {
        openCredentialDialog(hostForConnection, message);
      }

      return false;
    } finally {
      setIsConnecting(false);
    }
  };

  const connectCommandBarInput = async () => {
    const parsedCommand = parseQuickConnectCommand(searchQuery);

    if (!parsedCommand) {
      setStatusMessage('请输入合法 SSH 命令，例如 ssh user@host、ssh -p 2222 user@host 或 user@host。');
      return;
    }

    const matchedHost = hosts.find((host) => (
      host.address === parsedCommand.address &&
      host.port === parsedCommand.port &&
      host.username === parsedCommand.username
    ));

    if (matchedHost && !parsedCommand.keyPath) {
      await connectHost(matchedHost);
      return;
    }

    const now = new Date().toISOString();
    const quickConnectHost: ConnectionHost = {
      id: `quick-connect:${parsedCommand.username}@${parsedCommand.address}:${parsedCommand.port}`,
      name: `${parsedCommand.username}@${parsedCommand.address}`,
      address: parsedCommand.address,
      port: parsedCommand.port,
      username: parsedCommand.username,
      authMethod: parsedCommand.keyPath ? 'key' : 'agent',
      password: '',
      keyId: '',
      keyPath: parsedCommand.keyPath,
      passphrase: '',
      systemType: 'unknown',
      systemName: '',
      group: '',
      tags: [],
      note: '',
      createdAt: now,
      updatedAt: now,
    };

    await connectHost(quickConnectHost);
  };

  const submitCredentialConnection = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!credentialHost) {
      return;
    }

    if (credentialForm.authMethod === 'password' && !credentialForm.password) {
      setCredentialError('请输入 SSH 密码。');
      return;
    }

    if (
      credentialForm.authMethod === 'key' &&
      !credentialForm.keyId &&
      !(credentialHost.authMethod === 'key' && credentialHost.keyPath)
    ) {
      setCredentialError('请选择 SSH 密钥。');
      return;
    }

    await connectHost(credentialHost, credentialForm);
  };

  const clearFilters = () => {
    setActiveGroupKey(null);
    setSearchQuery('');
  };

  const changeViewMode = (nextViewMode: ViewMode) => {
    setViewMode(nextViewMode);
    setSettings((currentSettings: ShellDeskAppSettings) => (
      currentSettings.defaultHostView === nextViewMode
        ? currentSettings
        : { ...currentSettings, defaultHostView: nextViewMode }
    ));
  };

  const exportConfig = async () => {
    if (!window.guiSSH?.files.exportConfig) {
      setStatusMessage('当前运行环境不支持导出配置。');
      return;
    }

    setIsConfigTransferPending(true);

    try {
      const filePath = await window.guiSSH.files.exportConfig();

      if (!filePath) {
        return;
      }

      setStatusMessage(`已导出 ${hosts.length} 台主机、${sshKeys.length} 把密钥和 ${bookmarkCount} 条书签。`);
      addLog('config', 'success', '导出配置', `${hosts.length} 台主机、${sshKeys.length} 把密钥、${bookmarkCount} 条书签`);
    } catch (error) {
      addLog('config', 'error', '导出配置失败', getErrorMessage(error));
      setStatusMessage(`导出失败：${getErrorMessage(error)}`);
    } finally {
      setIsConfigTransferPending(false);
    }
  };

  const importConfig = async () => {
    if (!window.guiSSH?.files.importConfig) {
      setStatusMessage('当前运行环境不支持导入配置。');
      return;
    }

    setIsConfigTransferPending(true);

    try {
      const importedConfig = await window.guiSSH.files.importConfig();

      if (!importedConfig) {
        return;
      }

      if (!importedConfig.hosts.length && !importedConfig.sshKeys.length) {
        setStatusMessage('导入文件中没有可用配置。');
        return;
      }

      closeEditor();
      closeKeyEditor();
      closeCredentialDialog();
      applyVaultSnapshot(importedConfig);
      setStatusMessage(`已导入 ${importedConfig.hosts.length} 台主机、${importedConfig.sshKeys.length} 把密钥和 ${importedConfig.browserBookmarks.reduce((total, collection) => total + collection.bookmarks.length, 0)} 条书签。`);
      addLog('config', 'success', '导入配置', `${importedConfig.hosts.length} 台主机、${importedConfig.sshKeys.length} 把密钥`);
    } catch (error) {
      addLog('config', 'error', '导入配置失败', getErrorMessage(error));
      setStatusMessage(`导入失败：${getErrorMessage(error)}`);
    } finally {
      setIsConfigTransferPending(false);
    }
  };

  const credentialSelectedKey = credentialHost
    ? sshKeyById.get(credentialForm.keyId) ?? null
    : null;
  const credentialCanUseCurrentKeyFile = Boolean(
    credentialHost?.authMethod === 'key' && credentialHost.keyPath && !credentialForm.keyId,
  );
  const credentialCanUseKeyAuth = sshKeys.length > 0 || credentialCanUseCurrentKeyFile;
  const credentialSaveLabel = credentialHost && hosts.some((host) => host.id === credentialHost.id)
    ? '连接成功后保存到此主机配置'
    : credentialForm.authMethod === 'key'
      ? '连接成功后保存密钥口令'
      : '连接成功后记住本次密码';

  return (
    <div className="app-shell">
      <header className="top-chrome drag-region">
        <div className="workspace-title">
          <img className="app-window-icon" src={appIconUrl} alt="" />
          {connection ? (
            <>
              <strong>ShellDesk</strong>
              <span>{titlebarConnectionAddress}</span>
              <span>SOCKS :{connection.proxyPort}</span>
            </>
          ) : (
            'ShellDesk'
          )}
        </div>

        {showWindowControls ? (
          <div className="titlebar-controls no-drag">
            <button type="button" className="titlebar-button minimize" aria-label="最小化" title="最小化" onClick={minimizeWindow}>−</button>
            <button
              type="button"
              className={`titlebar-button maximize ${isWindowMaximized ? 'restore' : ''}`}
              aria-label={isWindowMaximized ? '还原' : '最大化'}
              title={isWindowMaximized ? '还原' : '最大化'}
              onClick={toggleMaximizeWindow}
            >
              <span className={`window-control-icon ${isWindowMaximized ? 'restore' : 'maximize'}`} aria-hidden="true" />
            </button>
            <button type="button" className="titlebar-button danger" aria-label="关闭" title="关闭" onClick={closeWindow}>×</button>
          </div>
        ) : null}
      </header>

      {statusMessage ? <div className="status-toast no-drag" role="status">{statusMessage}</div> : null}
      {connectionErrorNotice ? createPortal(
        <div className="connection-error-overlay no-drag" role="presentation">
          <div className="connection-error-dialog" role="alertdialog" aria-modal="false" aria-labelledby="connection-error-title">
            <span className="connection-error-mark" aria-hidden="true">!</span>
            <div className="connection-error-copy">
              <strong id="connection-error-title">连接失败：{connectionErrorNotice.hostName}</strong>
              <span>{connectionErrorNotice.endpoint}</span>
              <p>{connectionErrorNotice.message}</p>
            </div>
            <button type="button" onClick={() => setConnectionErrorNotice(null)}>关闭</button>
          </div>
        </div>,
        document.body,
      ) : null}

      {connection ? (
        <RemoteDesktop connection={connection} settings={settings} onSettingsChange={(nextSettings) => setSettings(nextSettings)} />
      ) : isConnectionWindow ? (
        <main className="vault-page no-drag">
          <div className="empty-state">
            <span>{windowConnectionError ? 'CLOSED' : 'OPENING'}</span>
            <h3>{windowConnectionError ? '连接窗口不可用' : '正在打开连接窗口'}</h3>
            <p>{windowConnectionError || '正在读取 SSH 连接信息。'}</p>
            {windowConnectionError ? (
              <button type="button" className="command-button" onClick={closeWindow}>关闭窗口</button>
            ) : null}
          </div>
        </main>
      ) : (
      <div className="app-layout">
        <aside className="side-nav">
          <div className="brand-panel">
            <img className="brand-logo" src={appIconUrl} alt="" />
            <strong>ShellDesk</strong>
          </div>

          <nav className="feature-nav" aria-label="功能导航">
            {navigationItems.map((item) => (
              <button
                key={item.page}
                type="button"
                className={`feature-nav-item ${activePage === item.page ? 'active' : ''}`}
                onClick={() => setActivePage(item.page)}
              >
                <span className="nav-icon"><NavIcon name={item.icon} /></span>
                {item.label}
              </button>
            ))}
          </nav>

          <button
            type="button"
            className={`settings-entry ${activePage === 'settings' ? 'active' : ''}`}
            onClick={() => setActivePage('settings')}
          >
            <span className="nav-icon"><NavIcon name="settings" /></span>
            设置
          </button>
        </aside>

        <main className="vault-page">
          {activePage === 'hosts' ? (
            <>
          <div className="command-bar no-drag">
            <label className="global-search">
              <span className="search-icon" aria-hidden="true">⌕</span>
              <input
                type="search"
                placeholder="查找主机或快速连接（例如：ssh user@hostname -p 2222）"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void connectCommandBarInput();
                  }
                }}
              />
              <kbd>Ctrl + K</kbd>
            </label>

            <button type="button" className="command-button" onClick={connectCommandBarInput} disabled={isConnecting}>
              {isConnecting ? '连接中...' : '连接'}
            </button>

            <div className="view-switch" aria-label="视图切换">
              <button type="button" className={viewMode === 'grid' ? 'active' : ''} onClick={() => changeViewMode('grid')}>网格</button>
              <button type="button" className={viewMode === 'list' ? 'active' : ''} onClick={() => changeViewMode('list')}>列表</button>
            </div>

            <button type="button" className="primary-action" onClick={openCreateHost}>+ 新建主机</button>
          </div>

          <section className="vault-content hosts-content">
            <aside className="hosts-group-panel" aria-label="主机分组">
              <button type="button" className={`filter-tab all-hosts-filter ${!activeGroupKey && !searchQuery ? 'active' : ''}`} onClick={clearFilters}>
                <span>全部主机</span>
                <b>{hosts.length}</b>
              </button>

              <div className="section-heading group-panel-heading">
                <h2>分组</h2>
                <button type="button" className="group-add-button" onClick={openCreateHost} aria-label="新建主机">
                  +
                </button>
              </div>

              {!isVaultReady ? (
                <div className="empty-inline">正在读取主机分组...</div>
              ) : hostGroups.length ? (
                <div className="group-grid group-list">
                  {hostGroups.map((group) => (
                    <button
                      key={group.key}
                      type="button"
                      className={`group-card ${activeGroupKey === group.key ? 'active' : ''}`}
                      onClick={() => setActiveGroupKey(group.key)}
                    >
                      <span className="group-icon" aria-hidden="true"><HostGroupIcon /></span>
                      <strong>{group.name}</strong>
                      <small>{group.count}</small>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="empty-inline">添加主机后会自动生成分组。</div>
              )}
            </aside>

            <section className="vault-section host-section hosts-list-panel">
              <div className="section-heading host-list-heading">
                <h2>{activeGroupName || '未分组'} <b>{filteredHosts.length}</b></h2>
                <span>
                  共 {filteredHosts.length} 个主机
                  <button type="button" className="host-refresh-button" onClick={() => void refreshHosts()} aria-label="刷新主机列表">
                    ↻
                  </button>
                </span>
              </div>

              {!isVaultReady ? (
                <div className="empty-state">
                  <span>LOADING</span>
                  <h3>正在读取主机列表</h3>
                  <p>正在从本地安全库载入已保存的 SSH 主机。</p>
                </div>
              ) : filteredHosts.length ? (
                <div className={`host-grid ${viewMode}`}>
                  {filteredHosts.map((host) => (
                    <article
                      key={host.id}
                      className="host-card"
                      onDoubleClick={() => {
                        if (host.authMethod === 'password' && !host.password) {
                          openCredentialDialog(host, '请输入该主机的 SSH 密码后连接。');
                          return;
                        }

                        void connectHost(host);
                      }}
                    >
                      <button type="button" className="host-card-main">
                        <HostSystemIcon systemName={getHostSystemLabel(host)} systemType={host.systemType} />
                        <span className="host-summary">
                          <strong>{host.name}</strong>
                          <small>{host.username ? `${host.username}@` : ''}{host.address}:{host.port}</small>
                          <span className="host-card-tags">
                            <em>SSH</em>
                            <em>{host.group || '未分组'}</em>
                            <em>{host.tags.length ? host.tags.join(' / ') : '无标签'}</em>
                          </span>
                        </span>
                      </button>
                      <span className="host-card-actions">
                        <span className="host-connection-state">
                          <i aria-hidden="true" />
                          就绪
                        </span>
                        {(host.authMethod === 'password' && host.password) || host.authMethod === 'key' ? (
                          <span className="credential-icon" title={host.authMethod === 'key' ? '密钥登录' : '密码已保存'}>🔑</span>
                        ) : null}
                        <details className="host-card-menu" onClick={(event) => event.stopPropagation()}>
                          <summary aria-label="主机操作">⋯</summary>
                        <div className="host-card-menu-panel">
                          <button
                            type="button"
                            onClick={(event) => {
                              closeHostCardMenu(event.currentTarget);
                              startEditingHost(host);
                            }}
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            className="danger-text"
                            onClick={(event) => {
                              closeHostCardMenu(event.currentTarget);
                              deleteHost(host);
                            }}
                          >
                            删除
                          </button>
                        </div>
                      </details>
                      </span>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="empty-state">
                  <span>EMPTY</span>
                  <h3>{hosts.length ? '没有匹配的主机' : '主机列表为空'}</h3>
                  <p>{hosts.length ? '清空搜索或切换分组后再试。' : '点击“新建主机”添加第一台 SSH 主机。'}</p>
                </div>
              )}
            </section>

          </section>
            </>
          ) : activePage === 'keys' ? (
            <KeysPage
              keySearchQuery={keySearchQuery}
              filteredKeys={filteredKeys}
              sshKeys={sshKeys}
              onSearchChange={setKeySearchQuery}
              onImportPrivateKey={openImportKey}
              onCreateKey={openCreateKey}
              onEditKey={startEditingKey}
              onDeleteKey={deleteSshKey}
              onCopyPublicKey={copyPublicKey}
            />
          ) : activePage === 'logs' ? (
            <LogsPage logs={logs} onClearLogs={clearLogs} />
          ) : (
            <SettingsPage
              hostCount={hosts.length}
              keyCount={sshKeys.length}
              bookmarkCount={bookmarkCount}
              settings={settings}
              storageInfo={storageInfo}
              isConfigTransferPending={isConfigTransferPending}
              onSettingsChange={(nextSettings) => setSettings(nextSettings)}
              onImportConfig={importConfig}
              onExportConfig={exportConfig}
            />
          )}

          {isEditorOpen && activePage === 'hosts' ? (
            <aside className="editor-panel no-drag" aria-label={editingHost ? '编辑主机' : '新建主机'}>
              <div className="editor-header">
                <span>
                  <strong>{editingHost ? '编辑主机' : '新建主机'}</strong>
                  <small>{editingHost ? editingHost.name : '保存到本地 Vault'}</small>
                </span>
                <button type="button" onClick={closeEditor} aria-label="关闭表单">×</button>
              </div>

              <form className="host-form" onSubmit={submitHost}>
                <label className="field">
                  <span>主机名称</span>
                  <input
                    value={form.name}
                    maxLength={80}
                    onChange={(event) => updateFormField('name', event.target.value)}
                    placeholder="例如：Production Web"
                  />
                </label>

                <label className="field">
                  <span>地址</span>
                  <input
                    value={form.address}
                    maxLength={255}
                    onChange={(event) => updateFormField('address', event.target.value)}
                    placeholder="192.168.100.21 或 github.com"
                  />
                </label>

                <div className="editor-grid">
                  <label className="field">
                    <span>用户名</span>
                    <input
                      value={form.username}
                      onChange={(event) => updateFormField('username', event.target.value)}
                      placeholder="root"
                    />
                  </label>

                  <label className="field">
                    <span>端口</span>
                    <input
                      value={form.port}
                      inputMode="numeric"
                      onChange={(event) => updateFormField('port', event.target.value)}
                      placeholder="22"
                    />
                  </label>
                </div>

                <div className="auth-method-section">
                  <span className="field-label">登录方式</span>
                  <div className="auth-switch" role="group" aria-label="登录方式">
                    <button
                      type="button"
                      className={form.authMethod === 'password' ? 'active' : ''}
                      onClick={() => {
                        updateFormField('authMethod', 'password');
                        updateFormField('keyId', '');
                        updateFormField('keyPath', '');
                        updateFormField('passphrase', '');
                      }}
                    >
                      <strong>密码登录</strong>
                      <small>保存密码到主机信息</small>
                    </button>
                    <button
                      type="button"
                      className={form.authMethod === 'key' ? 'active' : ''}
                      onClick={() => {
                        updateFormField('authMethod', 'key');
                        updateFormField('password', '');
                      }}
                    >
                      <strong>密钥登录</strong>
                      <small>选择密钥库中的已有密钥</small>
                    </button>
                  </div>
                </div>

                {form.authMethod === 'key' ? (
                  <label className="field">
                    <span>选择密钥</span>
                    <select
                      value={form.keyId}
                      onChange={(event) => updateFormField('keyId', event.target.value)}
                    >
                      <option value="">请选择已有密钥</option>
                      {sshKeys.map((key) => (
                        <option key={key.id} value={key.id}>{key.name} · {key.fingerprint || key.algorithm}</option>
                      ))}
                    </select>
                    {!sshKeys.length ? <small className="field-note">请先到“密钥”页面新建或导入密钥。</small> : null}
                  </label>
                ) : (
                  <label className="field">
                    <span>密码</span>
                    <input
                      type="password"
                      value={form.password}
                      onChange={(event) => updateFormField('password', event.target.value)}
                      placeholder="输入并保存该主机密码"
                    />
                  </label>
                )}

                <label className="field">
                  <span>分组</span>
                  <input
                    value={form.group}
                    onChange={(event) => updateFormField('group', event.target.value)}
                    placeholder="AWS / Production / Lab"
                  />
                </label>

                <label className="field">
                  <span>标签</span>
                  <input
                    value={form.tags}
                    onChange={(event) => updateFormField('tags', event.target.value)}
                    placeholder="linux, prod, db"
                  />
                </label>

                <label className="field">
                  <span>备注</span>
                  <textarea
                    value={form.note}
                    onChange={(event) => updateFormField('note', event.target.value)}
                    placeholder="用途、跳板机、维护窗口等"
                    rows={4}
                  />
                </label>

                {formError ? <div className="error-banner">{formError}</div> : null}

                <div className="form-actions">
                  <button type="submit" className="primary-action">{editingHost ? '保存修改' : '添加主机'}</button>
                  <button type="button" className="command-button" onClick={resetForm}>清空</button>
                </div>
              </form>
            </aside>
          ) : null}

          {isKeyEditorOpen && activePage === 'keys' ? (
            <aside className="editor-panel no-drag" aria-label={editingKey ? '编辑密钥' : '新建密钥'}>
              <div className="editor-header">
                <span>
                  <strong>{editingKey ? '编辑密钥' : keyEditorMode === 'generate' ? '新建 RSA 密钥' : '导入密钥对'}</strong>
                  <small>{editingKey ? editingKey.name : keyEditorMode === 'generate' ? '生成并保存到本地加密密钥库' : '读取现有密钥文件并复制到本地加密密钥库'}</small>
                </span>
                <button type="button" onClick={closeKeyEditor} aria-label="关闭密钥表单">×</button>
              </div>

              <form className="host-form" onSubmit={submitKey}>
                <label className="field">
                  <span>密钥名称</span>
                  <input
                    value={keyForm.name}
                    maxLength={80}
                    onChange={(event) => updateKeyFormField('name', event.target.value)}
                    placeholder="例如：Production Key"
                  />
                </label>

                {!editingKey && keyEditorMode === 'generate' ? (
                  <label className="field">
                    <span>RSA 位数</span>
                    <select
                      value={keyForm.modulusLength}
                      onChange={(event) => updateKeyFormField('modulusLength', event.target.value as KeyFormState['modulusLength'])}
                    >
                      <option value="2048">2048</option>
                      <option value="3072">3072</option>
                      <option value="4096">4096</option>
                    </select>
                  </label>
                ) : null}

                {!editingKey && keyEditorMode === 'import' ? (
                  <>
                    <label className="field">
                      <span>私钥文件</span>
                      <div className="file-picker-row">
                        <input value={keyForm.privateKeyPath} readOnly placeholder="请选择 SSH 私钥文件" />
                        <button type="button" className="command-button" onClick={selectPrivateKeyFileForKeyForm}>
                          选择文件
                        </button>
                      </div>
                    </label>

                    <label className="field">
                      <span>公钥文件（可选）</span>
                      <div className="file-picker-row">
                        <input value={keyForm.publicKeyPath} readOnly placeholder="可选，默认尝试使用同名 .pub 文件" />
                        <button type="button" className="command-button" onClick={selectPublicKeyFileForKeyForm}>
                          选择文件
                        </button>
                      </div>
                    </label>
                  </>
                ) : null}

                {editingKey ? (
                  <>
                    <label className="field">
                      <span>算法</span>
                      <input value={editingKey.algorithm || 'SSH'} readOnly />
                    </label>

                    <label className="field">
                      <span>指纹</span>
                      <input value={editingKey.fingerprint || '未生成'} readOnly />
                    </label>
                  </>
                ) : null}

                <label className="field">
                  <span>{editingKey ? '保存的解锁口令（可选）' : '密钥口令（可选）'}</span>
                  <input
                    type="password"
                    value={keyForm.passphrase}
                    onChange={(event) => updateKeyFormField('passphrase', event.target.value)}
                    placeholder={editingKey ? '更新保存的解锁口令，不会重写私钥文件' : '私钥加密时填写'}
                  />
                </label>

                {keyFormError ? <div className="error-banner">{keyFormError}</div> : null}

                <div className="form-actions">
                  <button type="submit" className="primary-action">
                    {editingKey ? '保存修改' : keyEditorMode === 'generate' ? '生成并保存' : '导入并保存'}
                  </button>
                  <button type="button" className="command-button" onClick={resetKeyForm}>清空</button>
                </div>
              </form>
            </aside>
          ) : null}

          {credentialHost ? (
            <aside className="credential-panel no-drag" aria-label="连接凭据">
              <div className="editor-header">
                <span>
                  <strong>连接凭据</strong>
                  <small>{credentialHost.username}@{credentialHost.address}:{credentialHost.port}</small>
                </span>
                <button type="button" onClick={closeCredentialDialog} aria-label="关闭连接凭据">×</button>
              </div>

              <form className="host-form" onSubmit={submitCredentialConnection}>
                <div className="auth-method-section">
                  <span className="field-label">认证方式</span>
                  <div className="auth-switch" role="group" aria-label="认证方式">
                    <button
                      type="button"
                      className={credentialForm.authMethod === 'password' ? 'active' : ''}
                      onClick={() => updateCredentialAuthMethod('password')}
                    >
                      <strong>密码</strong>
                      <small>输入 SSH 登录密码</small>
                    </button>
                    <button
                      type="button"
                      className={credentialForm.authMethod === 'key' ? 'active' : ''}
                      onClick={() => updateCredentialAuthMethod('key')}
                      disabled={!credentialCanUseKeyAuth}
                    >
                      <strong>密钥</strong>
                      <small>使用密钥库中的私钥</small>
                    </button>
                  </div>
                </div>

                {credentialForm.authMethod === 'password' ? (
                  <label className="field">
                    <span>SSH 密码</span>
                    <input
                      type="password"
                      value={credentialForm.password}
                      onChange={(event) => updateCredentialField('password', event.target.value)}
                      placeholder="输入该主机的 SSH 密码"
                      autoFocus
                    />
                  </label>
                ) : (
                  <>
                    {sshKeys.length ? (
                      <label className="field">
                        <span>选择密钥</span>
                        <select
                          value={credentialForm.keyId}
                          onChange={(event) => updateCredentialKeyId(event.target.value)}
                          autoFocus
                        >
                          <option value="">请选择已有密钥</option>
                          {sshKeys.map((key) => (
                            <option key={key.id} value={key.id}>{key.name} · {key.fingerprint || key.algorithm}</option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    {credentialSelectedKey ? (
                      <div className="credential-note">
                        当前使用密钥登录：{credentialSelectedKey.name}
                      </div>
                    ) : credentialCanUseCurrentKeyFile ? (
                      <div className="credential-note">
                        当前使用私钥文件：{credentialHost.keyPath}
                      </div>
                    ) : (
                      <div className="credential-note">
                        请先到“密钥”页面新建或导入密钥。
                      </div>
                    )}
                    <label className="field">
                      <span>密钥口令（私钥加密时填写）</span>
                      <input
                        type="password"
                        value={credentialForm.passphrase}
                        onChange={(event) => updateCredentialField('passphrase', event.target.value)}
                        placeholder="没有口令可留空"
                        autoFocus
                      />
                    </label>
                  </>
                )}

                {hosts.some((host) => host.id === credentialHost.id) || (credentialForm.authMethod === 'key' && credentialSelectedKey) ? (
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={credentialForm.saveCredential}
                      onChange={(event) => updateCredentialField('saveCredential', event.target.checked)}
                    />
                    <span>{credentialSaveLabel}</span>
                  </label>
                ) : null}

                {credentialError ? <div className="error-banner">{credentialError}</div> : null}

                <div className="form-actions">
                  <button type="submit" className="primary-action" disabled={isConnecting}>
                    {isConnecting ? '连接中...' : '连接'}
                  </button>
                  <button type="button" className="command-button" onClick={closeCredentialDialog}>取消</button>
                </div>
              </form>
            </aside>
          ) : null}

          {deleteConfirmation ? (
            <div className="notepad-modal-overlay no-drag" role="presentation" onClick={() => setDeleteConfirmation(null)}>
              <div className="notepad-modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-confirm-title" onClick={(event) => event.stopPropagation()}>
                <div id="delete-confirm-title" className="notepad-modal-title">确认删除</div>
                <div className="notepad-modal-message">
                  {deleteConfirmation.kind === 'ssh-key'
                    ? deleteConfirmation.relatedHostCount
                      ? `确认删除密钥「${deleteConfirmation.key.name}」？${deleteConfirmation.relatedHostCount} 台主机正在使用该密钥，删除后会切换为密码登录。`
                      : `确认删除密钥「${deleteConfirmation.key.name}」？`
                    : `确认删除主机「${deleteConfirmation.host.name}」？`}
                </div>
                <div className="notepad-modal-actions">
                  <button type="button" className="notepad-modal-btn" onClick={() => setDeleteConfirmation(null)}>取消</button>
                  <button type="button" className="notepad-modal-btn danger" onClick={confirmPendingDelete}>删除</button>
                </div>
              </div>
            </div>
          ) : null}
        </main>
      </div>
      )}
    </div>
  );
}

export default App;
