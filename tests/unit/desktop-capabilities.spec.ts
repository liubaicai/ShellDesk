import { expect, test } from '@playwright/test';

import {
  createStaticDesktopCapabilitySnapshot,
  formatToolRequirement,
} from '../../src/features/remote-desktop/desktopCapabilities';
import {
  desktopAppCapabilities,
  desktopApps,
  getDesktopAppToolRequirements,
} from '../../src/remoteDesktopCatalog';

test('capability metadata covers every registered desktop app', () => {
  expect(Object.keys(desktopAppCapabilities).sort()).toEqual(desktopApps.map((app) => app.key).sort());

  for (const app of desktopApps) {
    const capability = desktopAppCapabilities[app.key];
    expect(capability.supportedSystems.length).toBeGreaterThan(0);
    expect(capability.introducedInVersion).toBeGreaterThan(0);
  }
});

test('static capability gate distinguishes supported, unsupported and probed apps', () => {
  const linux = createStaticDesktopCapabilitySnapshot('ubuntu');
  const windows = createStaticDesktopCapabilitySnapshot('windows');
  const unknown = createStaticDesktopCapabilitySnapshot('unknown');

  expect(linux.files.status).toBe('available');
  expect(linux['vm-manager'].status).toBe('checking');
  expect(windows['vm-manager'].status).toBe('unsupported');
  expect(unknown.files.status).toBe('unknown');
});

test('platform-specific and alternative tool requirements remain explicit', () => {
  expect(getDesktopAppToolRequirements('service-manager', 'linux')).toEqual([['systemctl', 'rc-service']]);
  expect(getDesktopAppToolRequirements('service-manager', 'windows')).toEqual(['sc.exe']);
  expect(desktopAppCapabilities['service-manager'].supportedSystems).not.toContain('macos');
  expect(getDesktopAppToolRequirements('scheduled-tasks', 'linux')).toEqual([['crontab', 'systemctl']]);
  expect(getDesktopAppToolRequirements('scheduled-tasks', 'macos')).toEqual(['crontab']);
  expect(formatToolRequirement(['docker', 'podman'])).toBe('docker / podman');
});
