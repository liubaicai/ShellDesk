const { app, ipcMain, session } = require('electron');
const crypto = require('node:crypto');
const {
  activeConnections,
  bindActiveConnectionClient,
  closeActiveConnection,
  connectSshClientWithJump,
  createSocksProxy,
  ensureActiveConnectionClient,
  getActiveConnection,
  toConnectionInfo,
} = require('./connectionManager.cjs');
const { detectRemoteSystem } = require('./remoteConnectionHandlers.cjs');
const { toConnectionErrorMessage, toErrorMessage } = require('./validation.cjs');
const { validateHostRequest } = require('./vaultStore.cjs');
const { createConnectionWindow } = require('./windows.cjs');

let isBrowserCertificateHandlerRegistered = false;

function getCertificateTrustOrigin(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));

    if (url.protocol !== 'https:') {
      return null;
    }

    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

function getActiveConnectionByPartition(partition) {
  for (const activeConnection of activeConnections.values()) {
    if (activeConnection.partition === partition) {
      return activeConnection;
    }
  }

  return null;
}

function getActiveConnectionBySession(targetSession) {
  for (const activeConnection of activeConnections.values()) {
    if (activeConnection.browserSession === targetSession) {
      return activeConnection;
    }
  }

  return null;
}

function handleBrowserCertificateError(event, webContents, url, error, _certificate, callback) {
  const activeConnection = getActiveConnectionBySession(webContents.session);
  const trustOrigin = getCertificateTrustOrigin(url);

  if (!activeConnection || !trustOrigin || !activeConnection.browserCertificateTrust?.has(trustOrigin)) {
    callback(false);
    return;
  }

  event.preventDefault();
  console.info(`[shelldesk] trusted browser certificate for ${trustOrigin}: ${error}`);
  callback(true);
}

function registerConnectionHandlers(registerIpcHandler) {
  if (!isBrowserCertificateHandlerRegistered) {
    app.on('certificate-error', handleBrowserCertificateError);
    isBrowserCertificateHandlerRegistered = true;
  }

  ipcMain.handle('connection:connect', async (_event, rawHost) => {
    let client;
    let jumpClient;
    let activeConnection;

    try {
      const { displayHost, sshConfig, privilegeConfig, jumpSshConfig, jumpHost } = validateHostRequest(rawHost);
      const connectedClients = await connectSshClientWithJump(sshConfig, jumpSshConfig, jumpHost);
      client = connectedClients.client;
      jumpClient = connectedClients.jumpClient;
      try {
        Object.assign(displayHost, await detectRemoteSystem(client));
      } catch (systemError) {
        console.info(`[shelldesk] remote system detection failed: ${toErrorMessage(systemError)}`);
      }
      const id = crypto.randomUUID();
      const partition = `shelldesk-${id}`;
      const remoteSession = session.fromPartition(partition);
      activeConnection = {
        id,
        client: null,
        jumpClient,
        sshConfig,
        privilegeConfig,
        jumpSshConfig,
        jumpHost,
        socksServer: null,
        proxyPort: 0,
        partition,
        browserSession: remoteSession,
        browserCertificateTrust: new Set(),
        displayHost,
        connectedAt: new Date().toISOString(),
        terminalSessions: new Map(),
        clientOnline: false,
        reconnectPromise: null,
        lastDisconnectReason: '',
      };

      bindActiveConnectionClient(activeConnection, client);
      activeConnections.set(id, activeConnection);
      const { server, port } = await createSocksProxy(async () => {
        const connection = await ensureActiveConnectionClient(id);
        return connection.client;
      });
      activeConnection.socksServer = server;
      activeConnection.proxyPort = port;

      await remoteSession.setProxy({
        mode: 'fixed_servers',
        proxyRules: `socks5://127.0.0.1:${port}`,
        proxyBypassRules: '<-loopback>',
      });
      const loopbackProxy = await remoteSession.resolveProxy('http://127.0.0.1/');
      const publicProxy = await remoteSession.resolveProxy('http://example.com/');
      console.info(`[shelldesk] webview proxy ${partition}: 127.0.0.1 => ${loopbackProxy}; example.com => ${publicProxy}`);
      remoteSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
      createConnectionWindow(activeConnection);

      return {
        ok: true,
        connection: toConnectionInfo(activeConnection),
      };
    } catch (error) {
      if (activeConnection) {
        await closeActiveConnection(activeConnection.id, '连接初始化失败。').catch(() => undefined);
      } else {
        client?.end();
        jumpClient?.end();
      }
      return { ok: false, error: toConnectionErrorMessage(error) };
    }
  });

  registerIpcHandler('connection:disconnect', async (_event, connectionId) => {
    await closeActiveConnection(connectionId, '已断开 SSH 连接。');
    return true;
  });

  registerIpcHandler('connection:get-info', async (_event, connectionId) => {
    return toConnectionInfo(getActiveConnection(connectionId));
  });

  registerIpcHandler('connection:get-ipc-capabilities', async () => ({
    terminalSessions: true,
    terminalBinary: true,
  }));

  registerIpcHandler('connection:trust-browser-certificate', async (event, partition, rawUrl) => {
    const activeConnection = getActiveConnectionByPartition(String(partition || ''));

    if (!activeConnection) {
      throw new Error('浏览器连接已断开，无法信任该证书。');
    }

    if (activeConnection.window?.webContents !== event.sender) {
      throw new Error('只能在当前连接窗口内信任该证书。');
    }

    const trustOrigin = getCertificateTrustOrigin(rawUrl);

    if (!trustOrigin) {
      throw new Error('只能为 HTTPS 地址添加临时证书例外。');
    }

    activeConnection.browserCertificateTrust ??= new Set();
    activeConnection.browserCertificateTrust.add(trustOrigin);
    return { origin: trustOrigin };
  });

}

module.exports = { registerConnectionHandlers };
