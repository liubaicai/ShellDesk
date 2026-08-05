import { expect, test, type Page } from '@playwright/test';

const harnessPath = '/tests/ui/tmux-name-dialog-harness.html';

async function openTmuxNameDialog(page: Page) {
  await page.getByRole('button', { name: '打开终端菜单' }).click();
  await page.getByRole('menuitem', { name: 'tmux 会话' }).hover();
  await page.getByRole('menuitem', { name: '新建 tmux 任务' }).click();
}

test('new tmux task accepts a custom name and falls back to the next sequence', async ({ page }) => {
  await page.goto(harnessPath);
  await openTmuxNameDialog(page);

  const dialog = page.getByRole('dialog', { name: '新建 tmux 任务' });
  const nameInput = dialog.getByLabel('tmux 名称');
  await expect(dialog).toBeVisible();
  await expect(nameInput).toBeFocused();
  await expect(nameInput).toHaveAttribute('placeholder', '留空则使用 shelldesk-2');

  const screenshotPath = process.env.SHELLDESK_SCREENSHOT_PATH;
  if (screenshotPath) {
    await dialog.screenshot({ path: screenshotPath });
  }

  await dialog.getByRole('button', { name: '创建' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('created-tmux-name')).toHaveText('shelldesk-2');

  await openTmuxNameDialog(page);
  await page.getByLabel('tmux 名称').fill('sd-work');
  await page.getByRole('button', { name: '创建' }).click();
  await expect(page.getByTestId('created-tmux-name')).toHaveText('sd-work');

  await openTmuxNameDialog(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '新建 tmux 任务' })).toBeHidden();
  await expect(page.getByTestId('created-tmux-name')).toHaveText('sd-work');
});
