const { ipcMain } = require('electron');
const { toErrorMessage } = require('./validation.cjs');

function registerIpcHandler(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...args);
    } catch (error) {
      throw new Error(toErrorMessage(error));
    }
  });
}

module.exports = { registerIpcHandler };
