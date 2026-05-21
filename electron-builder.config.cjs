/**
 * @type {import('electron-builder').Configuration}
 */
module.exports = {
  appId: 'com.shelldesk.app',
  productName: 'ShellDesk',
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  icon: 'src/assets/images/icon.png',
  asar: true,
  npmRebuild: true,
  directories: {
    output: 'release',
  },
  files: [
    'dist/**/*',
    'electron/**/*',
    'package.json',
  ],
  extraResources: [
    {
      from: 'src/assets/images/icon.png',
      to: 'app-icon.png',
    },
  ],
  asarUnpack: [
    'node_modules/ssh2/**/*',
    'node_modules/cpu-features/**/*',
  ],
  mac: {
    target: [
      {
        target: 'dmg',
        arch: ['arm64', 'x64'],
      },
      {
        target: 'zip',
        arch: ['arm64', 'x64'],
      },
    ],
    category: 'public.app-category.developer-tools',
    hardenedRuntime: false,
  },
  dmg: {
    title: '${productName}',
    iconSize: 100,
    iconTextSize: 12,
    window: {
      width: 540,
      height: 380,
    },
    contents: [
      { x: 140, y: 158 },
      { x: 400, y: 158, type: 'link', path: '/Applications' },
    ],
  },
  win: {
    icon: 'src/assets/images/icon.png',
    signAndEditExecutable: true,
    target: [
      {
        target: 'nsis',
        arch: ['x64', 'arm64'],
      },
      {
        target: 'portable',
        arch: ['x64', 'arm64'],
      },
    ],
  },
  portable: {
    artifactName: '${productName}-${version}-portable-${os}-${arch}.${ext}',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'ShellDesk',
  },
  linux: {
    icon: 'src/assets/images/icon.png',
    target: ['AppImage', 'deb', 'rpm'],
    category: 'Development',
  },
  deb: {
    compression: 'gz',
  },
  publish: [
    {
      provider: 'github',
      owner: 'liubaicai',
      repo: 'ShellDesk',
      releaseType: 'release',
    },
  ],
};
