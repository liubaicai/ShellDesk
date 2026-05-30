const crypto = require('node:crypto');
const http = require('node:http');
const { WebSocket, WebSocketServer } = require('ws');
const {
  createBufferedReader,
  ensureActiveConnectionClient,
  forwardOut,
  getActiveConnection,
  registerConnectionCleanup,
  withActiveConnectionClientRetry,
} = require('./connectionManager.cjs');
const { isPlainObject, readBoundedString, readIntegerInRange, toErrorMessage } = require('./validation.cjs');

function registerVncHandlers(registerIpcHandler) {
  // ─── VNC over SSH tunnel ────────────────────────────────────────────────────

  const activeVncSessions = new Map();

  function getVncKey(connectionId, vncId) {
    return `${connectionId}::${vncId}`;
  }

  function toVncWebSocketBuffer(data) {
    if (Buffer.isBuffer(data)) {
      return data;
    }

    if (data instanceof ArrayBuffer) {
      return Buffer.from(data);
    }

    if (Array.isArray(data)) {
      return Buffer.concat(data.map((item) => Buffer.from(item)));
    }

    return Buffer.from(data);
  }

  const vncSecurityTypeNames = new Map([
    [0, 'Failure'],
    [1, 'None'],
    [2, 'VNCAuth'],
    [6, 'RA2ne'],
    [16, 'Tight'],
    [19, 'VeNCrypt'],
    [22, 'XVP'],
    [30, 'Apple Remote Desktop'],
    [113, 'MSLogonII'],
    [129, 'Tight Unix Login'],
    [256, 'Plain'],
  ]);

  function getVncSecurityTypeName(code) {
    return vncSecurityTypeNames.get(code) || 'Unknown';
  }

  function closeVncProxy(entry) {
    for (const remoteStream of entry.remoteStreams) {
      remoteStream.removeAllListeners();
      remoteStream.on('error', () => undefined);
      remoteStream.destroy();
    }

    for (const webSocket of entry.webSockets) {
      if (webSocket.readyState === WebSocket.OPEN || webSocket.readyState === WebSocket.CONNECTING) {
        webSocket.close(1000, 'VNC session closed');
      } else {
        webSocket.terminate();
      }
    }

    entry.webSocketServer.close();
    entry.httpServer.close();
  }

  function createVncTargetStream(client, vncHost, vncPort) {
    const connectTimeoutMs = 12000;

    return new Promise((resolve, reject) => {
      let settled = false;
      const connectTimer = setTimeout(() => {
        settled = true;
        reject(new Error('SSH 通道连接 VNC 超时。'));
      }, connectTimeoutMs);

      forwardOut(client, vncHost, vncPort).then((stream) => {
        if (settled) {
          stream.destroy();
          return;
        }

        settled = true;
        clearTimeout(connectTimer);
        resolve(stream);
      }).catch((error) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(connectTimer);
        reject(error);
      });
    });
  }

  async function probeVncTarget(client, vncHost, vncPort) {
    const stream = await createVncTargetStream(client, vncHost, vncPort);
    const reader = createBufferedReader(stream);

    try {
      const bannerBuffer = await reader.read(12);
      const banner = bannerBuffer.toString('ascii');
      const version = banner.slice(4, 11);

      if (!/^RFB \d{3}\.\d{3}\n$/.test(banner)) {
        throw new Error(`VNC 服务返回了无效协议头：${JSON.stringify(banner)}`);
      }

      stream.write(bannerBuffer);

      let securityTypes = [];

      if (version === '003.003' || version === '003.006') {
        const securityType = (await reader.read(4)).readUInt32BE(0);
        securityTypes = [{ code: securityType, name: getVncSecurityTypeName(securityType) }];
      } else {
        const securityTypeCount = (await reader.read(1))[0];

        if (securityTypeCount === 0) {
          const reasonLength = (await reader.read(4)).readUInt32BE(0);
          const reason = reasonLength > 0 ? (await reader.read(reasonLength)).toString('utf8') : '没有可用的安全类型。';
          throw new Error(reason);
        }

        const securityTypeBytes = await reader.read(securityTypeCount);
        securityTypes = Array.from(securityTypeBytes).map((code) => ({
          code,
          name: getVncSecurityTypeName(code),
        }));
      }

      return {
        host: vncHost,
        port: vncPort,
        banner: banner.trim(),
        version,
        securityTypes,
      };
    } finally {
      reader.dispose();
      stream.removeAllListeners();
      stream.on('error', () => undefined);
      stream.destroy();
    }
  }

  function createVncProtocolObserver(onDiagnostic) {
    let remoteBuffer = Buffer.alloc(0);
    let clientBuffer = Buffer.alloc(0);
    let version = '';
    let securityType = null;
    let bannerSeen = false;
    let clientVersionSeen = false;
    let securitySeen = false;
    let challengeSeen = false;
    let authResponseSeen = false;
    let resultSeen = false;
    let isDone = false;

    const emit = (stage, detail) => onDiagnostic(stage, detail);

    return {
      remote(chunk) {
        if (isDone) {
          return;
        }

        remoteBuffer = Buffer.concat([remoteBuffer, chunk]);

        if (!bannerSeen && remoteBuffer.length >= 12) {
          const banner = remoteBuffer.subarray(0, 12).toString('ascii').trim();
          version = banner.slice(4);
          bannerSeen = true;
          remoteBuffer = remoteBuffer.subarray(12);
          emit('server-banner', banner);
        }

        if (bannerSeen && clientVersionSeen && !securitySeen && remoteBuffer.length >= 4) {
          securityType = remoteBuffer.readUInt32BE(0);
          securitySeen = true;
          remoteBuffer = remoteBuffer.subarray(4);
          emit('security-type', `${getVncSecurityTypeName(securityType)}(${securityType})`);
        }

        if (securityType === 2 && !challengeSeen && remoteBuffer.length >= 16) {
          challengeSeen = true;
          remoteBuffer = remoteBuffer.subarray(16);
          emit('auth-challenge', '已收到 VNCAuth challenge');
        }

        if (challengeSeen && authResponseSeen && !resultSeen && remoteBuffer.length >= 4) {
          const result = remoteBuffer.readUInt32BE(0);
          resultSeen = true;
          remoteBuffer = remoteBuffer.subarray(4);
          emit('auth-result', result === 0 ? '认证成功' : `认证失败 (${result})`);

          // Framebuffer updates can be very large and frequent. Stop buffering
          // after authentication so diagnostics cannot stall the VNC data path.
          remoteBuffer = Buffer.alloc(0);
          clientBuffer = Buffer.alloc(0);
          isDone = true;
        }
      },
      client(chunk) {
        if (isDone) {
          return;
        }

        clientBuffer = Buffer.concat([clientBuffer, chunk]);

        if (bannerSeen && !clientVersionSeen && clientBuffer.length >= 12) {
          const clientVersion = clientBuffer.subarray(0, 12).toString('ascii').trim();
          clientVersionSeen = true;
          clientBuffer = clientBuffer.subarray(12);
          emit('client-version', clientVersion || `RFB ${version}`);
        }

        if (securityType === 2 && challengeSeen && !authResponseSeen && clientBuffer.length >= 16) {
          authResponseSeen = true;
          clientBuffer = clientBuffer.subarray(16);
          emit('auth-response', '已发送 VNCAuth 密码响应');
        }
      },
    };
  }

  async function resolveVncClient(clientOrProvider) {
    return typeof clientOrProvider === 'function' ? await clientOrProvider() : clientOrProvider;
  }

  function createVncWebSocketProxy(clientOrProvider, vncHost, vncPort, onDiagnostic) {
    return new Promise((resolve, reject) => {
      const webSockets = new Set();
      const remoteStreams = new Set();
      const httpServer = http.createServer((_request, response) => {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('ShellDesk VNC WebSocket proxy');
      });
      const webSocketServer = new WebSocketServer({ server: httpServer });

      const fail = (error) => {
        webSocketServer.close();
        httpServer.close(() => reject(error));
      };

      const ready = () => {
        httpServer.removeListener('error', fail);
        httpServer.on('error', () => undefined);
        const address = httpServer.address();

        if (!address || typeof address === 'string') {
          webSocketServer.close();
          httpServer.close();
          reject(new Error('VNC 代理启动失败。'));
          return;
        }

        resolve({
          httpServer,
          webSocketServer,
          webSockets,
          remoteStreams,
          localPort: address.port,
        });
      };

      webSocketServer.on('connection', (webSocket) => {
        let remoteStream = null;
        let firstDataTimer = null;
        let isClosed = false;
        const pendingClientChunks = [];
        const protocolObserver = createVncProtocolObserver(onDiagnostic);
        const resumeBufferedBytes = 512 * 1024;
        const pauseBufferedBytes = 2 * 1024 * 1024;
        const closeBufferedBytes = 24 * 1024 * 1024;
        let resumeTimer = null;
        let isRemotePaused = false;

        if (webSocket._socket && typeof webSocket._socket.setNoDelay === 'function') {
          webSocket._socket.setNoDelay(true);
        }

        onDiagnostic('websocket', 'noVNC 已连接到本地 WebSocket 桥');

        const closePeer = () => {
          if (isClosed) {
            return;
          }

          isClosed = true;
          if (firstDataTimer) {
            clearTimeout(firstDataTimer);
            firstDataTimer = null;
          }
          if (resumeTimer) {
            clearTimeout(resumeTimer);
            resumeTimer = null;
          }
          webSockets.delete(webSocket);

          if (remoteStream) {
            remoteStreams.delete(remoteStream);
            remoteStream.removeAllListeners();
            remoteStream.on('error', () => undefined);
            remoteStream.destroy();
          }

          if (webSocket.readyState === WebSocket.OPEN || webSocket.readyState === WebSocket.CONNECTING) {
            webSocket.close();
          }
        };

        const resumeRemoteIfReady = () => {
          if (isClosed || !remoteStream || remoteStream.destroyed) {
            return;
          }

          if (webSocket.readyState !== WebSocket.OPEN) {
            return;
          }

          if (webSocket.bufferedAmount <= resumeBufferedBytes) {
            isRemotePaused = false;
            remoteStream.resume();
            return;
          }

          if (!resumeTimer) {
            resumeTimer = setTimeout(() => {
              resumeTimer = null;
              resumeRemoteIfReady();
            }, 16);
          }
        };

        const pauseRemoteForBackpressure = () => {
          if (!remoteStream || remoteStream.destroyed || isRemotePaused) {
            return;
          }

          isRemotePaused = true;
          remoteStream.pause();
          resumeRemoteIfReady();
        };

        webSockets.add(webSocket);
        webSocket.on('close', closePeer);
        webSocket.on('error', closePeer);
        webSocket.on('message', (data) => {
          const chunk = toVncWebSocketBuffer(data);
          protocolObserver.client(chunk);

          if (remoteStream && !remoteStream.destroyed) {
            const canContinue = remoteStream.write(chunk);

            if (!canContinue && typeof webSocket.pause === 'function') {
              webSocket.pause();
              remoteStream.once('drain', () => {
                if (!isClosed && typeof webSocket.resume === 'function') {
                  webSocket.resume();
                }
              });
            }
            return;
          }

          pendingClientChunks.push(chunk);
        });

        resolveVncClient(clientOrProvider).then((client) =>
          createVncTargetStream(client, vncHost, vncPort)).then((stream) => {
          if (isClosed) {
            stream.destroy();
            return;
          }

          remoteStream = stream;
          remoteStreams.add(stream);
          onDiagnostic('ssh-stream', `已通过 SSH 打开 ${vncHost}:${vncPort}`);

          while (pendingClientChunks.length > 0 && !stream.destroyed) {
            stream.write(pendingClientChunks.shift());
          }

          firstDataTimer = setTimeout(() => {
            console.warn(`[shelldesk] VNC handshake timed out ${vncHost}:${vncPort} via ssh`);
            if (webSocket.readyState === WebSocket.OPEN || webSocket.readyState === WebSocket.CONNECTING) {
              webSocket.close(1011, 'VNC handshake timed out');
            }
            closePeer();
          }, 12000);

          stream.on('data', (chunk) => {
            protocolObserver.remote(chunk);

            if (firstDataTimer) {
              clearTimeout(firstDataTimer);
              firstDataTimer = null;
            }

            if (isClosed || webSocket.readyState !== WebSocket.OPEN) {
              return;
            }

            webSocket.send(chunk, { binary: true }, (error) => {
              if (error) {
                closePeer();
                return;
              }

              if (isRemotePaused) {
                resumeRemoteIfReady();
              }
            });

            if (webSocket.bufferedAmount >= closeBufferedBytes) {
              onDiagnostic('flow-control', `WebSocket 缓冲过高，已断开：${Math.round(webSocket.bufferedAmount / 1024 / 1024)}MB`);
              closePeer();
              return;
            }

            if (webSocket.bufferedAmount >= pauseBufferedBytes) {
              pauseRemoteForBackpressure();
            }
          });
          stream.on('close', () => {
            clearTimeout(firstDataTimer);
            console.info(`[shelldesk] VNC stream closed ${vncHost}:${vncPort}`);
            closePeer();
          });
          stream.on('error', (err) => {
            clearTimeout(firstDataTimer);
            console.warn(`[shelldesk] VNC stream error ${vncHost}:${vncPort}:`, toErrorMessage(err));
            closePeer();
          });
        }).catch((error) => {
          console.warn(`[shelldesk] VNC CONNECT failed ${vncHost}:${vncPort} via ssh: ${toErrorMessage(error)}`);
          onDiagnostic('target-error', toErrorMessage(error));
          if (webSocket.readyState === WebSocket.OPEN || webSocket.readyState === WebSocket.CONNECTING) {
            webSocket.close(1011, 'VNC target unavailable');
          }
          closePeer();
        });
      });

      httpServer.once('error', fail);
      httpServer.once('listening', ready);
      httpServer.listen(0, '127.0.0.1');
    });
  }

  registerIpcHandler('connection:vnc-probe', async (_event, connectionId, rawConfig) => {
    if (!isPlainObject(rawConfig)) {
      throw new Error('VNC 连接配置无效。');
    }

    const vncHost = readBoundedString(rawConfig.host || '127.0.0.1', 'VNC 主机', 256);
    const vncPort = readIntegerInRange(rawConfig.port, 'VNC 端口', 1, 65535, 5900);

    return withActiveConnectionClientRetry(connectionId, (activeConnection) =>
      probeVncTarget(activeConnection.client, vncHost, vncPort));
  });

  registerIpcHandler('connection:vnc-start', async (event, connectionId, rawConfig) => {
    const activeConnection = getActiveConnection(connectionId);

    if (!isPlainObject(rawConfig)) {
      throw new Error('VNC 连接配置无效。');
    }

    const vncHost = readBoundedString(rawConfig.host || '127.0.0.1', 'VNC 主机', 256);
    const vncPort = readIntegerInRange(rawConfig.port, 'VNC 端口', 1, 65535, 5900);
    const vncId = readBoundedString(rawConfig.vncId || crypto.randomUUID(), 'VNC 会话 ID', 128);
    const key = getVncKey(connectionId, vncId);
    const existing = activeVncSessions.get(key);

    if (existing) {
      activeVncSessions.delete(key);
      closeVncProxy(existing);
    }

    const sendDiagnostic = (stage, detail) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('vnc:diagnostic', { connectionId, vncId, stage, detail });
      }
    };
    const proxy = await createVncWebSocketProxy(async () => {
      const connection = await ensureActiveConnectionClient(connectionId);
      return connection.client;
    }, vncHost, vncPort, sendDiagnostic);

    activeVncSessions.set(key, {
      ...proxy,
      connectionId,
      vncId,
      host: vncHost,
      port: vncPort,
    });

    return {
      vncId,
      host: vncHost,
      port: vncPort,
      webSocketUrl: `ws://127.0.0.1:${proxy.localPort}`,
    };
  });

  registerIpcHandler('connection:vnc-stop', async (_event, connectionId, rawVncId) => {
    const vncId = readBoundedString(rawVncId, 'VNC 会话 ID', 128);
    const key = getVncKey(connectionId, vncId);
    const entry = activeVncSessions.get(key);

    if (entry) {
      activeVncSessions.delete(key);
      closeVncProxy(entry);
    }

    return true;
  });

  registerConnectionCleanup(async (connectionId) => {
    for (const [key, entry] of activeVncSessions) {
      if (entry.connectionId === connectionId) {
        activeVncSessions.delete(key);
        closeVncProxy(entry);
      }
    }
  });
}

module.exports = { registerVncHandlers };
