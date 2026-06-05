import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getVersion() {
  if (process.env.VERSION) {
    return process.env.VERSION;
  }

  const refName = process.env.GITHUB_REF_NAME;
  if (refName && /^v\d+\.\d+\.\d+/.test(refName)) {
    return refName.replace(/^v/, '');
  }

  const sha = process.env.GITHUB_SHA;
  if (sha) {
    return sha.substring(0, 7);
  }

  try {
    const pkgPath = path.join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

const version = getVersion();
const repo = process.env.GITHUB_REPOSITORY || 'liubaicai/ShellDesk';
const refName = process.env.GITHUB_REF_NAME;
const tag = refName && /^v\d+\.\d+\.\d+/.test(refName) ? refName : `v${version}`;
const baseUrl = `https://github.com/${repo}/releases/download/${tag}`;

const files = {
  mac: {
    arm64: `ShellDesk-${version}-mac-arm64.dmg`,
    x64: `ShellDesk-${version}-mac-x64.dmg`,
  },
  win: {
    setupX64: `ShellDesk-${version}-win-x64.exe`,
    portableX64: `ShellDesk-${version}-portable-win-x64.exe`,
  },
  linux: {
    appImageX64: `ShellDesk-${version}-linux-x86_64.AppImage`,
    debX64: `ShellDesk-${version}-linux-amd64.deb`,
    rpmX64: `ShellDesk-${version}-linux-x86_64.rpm`,
  },
};

const badges = {
  win: {
    setupX64: `[![Setup x64](https://img.shields.io/badge/Setup-x64-0078D6?style=flat-square&logo=windows)](${baseUrl}/${files.win.setupX64})`,
    portableX64: `[![Portable x64](https://img.shields.io/badge/Portable-x64-0078D6?style=flat-square&logo=windows)](${baseUrl}/${files.win.portableX64})`,
  },
  mac: {
    appleSilicon: `[![DMG Apple Silicon](https://img.shields.io/badge/DMG-Apple_Silicon-000000?style=flat-square&logo=apple)](${baseUrl}/${files.mac.arm64})`,
    intel: `[![DMG Intel X64](https://img.shields.io/badge/DMG-Intel_X64-000000?style=flat-square&logo=apple)](${baseUrl}/${files.mac.x64})`,
  },
  linux: {
    appImageX64: `[![AppImage x64](https://img.shields.io/badge/AppImage-x64-FCC624?style=flat-square&logo=linux)](${baseUrl}/${files.linux.appImageX64})`,
    debX64: `[![DebPackage x64](https://img.shields.io/badge/DebPackage-x64-A80030?style=flat-square&logo=debian)](${baseUrl}/${files.linux.debX64})`,
    rpmX64: `[![RpmPackage x64](https://img.shields.io/badge/RpmPackage-x64-CC0000?style=flat-square&logo=redhat)](${baseUrl}/${files.linux.rpmX64})`,
  },
};

const content = `
## Download

| OS | Download |
| :--- | :--- |
| **Windows** | ${badges.win.setupX64} ${badges.win.portableX64} |
| **macOS** | ${badges.mac.appleSilicon} ${badges.mac.intel} |
| **Linux** | ${badges.linux.appImageX64} ${badges.linux.debX64} ${badges.linux.rpmX64} |
`;

fs.writeFileSync('release_notes.md', content);
console.log('Generated release_notes.md');
