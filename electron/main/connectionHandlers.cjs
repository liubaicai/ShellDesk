const { ipcMain, session } = require('electron');
const crypto = require('node:crypto');
const {
  activeConnections,
  closeActiveConnection,
  connectSshClient,
  createSocksProxy,
  getActiveConnection,
  toConnectionInfo,
} = require('./connectionManager.cjs');
const { detectRemoteSystem } = require('./remoteConnectionHandlers.cjs');
const { toConnectionErrorMessage, toErrorMessage } = require('./validation.cjs');
const { validateHostRequest } = require('./vaultStore.cjs');
const { createConnectionWindow } = require('./windows.cjs');

function registerConnectionHandlers(registerIpcHandler) {
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

}

module.exports = { registerConnectionHandlers };
