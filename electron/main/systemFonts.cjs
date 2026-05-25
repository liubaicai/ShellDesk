const childProcess = require('node:child_process');
const { promisify } = require('node:util');

const execFile = promisify(childProcess.execFile);

const fallbackFontFamilies = [
  'Microsoft YaHei UI',
  'Microsoft YaHei',
  'Segoe UI Variable',
  'Segoe UI',
  'Arial',
  'Verdana',
  'Georgia',
  'Times New Roman',
  'Cascadia Mono',
  'Consolas',
  'Courier New',
];

let cachedSystemFonts = null;

function normalizeFontName(value) {
  if (typeof value !== 'string') {
    return '';
  }

  const fontName = value
    .replace(/\0/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!fontName || fontName.length > 120 || fontName.startsWith('@')) {
    return '';
  }

  return fontName;
}

function uniqueSortedFontNames(fontNames) {
  const fontMap = new Map();

  for (const rawFontName of fontNames) {
    const fontName = normalizeFontName(rawFontName);

    if (!fontName) {
      continue;
    }

    const key = fontName.toLocaleLowerCase('en-US');

    if (!fontMap.has(key)) {
      fontMap.set(key, fontName);
    }
  }

  return Array.from(fontMap.values()).sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

function createPowerShellArgs(script) {
  return [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ];
}

async function readWindowsFontsWithPowerShell() {
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $__shelldeskUtf8 = New-Object System.Text.UTF8Encoding $false
  [Console]::InputEncoding = $__shelldeskUtf8
  [Console]::OutputEncoding = $__shelldeskUtf8
  $OutputEncoding = $__shelldeskUtf8
} catch {}
Add-Type -AssemblyName System.Drawing
$fontCollection = New-Object System.Drawing.Text.InstalledFontCollection
$fontCollection.Families | ForEach-Object { $_.Name }
`;
  const { stdout } = await execFile('powershell.exe', createPowerShellArgs(script), {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 10000,
    windowsHide: true,
  });

  return stdout.split(/\r?\n/);
}

function normalizeRegistryFontName(value) {
  return normalizeFontName(value)
    .replace(/\s*\((?:TrueType|OpenType|Type 1|Raster|Bitmap)\)\s*$/i, '')
    .replace(/\s+(?:Regular|Bold|Italic|Oblique|Light|Medium|Semi Bold|Semibold|Demi Bold|Black|Thin|Extra Light|Extra Bold|Condensed|Narrow)\s*$/i, '')
    .trim();
}

async function readWindowsFontsFromRegistry() {
  const registryKeys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
    'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
  ];
  const fontNames = [];

  for (const registryKey of registryKeys) {
    try {
      const { stdout } = await execFile('reg.exe', ['query', registryKey], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 8000,
        windowsHide: true,
      });

      for (const line of stdout.split(/\r?\n/)) {
        const match = /^\s{2,}(.+?)\s+REG_\w+\s+/.exec(line);

        if (match?.[1]) {
          fontNames.push(normalizeRegistryFontName(match[1]));
        }
      }
    } catch {
      // Some Windows editions do not expose per-user font registry keys.
    }
  }

  return fontNames;
}

async function readMacFonts() {
  const { stdout } = await execFile('system_profiler', ['SPFontsDataType', '-json'], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 15000,
  });
  const payload = JSON.parse(stdout);
  const fontNames = [];

  function collectFontNames(value) {
    if (Array.isArray(value)) {
      value.forEach(collectFontNames);
      return;
    }

    if (!value || typeof value !== 'object') {
      return;
    }

    if (typeof value.family === 'string') {
      fontNames.push(value.family);
    } else if (typeof value._name === 'string') {
      fontNames.push(value._name);
    }

    Object.values(value).forEach(collectFontNames);
  }

  collectFontNames(payload.SPFontsDataType);
  return fontNames;
}

async function readLinuxFonts() {
  const { stdout } = await execFile('fc-list', [':', 'family'], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 10000,
  });

  return stdout
    .split(/\r?\n/)
    .flatMap((line) => line.split(','));
}

async function readSystemFontFamilies() {
  if (process.platform === 'win32') {
    try {
      const fontNames = uniqueSortedFontNames(await readWindowsFontsWithPowerShell());

      if (fontNames.length) {
        return fontNames;
      }
    } catch {
      // Fall back to the registry reader below.
    }

    return uniqueSortedFontNames(await readWindowsFontsFromRegistry());
  }

  if (process.platform === 'darwin') {
    return uniqueSortedFontNames(await readMacFonts());
  }

  return uniqueSortedFontNames(await readLinuxFonts());
}

async function getSystemFontFamilies() {
  if (cachedSystemFonts) {
    return cachedSystemFonts;
  }

  try {
    const systemFonts = await readSystemFontFamilies();
    cachedSystemFonts = systemFonts.length ? systemFonts : fallbackFontFamilies;
  } catch {
    cachedSystemFonts = fallbackFontFamilies;
  }

  return cachedSystemFonts;
}

module.exports = { getSystemFontFamilies };
