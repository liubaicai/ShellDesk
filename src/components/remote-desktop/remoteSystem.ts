import type { RemoteSystemType } from './types';

export function isWindowsSystem(systemType?: RemoteSystemType) {
  return systemType === 'windows';
}

export function powershellCommand(script: string) {
  const utf8Prelude = `
try {
$__shelldeskUtf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $__shelldeskUtf8
[Console]::OutputEncoding = $__shelldeskUtf8
$OutputEncoding = $__shelldeskUtf8
} catch {}
try { chcp.com 65001 > $null } catch {}
`;
  const fullScript = `${utf8Prelude}\n${script}`;
  const bytes = new Uint8Array(fullScript.length * 2);

  for (let index = 0; index < fullScript.length; index += 1) {
    const code = fullScript.charCodeAt(index);
    bytes[index * 2] = code & 0xff;
    bytes[index * 2 + 1] = code >> 8;
  }

  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${btoa(binary)}`;
}

export function powershellSingleQuote(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}
