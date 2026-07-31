import { expect, test } from '@playwright/test';
import type { Host } from '../../src/appHostModel';
import {
  parseHostImportFiles,
  planHostImport,
  type HostImportFile,
} from '../../src/hostImport';

function existingHost(overrides: Partial<Host> = {}): Host {
  return {
    id: 'existing-1',
    name: 'Existing',
    address: 'db.example.com',
    port: 22,
    username: 'root',
    authMethod: 'password',
    password: '',
    keyId: '',
    keyPath: '',
    passphrase: '',
    privilegeMode: 'sudo',
    rootPassword: '',
    jumpHostId: '',
    canBeJumpHost: false,
    proxyProfileId: '',
    keepaliveEnabled: false,
    keepaliveIntervalMs: 15_000,
    systemType: 'ubuntu',
    systemName: 'Ubuntu 24.04',
    hostInfo: null,
    group: 'Production',
    tags: [],
    note: '',
    lastConnectionStatus: 'success',
    lastConnectionAt: '2026-07-01T00:00:00.000Z',
    lastConnectionError: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

const files: HostImportFile[] = [
  {
    name: 'MobaXterm.ini',
    parentName: '',
    content: [
      '[Bookmarks]',
      'SubRep=Production/Linux',
      'ImgNum=42',
      'Moba DB=#109#0%db.example.com%22%root%%-1%-1%%%%%0',
    ].join('\n'),
  },
  {
    name: 'staging.xsh',
    parentName: 'Xshell Sessions',
    content: [
      '[CONNECTION]',
      'Protocol=SSH',
      'Host=stage.example.com',
      'Port=2202',
      '[CONNECTION:AUTHENTICATION]',
      'UserName=deploy',
      'UserKey=C:\\keys\\deploy.pem',
    ].join('\n'),
  },
  {
    name: 'network.ini',
    parentName: 'SecureCRT',
    content: [
      'S:"Protocol Name"=SSH2',
      'S:"Hostname"=router.example.com',
      'D:"[SSH2] Port"=00000016',
      'S:"Username"=admin',
      'S:"Password"=02:encrypted',
    ].join('\n'),
  },
  {
    name: 'hosts.csv',
    parentName: '',
    content: [
      'Name,Host,Port,Username,Group,Tags,Password',
      '"CSV, Web",web.example.com,2222,www,Web,"edge;blue,canary",plain-secret',
    ].join('\n'),
  },
];

test('parses MobaXterm, Xshell, SecureCRT, and CSV host exports', () => {
  const preview = parseHostImportFiles(files, [existingHost()]);
  expect(preview.files).toHaveLength(4);
  expect(preview.candidates).toHaveLength(4);

  const [moba, xshell, secureCrt, csv] = preview.candidates;
  expect(moba).toMatchObject({
    source: 'mobaxterm',
    name: 'Moba DB',
    address: 'db.example.com',
    port: 22,
    username: 'root',
    group: 'Production/Linux',
    conflict: 'existing',
  });
  expect(xshell).toMatchObject({
    source: 'xshell',
    address: 'stage.example.com',
    port: 2202,
    username: 'deploy',
    keyPath: 'C:\\keys\\deploy.pem',
  });
  expect(secureCrt).toMatchObject({
    source: 'securecrt',
    address: 'router.example.com',
    port: 22,
    username: 'admin',
    secretKind: 'encrypted',
  });
  expect(csv).toMatchObject({
    source: 'csv',
    name: 'CSV, Web',
    address: 'web.example.com',
    port: 2222,
    secretKind: 'plaintext',
    tags: ['edge', 'blue', 'canary'],
  });
});

test('marks malformed and in-batch duplicate candidates without rejecting the whole preview', () => {
  const preview = parseHostImportFiles([
    {
      name: 'hosts.csv',
      parentName: '',
      content: [
        'name,host,port,user',
        'First,node.example.com,22,root',
        'Second,node.example.com,22,root',
        'Broken,,70000,root',
      ].join('\n'),
    },
  ], []);

  expect(preview.candidates[0].conflict).toBe('none');
  expect(preview.candidates[1].conflict).toBe('batch');
  expect(preview.candidates[2].errors).toEqual([
    'Host address is missing.',
    'SSH port must be between 1 and 65535.',
  ]);
});

test('duplicate plans skip, replace, or keep both while secrets remain opt-in', () => {
  const baseline = existingHost();
  const preview = parseHostImportFiles([files[0], files[3]], [baseline]);
  const selected = new Set(preview.candidates.map((candidate) => candidate.id));
  let nextId = 0;
  const idFactory = () => `import-${++nextId}`;

  const skipped = planHostImport(
    [baseline],
    preview.candidates,
    selected,
    'skip',
    false,
    '2026-07-31T00:00:00.000Z',
    idFactory,
  );
  expect(skipped).toMatchObject({ added: 1, replaced: 0, skipped: 1 });
  expect(skipped.hosts.find((host) => host.address === 'web.example.com')?.password).toBe('');

  const replaced = planHostImport(
    [baseline],
    preview.candidates,
    selected,
    'replace',
    true,
    '2026-07-31T00:00:00.000Z',
    idFactory,
  );
  expect(replaced).toMatchObject({ added: 1, replaced: 1, skipped: 0 });
  expect(replaced.hosts[0]).toMatchObject({
    id: 'existing-1',
    name: 'Moba DB',
    lastConnectionStatus: 'success',
    systemType: 'ubuntu',
  });
  expect(replaced.hosts.find((host) => host.address === 'web.example.com')?.password).toBe('plain-secret');

  const kept = planHostImport(
    [existingHost({ name: 'Moba DB' })],
    [preview.candidates[0]],
    new Set([preview.candidates[0].id]),
    'keepBoth',
    false,
    '2026-07-31T00:00:00.000Z',
    idFactory,
  );
  expect(kept).toMatchObject({ added: 1, replaced: 0, skipped: 0 });
  expect(kept.hosts[1].name).toBe('Moba DB (2)');
});

test('parses SecureCRT XML exports with multiple sessions', () => {
  const preview = parseHostImportFiles([
    {
      name: 'sessions.xml',
      parentName: 'Imported',
      content: [
        '<sessions>',
        '<session name="One"><key name="Hostname">one.example.com</key><key name="Username">root</key><key name="[SSH2] Port">22</key></session>',
        '<session name="Two"><Hostname>two.example.com</Hostname><Username>deploy</Username><Port>2222</Port></session>',
        '</sessions>',
      ].join(''),
    },
  ], []);
  expect(preview.candidates.map(({ name, address, port }) => ({ name, address, port }))).toEqual([
    { name: 'One', address: 'one.example.com', port: 22 },
    { name: 'Two', address: 'two.example.com', port: 2222 },
  ]);
});
