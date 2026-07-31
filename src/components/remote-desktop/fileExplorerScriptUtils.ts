import type { RemoteTerminalLaunchOptions } from './terminalTypes';
import type { RemoteSystemType } from './types';

const unixScriptInterpreters: Record<string, string> = {
  '.bash': 'bash',
  '.fish': 'fish',
  '.js': 'node',
  '.lua': 'lua',
  '.mjs': 'node',
  '.php': 'php',
  '.pl': 'perl',
  '.ps1': 'pwsh -File',
  '.py': 'python3',
  '.rb': 'ruby',
  '.sh': 'sh',
  '.zsh': 'zsh',
};

const windowsScriptCommands: Record<string, string> = {
  '.bat': '&',
  '.cmd': '&',
  '.js': 'node.exe',
  '.mjs': 'node.exe',
  '.ps1': '&',
  '.py': 'python.exe',
};

function getExtension(fileName: string) {
  const normalizedName = fileName.trim().toLocaleLowerCase();
  const dotIndex = normalizedName.lastIndexOf('.');
  return dotIndex > 0 ? normalizedName.slice(dotIndex) : '';
}

function shellSingleQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function powershellSingleQuote(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

export function isRunnableRemoteScript(fileName: string, systemType?: RemoteSystemType) {
  const extension = getExtension(fileName);
  return systemType === 'windows'
    ? extension in windowsScriptCommands
    : extension in unixScriptInterpreters;
}

export function createRemoteScriptLaunchOptions(
  fileName: string,
  scriptPath: string,
  workingDirectory: string,
  systemType?: RemoteSystemType,
): RemoteTerminalLaunchOptions | undefined {
  const extension = getExtension(fileName);

  if (systemType === 'windows') {
    const command = windowsScriptCommands[extension];
    if (!command) return undefined;
    return {
      title: fileName,
      shell: 'powershell -NoLogo -NoProfile -ExecutionPolicy Bypass',
      initialCommand: `${command} ${powershellSingleQuote(scriptPath)}`,
      workingDirectory,
    };
  }

  const interpreter = unixScriptInterpreters[extension];
  if (!interpreter) return undefined;
  return {
    title: fileName,
    initialCommand: `${interpreter} ${shellSingleQuote(scriptPath)}`,
    workingDirectory,
  };
}
