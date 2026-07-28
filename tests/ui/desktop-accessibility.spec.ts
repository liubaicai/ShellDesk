import { expect, test } from '@playwright/test';

const harnessPath = '/tests/ui/desktop-accessibility-harness.html';

test('Launchpad supports focus entry, roving arrows, Escape, and focus restoration', async ({ page }) => {
  await page.goto(harnessPath);
  const opener = page.locator('#open-launchpad');
  await opener.focus();
  await opener.press('Enter');

  await expect(page.locator('.launchpad-search input')).toBeFocused();
  await expect(page.locator('.launchpad-capability-badge')).toHaveCount(0);
  await expect(page.locator('.launchpad-capability-dot')).toHaveCount(4);
  await expect(page.locator('[data-launchpad-app="files"] .launchpad-capability-dot')).toHaveAttribute('title', '可用');
  const files = page.locator('[data-launchpad-app="files"]');
  await files.focus();
  await files.press('ArrowRight');
  await expect(page.locator('[data-launchpad-app="terminal"]')).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.locator('[data-launchpad-app="settings"]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(opener).toBeFocused();
});

test('virtual desktop context menu is visible before file explorer styles are loaded', async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(message.text());
  });
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  await page.goto(harnessPath);
  await page.locator('#context-menu-surface').click({
    button: 'right',
    position: { x: 180, y: 90 },
  });

  const contextMenu = page.getByRole('menu');
  await expect(contextMenu).toBeVisible();
  await expect(contextMenu.getByRole('menuitem', { name: '新建文件夹' })).toBeVisible();
  await expect(contextMenu).toHaveCSS('position', 'fixed');
  await expect(contextMenu).toHaveCSS('z-index', '9999');
  await page.locator('.context-menu-overlay').click({ button: 'right' });
  await expect(contextMenu).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
});

test('desktop window exposes its title and supports keyboard move, resize, maximize, and close', async ({ page }) => {
  await page.goto(harnessPath);
  const opener = page.locator('#open-window');
  await opener.press('Enter');

  const desktopWindow = page.getByRole('dialog', { name: '终端' });
  await expect(desktopWindow).toBeVisible();
  const titlebar = desktopWindow.locator('.desktop-window-titlebar');
  await titlebar.focus();
  const initialBox = await desktopWindow.boundingBox();
  await titlebar.press('Alt+ArrowRight');
  await titlebar.press('Alt+Shift+ArrowRight');
  const adjustedBox = await desktopWindow.boundingBox();
  expect(adjustedBox?.x).toBe((initialBox?.x ?? 0) + 16);
  expect(adjustedBox?.width).toBe((initialBox?.width ?? 0) + 16);

  const maximize = desktopWindow.getByRole('button', { name: '最大化窗口' });
  await maximize.focus();
  await maximize.press('Enter');
  await expect(desktopWindow.getByRole('button', { name: '还原窗口' })).toBeVisible();
  const close = desktopWindow.getByRole('button', { name: '关闭窗口' });
  await close.focus();
  await close.press('Enter');
  await expect(desktopWindow).toHaveCount(0);
  await expect(opener).toBeFocused();
});
