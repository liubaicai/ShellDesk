import {
  Code,
  FileText,
  KeyRound,
  Monitor,
  Network,
  Server,
  Settings as SettingsIcon,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';

import type { NavIconName } from './navigation/NavIcon';
import { getHostSystemType, hostSystemLabels, type HostSystemType } from '../appHostModel';

const hostSystemIconUrls: Record<HostSystemType, string> = {
  unknown: new URL('../assets/os-icons/unknown.png', import.meta.url).href,
  windows: new URL('../assets/os-icons/windows.png', import.meta.url).href,
  macos: new URL('../assets/os-icons/macos.png', import.meta.url).href,
  synology: new URL('../assets/os-icons/synology.png', import.meta.url).href,
  ubuntu: new URL('../assets/os-icons/ubuntu.png', import.meta.url).href,
  debian: new URL('../assets/os-icons/debian.png', import.meta.url).href,
  redhat: new URL('../assets/os-icons/redhat.png', import.meta.url).href,
  centos: new URL('../assets/os-icons/centos.png', import.meta.url).href,
  fedora: new URL('../assets/os-icons/fedora.png', import.meta.url).href,
  rocky: new URL('../assets/os-icons/rocky.png', import.meta.url).href,
  almalinux: new URL('../assets/os-icons/almalinux.png', import.meta.url).href,
  oracle: new URL('../assets/os-icons/oracle.png', import.meta.url).href,
  amazon: new URL('../assets/os-icons/amazon.png', import.meta.url).href,
  arch: new URL('../assets/os-icons/arch.png', import.meta.url).href,
  manjaro: new URL('../assets/os-icons/manjaro.png', import.meta.url).href,
  alpine: new URL('../assets/os-icons/alpine.png', import.meta.url).href,
  opensuse: new URL('../assets/os-icons/opensuse.png', import.meta.url).href,
  linuxmint: new URL('../assets/os-icons/linuxmint.png', import.meta.url).href,
  kali: new URL('../assets/os-icons/kali.png', import.meta.url).href,
  raspbian: new URL('../assets/os-icons/raspbian.png', import.meta.url).href,
  gentoo: new URL('../assets/os-icons/gentoo.png', import.meta.url).href,
  nixos: new URL('../assets/os-icons/nixos.png', import.meta.url).href,
  popos: new URL('../assets/os-icons/popos.png', import.meta.url).href,
  elementary: new URL('../assets/os-icons/elementary.png', import.meta.url).href,
  linux: new URL('../assets/os-icons/linux.png', import.meta.url).href,
  unix: new URL('../assets/os-icons/unix.png', import.meta.url).href,
};

export function HostSystemIcon({ systemName, systemType }: { systemName: string; systemType: HostSystemType }) {
  const effectiveSystemType = systemType === 'unknown' ? getHostSystemType(systemType, systemName) : systemType;
  const label = systemName || hostSystemLabels[effectiveSystemType];

  return (
    <span className={`host-avatar host-system-icon host-system-${effectiveSystemType}`} title={label} aria-label={label}>
      {effectiveSystemType === 'unknown' ? (
        <Server aria-hidden="true" />
      ) : (
        <img src={hostSystemIconUrls[effectiveSystemType]} alt="" draggable={false} />
      )}
    </span>
  );
}

export function ShellDeskNavIcon({ name }: { name: NavIconName }) {
  if (name === 'agent') {
    return <Sparkles aria-hidden="true" />;
  }

  if (name === 'hosts') {
    return <Monitor aria-hidden="true" />;
  }

  if (name === 'keys') {
    return <KeyRound aria-hidden="true" />;
  }

  if (name === 'snippets') {
    return <Code aria-hidden="true" />;
  }

  if (name === 'proxies') {
    return <Network aria-hidden="true" />;
  }

  if (name === 'known-hosts') {
    return <ShieldCheck aria-hidden="true" />;
  }

  if (name === 'logs') {
    return <FileText aria-hidden="true" />;
  }

  return <SettingsIcon aria-hidden="true" />;
}
