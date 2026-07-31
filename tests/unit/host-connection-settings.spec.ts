import { expect, test } from '@playwright/test';

import {
  createHostFromForm,
  emptyHostForm,
  getConnectTimeoutMs,
  normalizeStoredHost,
  toFormState,
  validateHostForm,
  type StoredHost,
} from '../../src/appHostModel';

const storedHost: StoredHost = {
  id: 'agent-host',
  name: 'Agent Host',
  address: 'agent.example.com',
  port: 22,
  username: 'deploy',
  authMethod: 'agent',
  password: 'stale-password',
  keyId: 'stale-key',
  keyPath: 'C:\\keys\\stale.pem',
  passphrase: 'stale-passphrase',
  connectTimeoutMs: 9_000,
  group: '',
  tags: [],
  note: '',
  createdAt: '2026-07-31T00:00:00.000Z',
  updatedAt: '2026-07-31T00:00:00.000Z',
};

test('normalizes saved SSH Agent hosts without retaining other authentication secrets', () => {
  const host = normalizeStoredHost(storedHost);

  expect(host.authMethod).toBe('agent');
  expect(host.password).toBe('');
  expect(host.keyId).toBe('');
  expect(host.keyPath).toBe('');
  expect(host.passphrase).toBe('');
  expect(host.connectTimeoutMs).toBe(9_000);
  expect(toFormState(host).connectTimeoutSeconds).toBe('9');
});

test('creates SSH Agent hosts with a per-host timeout and no credential material', () => {
  const host = createHostFromForm({
    ...emptyHostForm,
    name: 'Agent Host',
    address: 'agent.example.com',
    username: 'deploy',
    authMethod: 'agent',
    password: 'must-not-persist',
    keyId: 'must-not-persist',
    keyPath: 'must-not-persist',
    passphrase: 'must-not-persist',
    connectTimeoutSeconds: '27',
  }, null);

  expect(host).toMatchObject({
    authMethod: 'agent',
    password: '',
    keyId: '',
    keyPath: '',
    passphrase: '',
    connectTimeoutMs: 27_000,
  });
});

test('validates timeout overrides while allowing an empty inherited value', () => {
  const baseForm = {
    ...emptyHostForm,
    name: 'Timeout Host',
    address: 'timeout.example.com',
    username: 'root',
  };

  expect(validateHostForm(baseForm, [], [], null, [], 'en-US')).toBe('');
  expect(validateHostForm(
    { ...baseForm, connectTimeoutSeconds: '2' },
    [],
    [],
    null,
    [],
    'en-US',
  )).toContain('3 to 120');
  expect(validateHostForm(
    { ...baseForm, connectTimeoutSeconds: '121' },
    [],
    [],
    null,
    [],
    'en-US',
  )).toContain('3 to 120');
  expect(getConnectTimeoutMs(2_999)).toBe(0);
  expect(getConnectTimeoutMs(120_000)).toBe(120_000);
  expect(getConnectTimeoutMs(120_001)).toBe(0);
});
