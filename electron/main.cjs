const { app, BrowserWindow, dialog, ipcMain, nativeTheme, session, shell } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { Client } = require('ssh2');

const devServerUrl = process.env.VITE_DEV_SERVER_URL;
const activeConnections = new Map();

nativeTheme.themeSource = 'dark';

function toErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }

  return '操作失败。';
}

function toConnectionErrorMessage(error) {
  const message = toErrorMessage(error);

  if (/All configured authentication methods failed/i.test(message)) {
    return 'SSH 认证失败：请检查用户名、密码、私钥或密钥口令，或确认服务器允许当前认证方式。';
  }

  if (/Cannot parse privateKey|Encrypted private OpenSSH key detected|passphrase/i.test(message)) {
    return 'SSH 私钥读取失败：请确认私钥文件格式正确；如果私钥已加密，请填写密钥口令。';
  }

  if (/ECONNREFUSED|Connection refused/i.test(message)) {
    return 'SSH 连接被拒绝：请检查主机地址、端口和 sshd 服务状态。';
  }

  if (/Timed out|readyTimeout|ETIMEDOUT/i.test(message)) {
    return 'SSH 连接超时：请检查网络连通性、防火墙和端口。';
  }

  return message;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readBoundedString(value, label, maxLength, options = {}) {
  const { required = true, trim = true, rejectLineBreaks = true } = options;

  if (typeof value !== 'string') {
    throw new Error(`${label}无效。`);
  }

  const nextValue = trim ? value.trim() : value;

  if (required && !nextValue) {
    throw new Error(`请输入${label}。`);
  }

  if (nextValue.length > maxLength || nextValue.includes('\0') || (rejectLineBreaks && /[\r\n]/.test(nextValue))) {
    throw new Error(`${label}无效。`);
  }

  return nextValue;
}

function validateHostRequest(rawHost) {
  if (!isPlainObject(rawHost)) {
    throw new Error('主机信息无效。');
  }

  const name = readBoundedString(rawHost.name ?? '', '主机名称', 80, { required: false });
  const host = readBoundedString(rawHost.address, '主机地址', 255);
  const username = readBoundedString(rawHost.username, '用户名', 128);
  const port = Number(rawHost.port);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('端口必须是 1 到 65535 之间的整数。');
  }

  if (rawHost.authMethod !== 'password' && rawHost.authMethod !== 'key') {
    throw new Error('登录方式无效。');
  }

  const sshConfig = {
    host,
    port,
    username,
    readyTimeout: 15000,
    keepaliveInterval: 10000,
    keepaliveCountMax: 3,
  };

  if (rawHost.authMethod === 'password') {
    const password = readBoundedString(rawHost.password ?? '', 'SSH 密码', 4096, {
      trim: false,
      rejectLineBreaks: false,
    });
    sshConfig.password = password;
  } else {
    const keyPath = readBoundedString(rawHost.keyPath, 'SSH 私钥路径', 1024);
    sshConfig.privateKey = fs.readFileSync(keyPath);

    if (typeof rawHost.passphrase === 'string' && rawHost.passphrase) {
      sshConfig.passphrase = readBoundedString(rawHost.passphrase, 'SSH 密钥口令', 4096, {
        trim: false,
        rejectLineBreaks: false,
      });
    }
  }

  return {
    displayHost: {
      name: name || host,
      address: host,
      port,
      username,
      authMethod: rawHost.authMethod,
    },
    sshConfig,
  };
}

function connectSshClient(sshConfig) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;

    const rejectConnection = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      reject(error);
    };

    client.once('ready', () => {
      settled = true;
      client.removeListener('error', rejectConnection);
      client.on('error', () => undefined);
      resolve(client);
    });

    client.once('error', rejectConnection);
    client.connect(sshConfig);
  });
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

function forwardOut(client, destinationHost, destinationPort) {
  return new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', randomSourcePort(), destinationHost, destinationPort, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(stream);
    });
  });
}

async function handleSocksClient(client, socket) {
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

    if (!destinationHost || destinationPort < 1 || destinationPort > 65535) {
      sendSocksReply(socket, 0x04);
      closeSocket(socket);
      return;
    }

    const target = `${destinationHost}:${destinationPort}`;
    console.info(`[gui-ssh] SOCKS CONNECT ${target}`);

    let stream;
    try {
      stream = await forwardOut(client, destinationHost, destinationPort);
    } catch (error) {
      console.warn(`[gui-ssh] SOCKS CONNECT failed ${target}: ${toErrorMessage(error)}`);
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

function createSocksProxy(client) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      void handleSocksClient(client, socket);
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

  if (activeConnection.terminalSessions) {
    for (const stream of activeConnection.terminalSessions.values()) {
      stream.removeAllListeners();
      stream.end();
    }
  }

  await closeServer(activeConnection.socksServer);

  if (!fromClientClose) {
    activeConnection.client.end();
  }

  notifyConnectionClosed(connectionId, reason);
  return true;
}

function validateRemotePath(rawPath) {
  const remotePath = typeof rawPath === 'string' && rawPath.trim() ? rawPath.trim() : '.';

  if (remotePath.length > 4096 || remotePath.includes('\0')) {
    throw new Error('远程路径无效。');
  }

  return remotePath;
}

function validateMutableRemotePath(rawPath) {
  const remotePath = validateRemotePath(rawPath);

  if (remotePath === '.' || remotePath === '/' || remotePath === '~') {
    throw new Error('不允许对该远程路径执行管理操作。');
  }

  return remotePath;
}

function validateTerminalId(rawTerminalId) {
  const terminalId = readBoundedString(rawTerminalId, '终端标识', 120);

  if (!/^[a-zA-Z0-9:_-]+$/.test(terminalId)) {
    throw new Error('终端标识无效。');
  }

  return terminalId;
}

function getSftpEntryType(attrs) {
  const mode = attrs.mode ?? 0;
  const fileType = mode & 0o170000;

  if (fileType === 0o040000) {
    return 'directory';
  }

  if (fileType === 0o120000) {
    return 'symlink';
  }

  return 'file';
}

function listRemoteDirectory(client, remotePath) {
  return new Promise((resolve, reject) => {
    client.sftp((sftpError, sftp) => {
      if (sftpError) {
        reject(sftpError);
        return;
      }

      sftp.readdir(remotePath, (readError, entries) => {
        sftp.end();

        if (readError) {
          reject(readError);
          return;
        }

        resolve(
          entries
            .filter((entry) => entry.filename !== '.' && entry.filename !== '..')
            .map((entry) => ({
              name: entry.filename,
              longname: entry.longname,
              type: getSftpEntryType(entry.attrs),
              size: entry.attrs.size ?? 0,
              modifiedAt: entry.attrs.mtime ? new Date(entry.attrs.mtime * 1000).toISOString() : '',
            }))
            .sort((left, right) => {
              if (left.type === right.type) {
                return left.name.localeCompare(right.name, 'zh-CN');
              }

              return left.type === 'directory' ? -1 : 1;
            }),
        );
      });
    });
  });
}

function createRemoteDirectory(client, remotePath) {
  return new Promise((resolve, reject) => {
    client.sftp((sftpError, sftp) => {
      if (sftpError) {
        reject(sftpError);
        return;
      }

      sftp.mkdir(remotePath, (mkdirError) => {
        sftp.end();

        if (mkdirError) {
          reject(mkdirError);
          return;
        }

        resolve(true);
      });
    });
  });
}

function deleteRemotePath(client, remotePath, entryType) {
  return new Promise((resolve, reject) => {
    client.sftp((sftpError, sftp) => {
      if (sftpError) {
        reject(sftpError);
        return;
      }

      const finish = (deleteError) => {
        sftp.end();

        if (deleteError) {
          reject(deleteError);
          return;
        }

        resolve(true);
      };

      if (entryType === 'directory') {
        sftp.rmdir(remotePath, finish);
      } else {
        sftp.unlink(remotePath, finish);
      }
    });
  });
}

function execRemoteCommand(client, command) {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }

      let output = '';
      let errorOutput = '';
      const append = (chunk, isError = false) => {
        const value = chunk.toString('utf8');

        if (isError) {
          errorOutput = `${errorOutput}${value}`.slice(0, 65536);
        } else {
          output = `${output}${value}`.slice(0, 65536);
        }
      };

      stream.on('data', (chunk) => append(chunk));
      stream.stderr.on('data', (chunk) => append(chunk, true));
      stream.once('close', () => {
        resolve(`${output}${errorOutput ? `\n${errorOutput}` : ''}`.trim());
      });
      stream.once('error', reject);
    });
  });
}

async function getRemoteStatus(client) {
  const commands = [
    { key: 'hostname', label: '主机名', command: 'hostname 2>/dev/null || uname -n' },
    { key: 'user', label: '当前用户', command: 'whoami 2>/dev/null || id -un' },
    { key: 'kernel', label: '系统内核', command: 'uname -a' },
    { key: 'uptime', label: '运行时间', command: 'uptime' },
    { key: 'disk', label: '根分区', command: 'df -h / 2>/dev/null || df -h' },
    { key: 'memory', label: '内存', command: 'free -m 2>/dev/null || vm_stat 2>/dev/null || echo unavailable' },
    { key: 'network', label: '网络接口', command: 'ip -brief address 2>/dev/null || ifconfig 2>/dev/null || echo unavailable' },
  ];

  const items = await Promise.all(
    commands.map(async (item) => {
      try {
        const value = await execRemoteCommand(client, item.command);
        return { key: item.key, label: item.label, value: value || '无输出' };
      } catch (error) {
        return { key: item.key, label: item.label, value: `读取失败：${toErrorMessage(error)}` };
      }
    }),
  );

  return { refreshedAt: new Date().toISOString(), items };
}

function registerIpcHandler(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...args);
    } catch (error) {
      throw new Error(toErrorMessage(error));
    }
  });
}

function isSafeNavigation(targetUrl) {
  if (!targetUrl) {
    return false;
  }

  if (devServerUrl && targetUrl.startsWith(devServerUrl)) {
    return true;
  }

  return targetUrl.startsWith('file://');
}

function getSenderWindow(event) {
  return BrowserWindow.fromWebContents(event.sender);
}

function createMainWindow() {
  const mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 940,
    minHeight: 620,
    show: false,
    title: 'GUI-SSH',
    backgroundColor: '#0b1017',
    autoHideMenuBar: true,
    frame: process.platform === 'darwin',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 16, y: 15 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url);
    }

    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isSafeNavigation(url)) {
      event.preventDefault();
    }
  });

  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

ipcMain.handle('window:minimize', (event) => {
  getSenderWindow(event)?.minimize();
});

ipcMain.handle('window:toggle-maximize', (event) => {
  const window = getSenderWindow(event);

  if (!window) {
    return false;
  }

  if (window.isMaximized()) {
    window.unmaximize();
  } else {
    window.maximize();
  }

  return window.isMaximized();
});

ipcMain.handle('window:close', (event) => {
  getSenderWindow(event)?.close();
});

ipcMain.handle('dialog:select-private-key', async (event) => {
  const window = getSenderWindow(event);
  const result = await dialog.showOpenDialog(window ?? undefined, {
    title: '选择 SSH 私钥文件',
    properties: ['openFile'],
    filters: [
      { name: 'SSH Private Keys', extensions: ['pem', 'key', 'ppk'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (result.canceled) {
    return '';
  }

  return result.filePaths[0] ?? '';
});

ipcMain.handle('connection:connect', async (_event, rawHost) => {
  let client;

  try {
    const { displayHost, sshConfig } = validateHostRequest(rawHost);
    client = await connectSshClient(sshConfig);
    const { server, port } = await createSocksProxy(client);
    const id = crypto.randomUUID();
    const partition = `gui-ssh-${id}`;
    const remoteSession = session.fromPartition(partition);

    await remoteSession.setProxy({
      mode: 'fixed_servers',
      proxyRules: `socks5://127.0.0.1:${port}`,
      proxyBypassRules: '<-loopback>',
    });
    const loopbackProxy = await remoteSession.resolveProxy('http://127.0.0.1/');
    const publicProxy = await remoteSession.resolveProxy('http://example.com/');
    console.info(`[gui-ssh] webview proxy ${partition}: 127.0.0.1 => ${loopbackProxy}; example.com => ${publicProxy}`);
    remoteSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

    const activeConnection = {
      id,
      client,
      socksServer: server,
      proxyPort: port,
      partition,
      displayHost,
      connectedAt: new Date().toISOString(),
      terminalSessions: new Map(),
    };

    activeConnections.set(id, activeConnection);
    client.once('close', () => {
      void closeActiveConnection(id, 'SSH 连接已断开。', true);
    });

    return {
      ok: true,
      connection: {
        id,
        partition,
        proxyPort: port,
        connectedAt: activeConnection.connectedAt,
        host: displayHost,
      },
    };
  } catch (error) {
    client?.end();
    return { ok: false, error: toConnectionErrorMessage(error) };
  }
});

registerIpcHandler('connection:disconnect', async (_event, connectionId) => {
  await closeActiveConnection(connectionId, '已断开 SSH 连接。');
  return true;
});

registerIpcHandler('connection:get-ipc-capabilities', async () => ({
  terminalSessions: true,
}));

registerIpcHandler('connection:start-terminal', async (event, connectionId, rawTerminalId, rawColumns, rawRows) => {
  const activeConnection = getActiveConnection(connectionId);
  const terminalId = validateTerminalId(rawTerminalId);
  const columns = Number(rawColumns) || 100;
  const rows = Number(rawRows) || 30;

  if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 20 || rows < 5 || columns > 300 || rows > 120) {
    throw new Error('终端尺寸无效。');
  }

  const existingStream = activeConnection.terminalSessions.get(terminalId);

  if (existingStream && !existingStream.destroyed) {
    return true;
  }

  await new Promise((resolve, reject) => {
    let settled = false;
    const startTimer = setTimeout(() => {
      settled = true;
      reject(new Error('终端启动超时：远程服务器未返回交互式 Shell。'));
    }, 15000);

    activeConnection.client.shell({ term: 'xterm-256color', cols: columns, rows }, (error, stream) => {
      if (settled) {
        stream?.end();
        return;
      }

      settled = true;
      clearTimeout(startTimer);

      if (error) {
        reject(error);
        return;
      }

      activeConnection.terminalSessions.set(terminalId, stream);
      stream.on('data', (chunk) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('terminal:data', { connectionId, terminalId, data: chunk.toString('utf8') });
        }
      });
      stream.stderr.on('data', (chunk) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('terminal:data', { connectionId, terminalId, data: chunk.toString('utf8') });
        }
      });
      stream.once('close', () => {
        if (activeConnection.terminalSessions.get(terminalId) === stream) {
          activeConnection.terminalSessions.delete(terminalId);
        }

        if (!event.sender.isDestroyed()) {
          event.sender.send('terminal:exit', { connectionId, terminalId });
        }
      });
      resolve();
    });
  });

  return true;
});

registerIpcHandler('connection:write-terminal', async (_event, connectionId, rawTerminalId, rawData) => {
  const activeConnection = getActiveConnection(connectionId);
  const terminalId = validateTerminalId(rawTerminalId);
  const terminalStream = activeConnection.terminalSessions.get(terminalId);

  if (!terminalStream || terminalStream.destroyed) {
    throw new Error('终端尚未启动。');
  }

  if (typeof rawData !== 'string' || rawData.length > 8192 || rawData.includes('\0')) {
    throw new Error('终端输入无效。');
  }

  terminalStream.write(rawData);
  return true;
});

registerIpcHandler('connection:resize-terminal', async (_event, connectionId, rawTerminalId, rawColumns, rawRows) => {
  const activeConnection = getActiveConnection(connectionId);
  const terminalId = validateTerminalId(rawTerminalId);
  const columns = Number(rawColumns);
  const rows = Number(rawRows);

  if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 20 || rows < 5 || columns > 300 || rows > 120) {
    throw new Error('终端尺寸无效。');
  }

  const terminalStream = activeConnection.terminalSessions.get(terminalId);

  if (terminalStream?.setWindow) {
    terminalStream.setWindow(rows, columns, 0, 0);
  }

  return true;
});

registerIpcHandler('connection:close-terminal', async (_event, connectionId, rawTerminalId) => {
  const activeConnection = getActiveConnection(connectionId);
  const terminalId = validateTerminalId(rawTerminalId);
  const terminalStream = activeConnection.terminalSessions.get(terminalId);

  if (terminalStream) {
    activeConnection.terminalSessions.delete(terminalId);
    terminalStream.removeAllListeners();
    terminalStream.end();
  }

  return true;
});

registerIpcHandler('connection:list-directory', async (_event, connectionId, rawPath) => {
  const activeConnection = getActiveConnection(connectionId);
  const remotePath = validateRemotePath(rawPath);
  const entries = await listRemoteDirectory(activeConnection.client, remotePath);

  return { path: remotePath, entries };
});

registerIpcHandler('connection:create-directory', async (_event, connectionId, rawPath) => {
  const activeConnection = getActiveConnection(connectionId);
  const remotePath = validateMutableRemotePath(rawPath);
  await createRemoteDirectory(activeConnection.client, remotePath);
  return true;
});

registerIpcHandler('connection:delete-path', async (_event, connectionId, rawPath, rawType) => {
  const activeConnection = getActiveConnection(connectionId);
  const remotePath = validateMutableRemotePath(rawPath);
  const entryType = rawType === 'directory' ? 'directory' : 'file';
  await deleteRemotePath(activeConnection.client, remotePath, entryType);
  return true;
});

registerIpcHandler('connection:get-status', async (_event, connectionId) => {
  const activeConnection = getActiveConnection(connectionId);
  return getRemoteStatus(activeConnection.client);
});

app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') {
    return;
  }

  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => {
    if (!url.startsWith('http://') && !url.startsWith('https://') && url !== 'about:blank') {
      event.preventDefault();
    }
  });
});

app.whenReady().then(() => {
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  for (const connectionId of activeConnections.keys()) {
    void closeActiveConnection(connectionId, '应用退出。');
  }
});
