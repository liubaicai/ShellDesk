import { expect, test } from '@playwright/test';

test('terminal settings drawer groups controls and edits structured highlight rules', async ({ page }) => {
  await page.goto('/tests/ui/terminal-settings-harness.html');
  await page.getByRole('button', { name: '打开终端设置' }).click();

  const dialog = page.getByRole('dialog', { name: '终端设置' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('外观', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /性能与兼容/ })).toHaveAttribute('aria-expanded', 'false');

  await dialog.getByRole('button', { name: '管理规则（3）' }).click();
  await expect(dialog.getByLabel('规则名称')).toHaveCount(3);
  await dialog.getByRole('button', { name: '添加高亮规则' }).click();
  await expect(dialog.getByLabel('规则名称')).toHaveCount(4);
  await expect(dialog.getByLabel('匹配内容').last()).toHaveValue('keyword');
  await expect(page.getByTestId('highlight-rule-count')).toHaveText('4');

  await dialog.getByRole('switch', { name: '命令历史自动补全' }).click();
  await expect(dialog.getByRole('switch', { name: '远程路径补全' })).toBeDisabled();
  await dialog.getByRole('button', { name: /性能与兼容/ }).click();
  await expect(dialog.getByLabel('终端渲染器')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
