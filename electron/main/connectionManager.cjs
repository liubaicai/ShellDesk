const { BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const net = require('node:net');
const { Duplex } = require('node:stream');
const { Client } = require('ssh2');
const {
  createPowerShellCommand,
  escapeShellSingleQuotedArg,
  quotePowerShellString,
  toErrorMessage,
} = require('./validation.cjs');

const activeConnections = new Map();
const connectionCleanupHandlers = new Set();
const clientConnectionMetadata = new WeakMap();

function normalizeSocksDestinationHost(host) {
  const normalizedHost = String(host || '').trim();
  const loweredHost = normalizedHost.toLowerCase();

  if (
    loweredHost === 'localhost' ||
    loweredHost === 'localhost.' ||
    loweredHost === '::1' ||
    loweredHost === '[::1]' ||
    loweredHost === '0:0:0:0:0:0:0:1' ||
    loweredHost === '[0:0:0:0:0:0:0:1]'
  ) {
    return '127.0.0.1';
  }

  return normalizedHost;
}

function registerConnectionCleanup(handler) {
  connectionCleanupHandlers.add(handler);
  return () => connectionCleanupHandlers.delete(handler);
}

function setClientConnectionMetadata(client, metadata) {
  if (!client || !metadata) {
    return;
  }

  clientConnectionMetadata.set(client, { ...metadata });
}

function getConnectionAddress(activeConnection) {
  const displayHost = activeConnection?.displayHost || {};
  const address = displayHost.address || 'unknown';
  const port = displayHost.port || 22;

  return `${address}:${port}`;
}

function isConnectionWindowAlive(activeConnection) {
  return Boolean(activeConnection?.window && !activeConnection.window.isDestroyed());
}

function notifyConnectionEvent(channel, payload) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  }
}

function connectSshClient(sshConfig) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const ignoreSettledError = () => undefined;

    const rejectConnection = (error) => {
      if (settled) {
        return;
      }

      if (error?.level === 'agent') {
        return;
      }

      settled = true;
      client.removeListener('error', rejectConnection);
      client.on('error', ignoreSettledError);
      client.end();
      reject(error);
    };

    client.once('ready', () => {
      settled = true;
      client.removeListener('error', rejectConnection);
      client.on('error', ignoreSettledError);
      resolve(client);
    });

    client.on('error', rejectConnection);

    try {
      client.connect(sshConfig);
    } catch (error) {
      rejectConnection(error);
    }
  });
}

function closeSshClient(client) {
  if (!client) {
    return;
  }

  try {
    client.removeAllListeners('close');
    client.removeAllListeners('error');
    client.on('error', () => undefined);
    client.end();
  } catch {
    // Ignore stale SSH client cleanup errors.
  }
}

function closeStream(stream) {
  if (!stream || stream.destroyed) {
    return;
  }

  try {
    stream.destroy();
  } catch {
    // Ignore stale stream cleanup errors.
  }
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatSshEndpoint(sshConfig) {
  return `${sshConfig?.username || 'unknown'}@${sshConfig?.host || 'unknown'}:${sshConfig?.port || 22}`;
}

function formatJumpHostLabel(jumpHost, jumpSshConfig) {
  if (jumpHost?.name) {
    return jumpHost.name;
  }

  return formatSshEndpoint(jumpSshConfig);
}

function getProxyLabel(proxyConfig) {
  if (!proxyConfig) {
    return '';
  }

  if (proxyConfig.type === 'command') {
    return 'ProxyCommand';
  }

  return `${String(proxyConfig.type || '').toUpperCase()} ${proxyConfig.host}:${proxyConfig.port}`;
}

function connectTcpSocket(host, port, label) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let settled = false;

    const finish = (callback) => {
      if (settled) {
        return;
      }

      settled = true;
      socket.setTimeout(0);
      socket.removeListener('connect', onConnect);
      socket.removeListener('error', onError);
      socket.removeListener('timeout', onTimeout);
      callback();
    };

    const onConnect = () => finish(() => resolve(socket));
    const onError = (error) => finish(() => {
      closeSocket(socket);
      reject(error);
    });
    const onTimeout = () => finish(() => {
      closeSocket(socket);
      reject(new Error(`${label}连接超时。`));
    });

    socket.setTimeout(15000);
    socket.once('connect', onConnect);
    socket.once('error', onError);
    socket.once('timeout', onTimeout);
  });
}

function writeSocket(socket, chunk) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      socket.removeListener('drain', onDrain);
      reject(error);
    };
    const onDrain = () => {
      socket.removeListener('error', onError);
      resolve();
    };

    socket.once('error', onError);
    if (socket.write(chunk)) {
      socket.removeListener('error', onError);
      resolve();
      return;
    }

    socket.once('drain', onDrain);
  });
}

async function readHttpProxyHeader(socket, reader) {
  const chunks = [];
  let length = 0;

  while (length < 32 * 1024) {
    const chunk = await reader.read(1);
    chunks.push(chunk);
    length += 1;

    const header = Buffer.concat(chunks, length);

    if (header.includes('\r\n\r\n')) {
      return header.toString('latin1');
    }
  }

  throw new Error('HTTP 代理响应头过大。');
}

async function createHttpProxySocket(proxyConfig, destinationHost, destinationPort) {
  const socket = await connectTcpSocket(proxyConfig.host, proxyConfig.port, 'HTTP 代理');
  const reader = createBufferedReader(socket);

  try {
    const authHeader = proxyConfig.username
      ? `Proxy-Authorization: Basic ${Buffer.from(`${proxyConfig.username}:${proxyConfig.password || ''}`, 'utf8').toString('base64')}\r\n`
      : '';
    await writeSocket(socket, Buffer.from(
      `CONNECT ${destinationHost}:${destinationPort} HTTP/1.1\r\n` +
      `Host: ${destinationHost}:${destinationPort}\r\n` +
      'Proxy-Connection: Keep-Alive\r\n' +
      authHeader +
      '\r\n',
      'utf8',
    ));
    const header = await readHttpProxyHeader(socket, reader);
    const statusLine = header.split(/\r\n/u)[0] || '';

    if (!/^HTTP\/\d(?:\.\d)?\s+2\d\d\b/i.test(statusLine)) {
      throw new Error(`HTTP 代理拒绝连接：${statusLine || '无状态行'}`);
    }

    const pending = reader.drain();
    reader.dispose();

    if (pending.length) {
      socket.unshift(pending);
    }

    return markTransport(socket, 'http-proxy');
  } catch (error) {
    reader.dispose();
    closeSocket(socket);
    throw error;
  }
}

function encodeSocksAddress(host) {
  const ipVersion = net.isIP(host);

  if (ipVersion === 4) {
    return Buffer.from([0x01, ...host.split('.').map((part) => Number(part))]);
  }

  if (ipVersion === 6) {
    const normalized = host.replace(/^\[|\]$/g, '');
    const sections = normalized.split(':');
    const emptyIndex = sections.indexOf('');
    let expanded = sections;

    if (emptyIndex !== -1) {
      const missing = 8 - (sections.length - 1);
      expanded = [
        ...sections.slice(0, emptyIndex),
        ...Array.from({ length: missing }, () => '0'),
        ...sections.slice(emptyIndex + 1),
      ];
    }

    const bytes = [];
    for (const section of expanded) {
      const value = Number.parseInt(section || '0', 16);
      bytes.push((value >> 8) & 0xff, value & 0xff);
    }

    return Buffer.from([0x04, ...bytes.slice(0, 16)]);
  }

  const hostBytes = Buffer.from(host, 'utf8');

  if (hostBytes.length > 255) {
    throw new Error('SOCKS5 目标主机名过长。');
  }

  return Buffer.concat([Buffer.from([0x03, hostBytes.length]), hostBytes]);
}

async function createSocks5ProxySocket(proxyConfig, destinationHost, destinationPort) {
  const socket = await connectTcpSocket(proxyConfig.host, proxyConfig.port, 'SOCKS5 代理');
  const reader = createBufferedReader(socket);

  try {
    const usePassword = Boolean(proxyConfig.username);
    await writeSocket(socket, Buffer.from(usePassword ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]));
    const methodResponse = await reader.read(2);

    if (methodResponse[0] !== 0x05 || methodResponse[1] === 0xff) {
      throw new Error('SOCKS5 代理没有可用认证方式。');
    }

    if (methodResponse[1] === 0x02) {
      const username = Buffer.from(proxyConfig.username || '', 'utf8');
      const password = Buffer.from(proxyConfig.password || '', 'utf8');

      if (username.length > 255 || password.length > 255) {
        throw new Error('SOCKS5 代理用户名或密码过长。');
      }

      await writeSocket(socket, Buffer.concat([Buffer.from([0x01, username.length]), username, Buffer.from([password.length]), password]));
      const authResponse = await reader.read(2);

      if (authResponse[1] !== 0x00) {
        throw new Error('SOCKS5 代理认证失败。');
      }
    } else if (methodResponse[1] !== 0x00) {
      throw new Error('SOCKS5 代理返回了不支持的认证方式。');
    }

    const portBytes = Buffer.alloc(2);
    portBytes.writeUInt16BE(destinationPort, 0);
    await writeSocket(socket, Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00]),
      encodeSocksAddress(destinationHost),
      portBytes,
    ]));

    const responseHead = await reader.read(4);

    if (responseHead[0] !== 0x05 || responseHead[1] !== 0x00) {
      throw new Error(`SOCKS5 代理连接失败，响应码 ${responseHead[1] ?? 'unknown'}。`);
    }

    if (responseHead[3] === 0x01) {
      await reader.read(4);
    } else if (responseHead[3] === 0x03) {
      const length = (await reader.read(1))[0];
      await reader.read(length);
    } else if (responseHead[3] === 0x04) {
      await reader.read(16);
    } else {
      throw new Error('SOCKS5 代理响应地址类型无效。');
    }

    await reader.read(2);
    const pending = reader.drain();
    reader.dispose();

    if (pending.length) {
      socket.unshift(pending);
    }

    return markTransport(socket, 'socks5-proxy');
  } catch (error) {
    reader.dispose();
    closeSocket(socket);
    throw error;
  }
}

function createProxyCommandSocket(proxyConfig, destinationHost, destinationPort) {
  const command = String(proxyConfig.command || '')
    .replace(/\{host\}|%h/gu, destinationHost)
    .replace(/\{port\}|%p/gu, String(destinationPort))
    .trim();

  if (!command) {
    throw new Error('ProxyCommand 不能为空。');
  }

  const child = spawn(command, {
    shell: true,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderrChunks = [];

  const stream = new Duplex({
    read() {},
    write(chunk, encoding, callback) {
      if (!child.stdin.writable) {
        callback(new Error('ProxyCommand 标准输入不可写。'));
        return;
      }

      if (child.stdin.write(chunk, encoding)) {
        callback();
        return;
      }

      child.stdin.once('drain', callback);
    },
    final(callback) {
      child.stdin.end();
      callback();
    },
    destroy(error, callback) {
      if (!child.killed) {
        child.kill();
      }

      callback(error);
    },
  });

  child.stdout.on('data', (chunk) => {
    stream.push(chunk);
  });
  child.stderr.on('data', (chunk) => {
    if (Buffer.concat(stderrChunks).length < 8192) {
      stderrChunks.push(Buffer.from(chunk));
    }
  });
  child.once('error', (error) => {
    stream.destroy(error);
  });
  child.once('exit', (code) => {
    if (code && !stream.destroyed) {
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      stream.destroy(new Error(stderr || `ProxyCommand 已退出，退出码 ${code}。`));
      return;
    }

    stream.push(null);
  });

  return markTransport(stream, 'proxy-command');
}

async function createProxySocket(proxyConfig, destinationHost, destinationPort) {
  if (!proxyConfig) {
    return null;
  }

  if (proxyConfig.type === 'http') {
    return createHttpProxySocket(proxyConfig, destinationHost, destinationPort);
  }

  if (proxyConfig.type === 'socks5') {
    return createSocks5ProxySocket(proxyConfig, destinationHost, destinationPort);
  }

  if (proxyConfig.type === 'command') {
    return createProxyCommandSocket(proxyConfig, destinationHost, destinationPort);
  }

  throw new Error('代理类型无效。');
}

function readProxyTestHttpHeader(stream, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeoutId);
      stream.removeListener('data', onData);
      stream.removeListener('error', onError);
      stream.removeListener('close', onClose);
      stream.removeListener('end', onClose);
    };

    const finish = (callback) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      callback();
    };

    const onData = (chunk) => {
      chunks.push(Buffer.from(chunk));
      length += chunk.length;

      if (length > 64 * 1024) {
        finish(() => reject(new Error('代理测试响应过大。')));
        return;
      }

      const header = Buffer.concat(chunks, length).toString('latin1');

      if (header.includes('\r\n\r\n') || header.includes('\n\n')) {
        finish(() => resolve(header));
      }
    };

    const onError = (error) => finish(() => reject(error));
    const onClose = () => finish(() => reject(new Error('代理已连接，但测试目标未返回响应。')));
    const timeoutId = setTimeout(() => {
      finish(() => reject(new Error('代理测试超时。')));
    }, timeoutMs);

    stream.on('data', onData);
    stream.once('error', onError);
    stream.once('close', onClose);
    stream.once('end', onClose);
  });
}

function readProxyTestSshBanner(stream, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeoutId);
      stream.removeListener('data', onData);
      stream.removeListener('error', onError);
      stream.removeListener('close', onClose);
      stream.removeListener('end', onClose);
    };

    const finish = (callback) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      callback();
    };

    const inspectBuffer = () => {
      const text = Buffer.concat(chunks, length).toString('latin1');
      const bannerMatch = text.match(/(?:^|\r?\n)(SSH-\d+\.\d+-[^\r\n]*)/u);

      if (bannerMatch) {
        finish(() => resolve(bannerMatch[1]));
        return;
      }

      if (/^(?:HTTP\/|<!doctype html|<html\b)/iu.test(text.trimStart())) {
        finish(() => reject(new Error('代理已连接，但测试目标响应不是 SSH 服务。')));
        return;
      }

      if (length > 8192) {
        finish(() => reject(new Error('代理已连接，但目标 SSH 服务未返回有效握手 banner。')));
      }
    };

    const onData = (chunk) => {
      chunks.push(Buffer.from(chunk));
      length += chunk.length;
      inspectBuffer();
    };

    const onError = (error) => finish(() => reject(error));
    const onClose = () => finish(() => reject(new Error('代理已连接，但目标 SSH 服务未返回握手 banner。')));
    const timeoutId = setTimeout(() => {
      finish(() => reject(new Error('代理已连接，但等待目标 SSH 握手超时。')));
    }, timeoutMs);

    stream.on('data', onData);
    stream.once('error', onError);
    stream.once('close', onClose);
    stream.once('end', onClose);
  });
}

async function testProxyConfig(proxyConfig, target = {}) {
  const targetKind = target.kind === 'ssh' ? 'ssh' : 'http';
  const targetHost = String(target.host || 'example.com').trim() || 'example.com';
  const targetPort = Number(target.port) || (targetKind === 'ssh' ? 22 : 80);
  const timeoutMs = Math.min(Math.max(Number(target.timeoutMs) || 15000, 3000), 30000);
  const startedAt = Date.now();
  let stream = null;

  try {
    stream = await createProxySocket(proxyConfig, targetHost, targetPort);

    if (!stream) {
      throw new Error('代理配置为空。');
    }

    if (targetKind === 'ssh') {
      await readProxyTestSshBanner(stream, timeoutMs);

      return {
        ok: true,
        targetHost,
        targetPort,
        latencyMs: Date.now() - startedAt,
        checkedAt: new Date().toISOString(),
        error: '',
      };
    }

    await wait(40);
    await writeSocket(stream, Buffer.from(
      `HEAD / HTTP/1.1\r\nHost: ${targetHost}\r\nConnection: close\r\n\r\n`,
      'utf8',
    ));
    const header = await readProxyTestHttpHeader(stream, timeoutMs);
    const statusLine = header.split(/\r?\n/u)[0] || '';

    if (!/^HTTP\/\d(?:\.\d)?\s+\d{3}\b/i.test(statusLine)) {
      throw new Error('代理已连接，但测试目标响应不是有效 HTTP。');
    }

    return {
      ok: true,
      targetHost,
      targetPort,
      latencyMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
      error: '',
    };
  } catch (error) {
    return {
      ok: false,
      targetHost,
      targetPort,
      latencyMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
      error: toErrorMessage(error),
    };
  } finally {
    closeStream(stream);
  }
}

async function connectSshClientWithProxy(sshConfig, proxyConfig, label) {
  if (!proxyConfig) {
    return connectSshClient(sshConfig);
  }

  console.info(`[shelldesk] SSH connect via proxy ${getProxyLabel(proxyConfig)} -> ${formatSshEndpoint(sshConfig)}`);
  const sock = await createProxySocket(proxyConfig, sshConfig.host, sshConfig.port);

  try {
    return await connectSshClient({
      ...sshConfig,
      sock,
    });
  } catch (error) {
    closeStream(sock);
    throw new Error(`${label}通过代理连接失败：${toErrorMessage(error)}`);
  }
}

async function connectSshClientWithJump(sshConfig, jumpSshConfig = null, jumpHost = null, proxyConfig = null, jumpProxyConfig = null) {
  if (!jumpSshConfig) {
    if (!proxyConfig) {
      console.info(`[shelldesk] SSH connect direct ${formatSshEndpoint(sshConfig)}`);
    }

    return {
      client: await connectSshClientWithProxy(sshConfig, proxyConfig, '目标主机'),
      jumpClient: null,
    };
  }

  const jumpLabel = formatJumpHostLabel(jumpHost, jumpSshConfig);
  console.info(`[shelldesk] SSH connect via jump ${jumpLabel} (${formatSshEndpoint(jumpSshConfig)}) -> ${formatSshEndpoint(sshConfig)}`);

  let jumpClient = null;
  let targetStream = null;

  try {
    jumpClient = await connectSshClientWithProxy(jumpSshConfig, jumpProxyConfig, `跳板机「${jumpLabel}」`);
  } catch (error) {
    throw new Error(`跳板机「${jumpLabel}」连接失败：${toErrorMessage(error)}`);
  }

  try {
    targetStream = await forwardOut(jumpClient, sshConfig.host, sshConfig.port);
  } catch (error) {
    closeSshClient(jumpClient);
    throw new Error(`跳板机「${jumpLabel}」无法转发到目标 ${formatSshEndpoint(sshConfig)}：${toErrorMessage(error)}`);
  }

  try {
    const client = await connectSshClient({
      ...sshConfig,
      sock: targetStream,
    });

    return {
      client,
      jumpClient,
    };
  } catch (error) {
    closeStream(targetStream);
    closeSshClient(jumpClient);
    throw new Error(`通过跳板机「${jumpLabel}」连接目标 ${formatSshEndpoint(sshConfig)} 失败：${toErrorMessage(error)}`);
  }
}

function cleanupTerminalSessions(activeConnection) {
  if (!activeConnection.terminalSessions) {
    return;
  }

  for (const stream of activeConnection.terminalSessions.values()) {
    stream.removeAllListeners();
    stream.on('error', () => undefined);
    try {
      stream.end();
    } catch {
      try {
        stream.destroy();
      } catch {
        // Ignore stale terminal stream cleanup errors.
      }
    }
  }

  activeConnection.terminalSessions.clear();
}

function isRecoverableSshError(error) {
  const message = toErrorMessage(error);

  return /Channel open failure|open failed|Not connected|No response from server|Cannot open channel|Unable to open channel|Unable to open session/i.test(message);
}

function markActiveConnectionDisconnected(activeConnection, reason) {
  if (!activeConnection || activeConnection.isClosing) {
    return;
  }

  activeConnection.clientOnline = false;
  activeConnection.disconnectedAt = new Date().toISOString();
  activeConnection.lastDisconnectReason = reason || 'SSH 连接已断开。';
  cleanupTerminalSessions(activeConnection);
  closeSshClient(activeConnection.jumpClient);
  activeConnection.jumpClient = null;
  notifyConnectionClosed(activeConnection.id, activeConnection.lastDisconnectReason);
}

function bindActiveConnectionClient(activeConnection, client) {
  if (!activeConnection || !client) {
    return;
  }

  activeConnection.client = client;
  activeConnection.clientOnline = true;
  activeConnection.disconnectedAt = '';
  activeConnection.lastDisconnectReason = '';
  setClientConnectionMetadata(client, { systemType: activeConnection.displayHost?.systemType });

  client.on('error', (err) => {
    console.warn(`[shelldesk] SSH error ${getConnectionAddress(activeConnection)}:`, toErrorMessage(err));
  });

  client.once('close', (hadError) => {
    const currentConnection = activeConnections.get(activeConnection.id);

    if (
      currentConnection !== activeConnection ||
      activeConnection.client !== client ||
      activeConnection.isClosing
    ) {
      return;
    }

    const address = getConnectionAddress(activeConnection);
    const reason = hadError
      ? `SSH 连接异常断开 (${address})`
      : `SSH 连接已断开 (${address})`;

    console.info(`[shelldesk] SSH close ${address} hadError=${Boolean(hadError)}`);
    markActiveConnectionDisconnected(activeConnection, reason);
  });
}

async function reconnectActiveConnection(activeConnection, reason = 'SSH 连接已断开。') {
  if (!activeConnection) {
    throw new Error('连接已断开，请重新连接。');
  }

  if (!isConnectionWindowAlive(activeConnection)) {
    throw new Error('连接窗口已关闭，不再自动重连。');
  }

  if (!activeConnection.sshConfig) {
    throw new Error('缺少 SSH 重连配置，请重新连接。');
  }

  if (activeConnection.reconnectPromise) {
    return activeConnection.reconnectPromise;
  }

  activeConnection.reconnectPromise = (async () => {
    const oldClient = activeConnection.client;
    const oldJumpClient = activeConnection.jumpClient;
    activeConnection.clientOnline = false;
    notifyConnectionEvent('connection:reconnecting', {
      connectionId: activeConnection.id,
      reason,
      startedAt: new Date().toISOString(),
    });

    closeSshClient(oldClient);
    closeSshClient(oldJumpClient);
    activeConnection.jumpClient = null;

    const { client: nextClient, jumpClient: nextJumpClient } = await connectSshClientWithJump(
      activeConnection.sshConfig,
      activeConnection.jumpSshConfig,
      activeConnection.jumpHost,
      activeConnection.proxyConfig,
      activeConnection.jumpProxyConfig,
    );

    if (
      activeConnections.get(activeConnection.id) !== activeConnection ||
      !isConnectionWindowAlive(activeConnection)
    ) {
      closeSshClient(nextClient);
      closeSshClient(nextJumpClient);
      throw new Error('连接窗口已关闭，不再自动重连。');
    }

    activeConnection.jumpClient = nextJumpClient;
    bindActiveConnectionClient(activeConnection, nextClient);
    activeConnection.reconnectedAt = new Date().toISOString();
    notifyConnectionEvent('connection:restored', {
      connectionId: activeConnection.id,
      restoredAt: activeConnection.reconnectedAt,
    });

    return activeConnection;
  })().catch((error) => {
    activeConnection.clientOnline = false;
    activeConnection.lastDisconnectReason = `SSH 自动重连失败：${toErrorMessage(error)}`;
    throw error;
  }).finally(() => {
    activeConnection.reconnectPromise = null;
  });

  return activeConnection.reconnectPromise;
}

async function ensureActiveConnectionClient(connectionId) {
  const activeConnection = getActiveConnection(connectionId);

  if (activeConnection.clientOnline && activeConnection.client) {
    return activeConnection;
  }

  return reconnectActiveConnection(
    activeConnection,
    activeConnection.lastDisconnectReason || 'SSH 连接已断开，正在自动重连。',
  );
}

async function withActiveConnectionClientRetry(connectionId, operation) {
  const activeConnection = await ensureActiveConnectionClient(connectionId);

  try {
    return await operation(activeConnection);
  } catch (error) {
    if (!isRecoverableSshError(error)) {
      throw error;
    }

    const reason = `SSH 通道不可用，正在自动重连：${toErrorMessage(error)}`;
    markActiveConnectionDisconnected(activeConnection, reason);
    const reconnectedConnection = await reconnectActiveConnection(activeConnection, reason);

    return operation(reconnectedConnection);
  }
}

function createBufferedReader(socket) {
  let buffer = Buffer.alloc(0);
  let waiters = [];
  let closedError = null;

  const flush = () => {
    while (waiters.length) {
      const waiter = waiters[0];

      if (buffer.length >= waiter.size) {
        const chunk = buffer.subarray(0, waiter.size);
        buffer = buffer.subarray(waiter.size);
        waiters = waiters.slice(1);
        waiter.resolve(chunk);
        continue;
      }

      if (closedError) {
        waiters = waiters.slice(1);
        waiter.reject(closedError);
        continue;
      }

      break;
    }
  };

  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    flush();
  };

  const onError = (error) => {
    closedError = error;
    flush();
  };

  const onClose = () => {
    closedError = closedError ?? new Error('SOCKS 客户端已关闭。');
    flush();
  };

  socket.on('data', onData);
  socket.once('error', onError);
  socket.once('close', onClose);

  return {
    read(size) {
      if (buffer.length >= size) {
        const chunk = buffer.subarray(0, size);
        buffer = buffer.subarray(size);
        return Promise.resolve(chunk);
      }

      if (closedError) {
        return Promise.reject(closedError);
      }

      return new Promise((resolve, reject) => {
        waiters.push({ size, resolve, reject });
      });
    },
    drain() {
      const pending = buffer;
      buffer = Buffer.alloc(0);
      return pending;
    },
    dispose() {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    },
  };
}

function closeSocket(socket) {
  if (!socket.destroyed) {
    socket.destroy();
  }
}

function sendSocksReply(socket, code) {
  if (!socket.destroyed) {
    socket.write(Buffer.from([0x05, code, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
  }
}

function randomSourcePort() {
  return 1024 + crypto.randomInt(0, 64511);
}

function formatIpv6Address(bytes) {
  const parts = [];

  for (let index = 0; index < 16; index += 2) {
    parts.push(bytes.readUInt16BE(index).toString(16));
  }

  return parts.join(':');
}

function createUnixTcpRelayCommand(host, port) {
  const hostArg = escapeShellSingleQuotedArg(host);
  const portArg = escapeShellSingleQuotedArg(String(port));
  const script = `
host=${hostArg}
port=${portArg}
if command -v nc >/dev/null 2>&1; then
  exec nc "$host" "$port"
fi
if command -v ncat >/dev/null 2>&1; then
  exec ncat "$host" "$port"
fi
if command -v socat >/dev/null 2>&1; then
  exec socat - "TCP:\${host}:$port"
fi
if command -v bash >/dev/null 2>&1; then
  exec bash -c 'exec 3<>"/dev/tcp/$1/$2"; cat <&3 & cat >&3; wait' sh "$host" "$port"
fi
printf '%s\\n' 'ShellDesk: SSH TCP forwarding failed and no remote TCP relay command was found. Install nc, ncat, socat, or enable Bash /dev/tcp.' >&2
exit 127
`;

  return `sh -lc ${escapeShellSingleQuotedArg(script)}`;
}

function createWindowsTcpRelayCommand(host, port) {
  return createPowerShellCommand(`
$hostName = ${quotePowerShellString(host)}
$port = ${Number(port)}
$client = [System.Net.Sockets.TcpClient]::new()
try {
  $client.Connect($hostName, $port)
  $network = $client.GetStream()
  $stdin = [Console]::OpenStandardInput()
  $stdout = [Console]::OpenStandardOutput()
  $toRemote = $stdin.CopyToAsync($network)
  $fromRemote = $network.CopyToAsync($stdout)
  [System.Threading.Tasks.Task]::WaitAny(@($toRemote, $fromRemote)) | Out-Null
} finally {
  try { $client.Close() } catch {}
}
`);
}

function markTransport(stream, transport, details = {}) {
  Object.defineProperties(stream, {
    shellDeskTransport: { value: transport, enumerable: false },
    shellDeskTransportDetails: { value: details, enumerable: false },
  });

  return stream;
}

function openSshTcpStream(client, destinationHost, destinationPort, sourcePort) {
  return new Promise((resolve, reject) => {
    try {
      client.forwardOut('127.0.0.1', sourcePort, destinationHost, destinationPort, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(stream);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function openExecTcpRelayStream(client, destinationHost, destinationPort, tunnelError) {
  const metadata = clientConnectionMetadata.get(client) || {};
  const command = metadata.systemType === 'windows'
    ? createWindowsTcpRelayCommand(destinationHost, destinationPort)
    : createUnixTcpRelayCommand(destinationHost, destinationPort);

  return new Promise((resolve, reject) => {
    try {
      client.exec(command, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }

        const stderrChunks = [];
        let stderrLength = 0;
        let settled = false;

        const getStderr = () => Buffer.concat(stderrChunks).toString('utf8').trim();

        const finish = (callback) => {
          if (settled) {
            return;
          }

          settled = true;
          clearTimeout(readyTimer);
          callback();
        };

        const readyTimer = setTimeout(() => {
          finish(() => {
            resolve(markTransport(stream, 'ssh-exec', {
              tunnelError,
              getStderr,
            }));
          });
        }, 50);

        stream.on('error', (streamError) => {
          finish(() => reject(streamError));
        });
        stream.once('close', (code) => {
          finish(() => reject(new Error(getStderr() || `远程 TCP 代理已退出，退出码 ${code ?? 'unknown'}。`)));
        });
        stream.stderr.on('data', (chunk) => {
          if (stderrLength >= 8192) {
            return;
          }

          const buffer = Buffer.from(chunk);
          stderrLength += buffer.length;
          stderrChunks.push(buffer);
        });
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function forwardOut(client, destinationHost, destinationPort, sourcePort = randomSourcePort()) {
  try {
    const stream = await openSshTcpStream(client, destinationHost, destinationPort, sourcePort);
    return markTransport(stream, 'ssh-tunnel');
  } catch (tunnelError) {
    try {
      return await openExecTcpRelayStream(client, destinationHost, destinationPort, tunnelError);
    } catch (relayError) {
      console.warn(`[shelldesk] SSH TCP forwarding and exec relay failed for ${destinationHost}:${destinationPort}: ${toErrorMessage(relayError)}`);
      throw new Error(`SSH TCP 转发失败，远程 TCP 代理也无法启动：${toErrorMessage(relayError)}。请确认服务器允许 TCP 转发，或远端安装 nc/ncat/socat。原始转发错误：${toErrorMessage(tunnelError)}`);
    }
  }
}

async function resolveSocksClient(clientOrProvider) {
  return typeof clientOrProvider === 'function' ? await clientOrProvider() : clientOrProvider;
}

async function handleSocksClient(clientOrProvider, socket) {
  const reader = createBufferedReader(socket);

  try {
    socket.setNoDelay(true);

    const greetingHead = await reader.read(2);
    const version = greetingHead[0];
    const methodCount = greetingHead[1];

    if (version !== 0x05 || methodCount < 1) {
      closeSocket(socket);
      return;
    }

    const methods = await reader.read(methodCount);
    if (!methods.includes(0x00)) {
      socket.write(Buffer.from([0x05, 0xff]));
      closeSocket(socket);
      return;
    }

    socket.write(Buffer.from([0x05, 0x00]));

    const requestHead = await reader.read(4);
    const command = requestHead[1];
    const addressType = requestHead[3];

    if (requestHead[0] !== 0x05 || command !== 0x01) {
      sendSocksReply(socket, 0x07);
      closeSocket(socket);
      return;
    }

    let destinationHost = '';

    if (addressType === 0x01) {
      destinationHost = Array.from(await reader.read(4)).join('.');
    } else if (addressType === 0x03) {
      const length = (await reader.read(1))[0];
      destinationHost = (await reader.read(length)).toString('utf8');
    } else if (addressType === 0x04) {
      destinationHost = formatIpv6Address(await reader.read(16));
    } else {
      sendSocksReply(socket, 0x08);
      closeSocket(socket);
      return;
    }

    const portBytes = await reader.read(2);
    const destinationPort = portBytes.readUInt16BE(0);
    destinationHost = normalizeSocksDestinationHost(destinationHost);

    if (!destinationHost || destinationPort < 1 || destinationPort > 65535) {
      sendSocksReply(socket, 0x04);
      closeSocket(socket);
      return;
    }

    const target = `${destinationHost}:${destinationPort}`;
    console.info(`[shelldesk] SOCKS CONNECT ${target}`);

    let stream;
    try {
      const client = await resolveSocksClient(clientOrProvider);
      stream = await forwardOut(client, destinationHost, destinationPort);
    } catch (error) {
      console.warn(`[shelldesk] SOCKS CONNECT failed ${target}: ${toErrorMessage(error)}`);
      throw error;
    }

    const pending = reader.drain();
    reader.dispose();

    sendSocksReply(socket, 0x00);

    if (pending.length) {
      stream.write(pending);
    }

    stream.once('close', () => closeSocket(socket));
    stream.once('error', () => closeSocket(socket));
    socket.once('error', () => stream.destroy());
    socket.pipe(stream).pipe(socket);
  } catch {
    reader.dispose();
    sendSocksReply(socket, 0x01);
    closeSocket(socket);
  }
}

function createSocksProxy(clientOrProvider) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      void handleSocksClient(clientOrProvider, socket);
    });

    const fail = (error) => {
      server.removeListener('listening', ready);
      reject(error);
    };

    const ready = () => {
      server.removeListener('error', fail);
      server.on('error', () => undefined);
      const address = server.address();

      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('SOCKS 代理启动失败。'));
        return;
      }

      resolve({ server, port: address.port });
    };

    server.once('error', fail);
    server.once('listening', ready);
    server.listen(0, '127.0.0.1');
  });
}

function getActiveConnection(connectionId) {
  if (typeof connectionId !== 'string' || !connectionId) {
    throw new Error('连接标识无效。');
  }

  const activeConnection = activeConnections.get(connectionId);

  if (!activeConnection) {
    throw new Error('连接已断开，请重新连接。');
  }

  return activeConnection;
}

function notifyConnectionClosed(connectionId, reason) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send('connection:closed', { connectionId, reason });
    }
  }
}

function closeServer(server) {
  if (!server) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

async function closeActiveConnection(connectionId, reason = '连接已断开。', fromClientClose = false) {
  const activeConnection = activeConnections.get(connectionId);

  if (!activeConnection) {
    return false;
  }

  activeConnections.delete(connectionId);
  activeConnection.isClosing = true;
  if (activeConnection.terminalSessions) {
    for (const stream of activeConnection.terminalSessions.values()) {
      stream.removeAllListeners();
      stream.on('error', () => undefined);
      stream.end();
    }
  }


  for (const cleanup of connectionCleanupHandlers) {
    try {
      await cleanup(connectionId);
    } catch (error) {
      console.warn(`[shelldesk] connection cleanup failed ${connectionId}:`, toErrorMessage(error));
    }
  }

  await closeServer(activeConnection.socksServer);

  if (!fromClientClose) {
    closeSshClient(activeConnection.client);
  }

  closeSshClient(activeConnection.jumpClient);

  notifyConnectionClosed(connectionId, reason);

  return true;
}

function toConnectionInfo(activeConnection) {
  return {
    id: activeConnection.id,
    partition: activeConnection.partition,
    proxyPort: activeConnection.proxyPort,
    connectedAt: activeConnection.connectedAt,
    host: activeConnection.displayHost,
  };
}

module.exports = {
  activeConnections,
  bindActiveConnectionClient,
  closeActiveConnection,
  connectSshClientWithJump,
  createBufferedReader,
  createSocksProxy,
  ensureActiveConnectionClient,
  forwardOut,
  getActiveConnection,
  registerConnectionCleanup,
  testProxyConfig,
  toConnectionInfo,
  withActiveConnectionClientRetry,
};
