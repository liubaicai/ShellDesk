import { expect, test, type Locator } from '@playwright/test';

async function expectExpandedSectionToFit(section: Locator) {
  const metrics = await section.evaluate((element) => {
    const lastRow = element.querySelector<HTMLElement>('.terminal-settings-row:last-child');
    const sectionBounds = element.getBoundingClientRect();
    const lastRowBounds = lastRow?.getBoundingClientRect();
    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      sectionBottom: sectionBounds.bottom,
      lastRowBottom: lastRowBounds?.bottom ?? sectionBounds.bottom,
    };
  });

  expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.clientHeight + 1);
  expect(metrics.lastRowBottom).toBeLessThanOrEqual(metrics.sectionBottom + 1);
}

test('terminal settings drawer groups controls and edits structured highlight rules', async ({ page }) => {
  await page.goto('/tests/ui/terminal-settings-harness.html');
  await page.getByRole('button', { name: '打开终端设置' }).click();

  const dialog = page.getByRole('dialog', { name: '终端设置' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('外观', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /性能与兼容/ })).toHaveAttribute('aria-expanded', 'false');

  const quickSection = dialog.getByRole('button', { name: /^常用/ }).locator('..');
  const featuresSection = dialog.getByRole('button', { name: /^功能/ }).locator('..');
  await expectExpandedSectionToFit(quickSection);
  await expectExpandedSectionToFit(featuresSection);
  await expect(dialog.getByText('命令历史自动补全', { exact: true })).toHaveCount(0);
  await expect(dialog.getByText('远程路径补全', { exact: true })).toHaveCount(0);

  await dialog.getByRole('button', { name: '管理规则（3）' }).click();
  await expect(dialog.getByLabel('规则名称')).toHaveCount(3);
  await dialog.getByRole('button', { name: '添加高亮规则' }).click();
  await expect(dialog.getByLabel('规则名称')).toHaveCount(4);
  await expect(dialog.getByLabel('匹配内容').last()).toHaveValue('keyword');
  await expect(page.getByTestId('highlight-rule-count')).toHaveText('4');

  await dialog.getByRole('button', { name: /性能与兼容/ }).click();
  await expect(dialog.getByLabel('终端渲染器')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
