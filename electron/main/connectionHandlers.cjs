const { app, ipcMain, session } = require('electron');
const crypto = require('node:crypto');
const {
  activeConnections,
  closeActiveConnection,
  connectSshClient,
  createSocksProxy,
  getActiveConnection,
  setClientConnectionMetadata,
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

    try {
      const { displayHost, sshConfig } = validateHostRequest(rawHost);
      client = await connectSshClient(sshConfig);
      try {
        Object.assign(displayHost, await detectRemoteSystem(client));
      } catch (systemError) {
        console.info(`[shelldesk] remote system detection failed: ${toErrorMessage(systemError)}`);
      }
      setClientConnectionMetadata(client, { systemType: displayHost.systemType });
      const { server, port } = await createSocksProxy(client);
      const id = crypto.randomUUID();
      const partition = `shelldesk-${id}`;
      const remoteSession = session.fromPartition(partition);

      await remoteSession.setProxy({
        mode: 'fixed_servers',
        proxyRules: `socks5://127.0.0.1:${port}`,
        proxyBypassRules: '<-loopback>',
      });
      const loopbackProxy = await remoteSession.resolveProxy('http://127.0.0.1/');
      const publicProxy = await remoteSession.resolveProxy('http://example.com/');
      console.info(`[shelldesk] webview proxy ${partition}: 127.0.0.1 => ${loopbackProxy}; example.com => ${publicProxy}`);
      remoteSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

      const activeConnection = {
        id,
        client,
        socksServer: server,
        proxyPort: port,
        partition,
        browserSession: remoteSession,
        browserCertificateTrust: new Set(),
        displayHost,
        connectedAt: new Date().toISOString(),
        terminalSessions: new Map(),
      };

      activeConnections.set(id, activeConnection);
      client.on('error', (err) => {
        const address = `${displayHost.address}:${displayHost.port}`;
        console.warn(`[shelldesk] SSH error ${address}:`, toErrorMessage(err));
      });
      client.once('close', (hadError) => {
        const address = `${displayHost.address}:${displayHost.port}`;
        const reason = hadError
          ? `SSH 连接异常断开 (${address})`
          : `SSH 连接已断开 (${address})`;
        console.info(`[shelldesk] SSH close ${address} hadError=${Boolean(hadError)}`);
        void closeActiveConnection(id, reason, true);
      });
      createConnectionWindow(activeConnection);

      return {
        ok: true,
        connection: toConnectionInfo(activeConnection),
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

  registerIpcHandler('connection:get-info', async (_event, connectionId) => {
    return toConnectionInfo(getActiveConnection(connectionId));
  });

  registerIpcHandler('connection:get-ipc-capabilities', async () => ({
    terminalSessions: true,
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
