const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const shell = read('src/RemoteDesktopShell.tsx');
const windowComponent = read('src/components/remote-desktop/RemoteDesktopWindow.tsx');
const launchpad = read('src/components/remote-desktop/DesktopLaunchpad.tsx');
const keyboardNavigation = read('src/features/remote-desktop/desktopKeyboardNavigation.ts');

assert.match(windowComponent, /role="dialog"/, 'desktop windows must expose dialog semantics');
assert.match(windowComponent, /aria-labelledby=\{titleId\}/, 'desktop windows must have a programmatic title');
assert.match(windowComponent, /tabIndex=\{-1\}/, 'desktop windows must accept managed focus');
assert.match(windowComponent, /event\.altKey/, 'desktop windows must support keyboard frame movement');
assert.match(windowComponent, /event\.shiftKey \? 'resize' : 'move'/, 'desktop windows must distinguish keyboard resize');

assert.match(launchpad, /role="dialog"/, 'Launchpad must expose dialog semantics');
assert.match(launchpad, /aria-modal="true"/, 'Launchpad must be modal to assistive technology');
assert.match(launchpad, /handleModalKeyboardNavigation/, 'Launchpad must trap focus and support Escape');
assert.match(launchpad, /handleRovingKeyboardNavigation/, 'Launchpad app grid must support arrow navigation');

assert.match(shell, /role="menu"/, 'context menus must expose menu semantics');
assert.match(shell, /role="alertdialog"/, 'blocking capability notices must expose alertdialog semantics');
assert.match(shell, /initializeRovingFocus\(contextMenuRef\.current/, 'opened context menus must receive roving focus');
assert.match(shell, /data-dock-app-key/, 'window close focus restoration must have a stable Dock target');
assert.match(shell, /desktopCapabilitySnapshot\[appKey\]\.status === 'checking'/, 'direct app launches must wait for capability probes');
assert.match(shell, /openDesktopWindowRef\.current\(appKey as DesktopAppKey\)/, 'desktop app events must use the latest capability snapshot');
assert.match(keyboardNavigation, /event\.key === 'Escape'/, 'overlay keyboard helper must support Escape');
assert.match(keyboardNavigation, /event\.key !== 'Tab'/, 'overlay keyboard helper must trap Tab navigation');

console.log('Desktop accessibility contract ok: windows, overlays, menus, focus restoration, and keyboard navigation are wired.');
