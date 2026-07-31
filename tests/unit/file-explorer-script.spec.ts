import { expect, test } from '@playwright/test';

import {
  createRemoteScriptLaunchOptions,
  isRunnableRemoteScript,
} from '../../src/components/remote-desktop/fileExplorerScriptUtils';

test('creates a safely quoted Unix script launch in its containing directory', () => {
  expect(createRemoteScriptLaunchOptions(
    "deploy's; echo unsafe.sh",
    "/srv/releases/deploy's; echo unsafe.sh",
    '/srv/releases',
    'ubuntu',
  )).toEqual({
    title: "deploy's; echo unsafe.sh",
    initialCommand: "sh '/srv/releases/deploy'\\''s; echo unsafe.sh'",
    workingDirectory: '/srv/releases',
  });
});

test('creates a PowerShell launch without allowing a quoted path to escape', () => {
  expect(createRemoteScriptLaunchOptions(
    "deploy'; Write-Host unsafe.ps1",
    "C:\\Ops\\deploy'; Write-Host unsafe.ps1",
    'C:\\Ops',
    'windows',
  )).toEqual({
    title: "deploy'; Write-Host unsafe.ps1",
    shell: 'powershell -NoLogo -NoProfile -ExecutionPolicy Bypass',
    initialCommand: "& 'C:\\Ops\\deploy''; Write-Host unsafe.ps1'",
    workingDirectory: 'C:\\Ops',
  });
});

test('offers script execution only for an allowlisted extension', () => {
  expect(isRunnableRemoteScript('deploy.sh', 'ubuntu')).toBe(true);
  expect(isRunnableRemoteScript('deploy.ps1', 'windows')).toBe(true);
  expect(isRunnableRemoteScript('notes.txt', 'ubuntu')).toBe(false);
  expect(createRemoteScriptLaunchOptions('notes.txt', '/tmp/notes.txt', '/tmp', 'ubuntu')).toBeUndefined();
});
