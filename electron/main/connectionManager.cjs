const { BrowserWindow } = require('electron');
const crypto = require('node:crypto');
const net = require('node:net');
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
    console.info(`[shelldesk] SSH TCP forwarding failed for ${destinationHost}:${destinationPort}, trying exec relay: ${toErrorMessage(tunnelError)}`);

    try {
      return await openExecTcpRelayStream(client, destinationHost, destinationPort, tunnelError);
    } catch (relayError) {
      throw new Error(`SSH TCP 转发失败，远程 TCP 代理也无法启动：${toErrorMessage(relayError)}。请确认服务器允许 TCP 转发，或远端安装 nc/ncat/socat。原始转发错误：${toErrorMessage(tunnelError)}`);
    }
  }
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
    activeConnection.client.end();
  }

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
  closeActiveConnection,
  connectSshClient,
  createBufferedReader,
  createSocksProxy,
  forwardOut,
  getActiveConnection,
  registerConnectionCleanup,
  setClientConnectionMetadata,
  toConnectionInfo,
};
