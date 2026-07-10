import { expect, type Locator, type Page, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

async function expectAlertInsideDialog(page: Page, dialog: Locator, alert: Locator, text: string) {
  await expect(dialog).toBeVisible();
  await expect(alert).toContainText(text);

  const [dialogBox, alertBox] = await Promise.all([
    dialog.boundingBox(),
    alert.boundingBox(),
  ]);

  expect(dialogBox, 'dialog should have a rendered box').not.toBeNull();
  expect(alertBox, 'alert should have a rendered box').not.toBeNull();

  expect(alertBox!.x).toBeGreaterThanOrEqual(dialogBox!.x);
  expect(alertBox!.y).toBeGreaterThanOrEqual(dialogBox!.y);
  expect(alertBox!.x + alertBox!.width).toBeLessThanOrEqual(dialogBox!.x + dialogBox!.width);
  expect(alertBox!.y + alertBox!.height).toBeLessThanOrEqual(dialogBox!.y + dialogBox!.height);

  const alertIsTopmost = await alert.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const topElement = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return node === topElement || node.contains(topElement);
  });

  expect(alertIsTopmost, 'alert center should not be covered by another element').toBe(true);
}

async function expectElementTopmost(element: Locator) {
  await expect(element).toBeVisible();
  const isTopmost = await element.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const topElement = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return node === topElement || node.contains(topElement);
  });

  expect(isTopmost, 'element center should not be covered by another element').toBe(true);
}

async function gotoHarness(page: Page, query: string) {
  await page.goto(`/tests/ui/database-error-harness.html?${query}`, { waitUntil: 'domcontentloaded' });
}

test('Monitor persistence remains opt-in and can return to real-time only', async ({ page }) => {
  await gotoHarness(page, 'component=monitor');

  const dialog = page.getByRole('dialog', { name: '开启持久化分析？' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '仅使用实时监控' }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByText('实时采样')).toBeVisible();
  await expect(page.getByRole('button', { name: '开启持久化' })).toBeVisible();
});

test('Monitor persistence places sample count in the control bar and combines network traffic', async ({ page }) => {
  await gotoHarness(page, 'component=monitor');

  const optInDialog = page.getByRole('dialog', { name: '开启持久化分析？' });
  await expect(optInDialog).toBeVisible();
  await optInDialog.getByRole('button', { name: '开启持久化' }).click();

  await expect(optInDialog).toBeHidden();
  await expect(page.getByText('持久化分析')).toBeVisible();
  await expect(page.getByText('24 个采样点', { exact: true })).toBeVisible();
  await expect(page.locator('.monitor-observability-summary')).toHaveCount(0);
  await expect(page.getByText('根磁盘使用率')).toBeVisible();

  const chartCards = page.locator('.monitor-chart-card');
  await expect(chartCards).toHaveCount(4);
  const networkCard = page.locator('.monitor-chart-card[data-series-key="network"]');
  await expect(networkCard).toHaveCount(1);
  await expect(networkCard).toContainText('网络流量');
  await expect(networkCard).toContainText('↑');
  await expect(networkCard).toContainText('↓');

  await page.getByRole('button', { name: '设置阈值' }).click();
  const thresholdDialog = page.getByRole('dialog', { name: '配置告警阈值' });
  await expect(thresholdDialog).toBeVisible();
  await expect(thresholdDialog.getByRole('spinbutton')).toHaveCount(3);
});

test('Monitor persistence remains usable in a compact window', async ({ page }) => {
  await page.setViewportSize({ width: 620, height: 720 });
  await gotoHarness(page, 'component=monitor');

  const optInDialog = page.getByRole('dialog', { name: '开启持久化分析？' });
  await optInDialog.getByRole('button', { name: '开启持久化' }).click();
  await expect(page.getByText('24 个采样点', { exact: true })).toBeVisible();

  const horizontalOverflow = await page.locator('.monitor-shell').evaluate((node) => node.scrollWidth - node.clientWidth);
  expect(horizontalOverflow).toBeLessThanOrEqual(1);

  await page.getByRole('button', { name: '设置阈值' }).click();
  const dialog = page.getByRole('dialog', { name: '配置告警阈值' });
  await expect(dialog).toBeVisible();
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
  expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(620);
});

test('MySQL create-table backend errors stay visible inside the modal', async ({ page }) => {
  await gotoHarness(page, 'component=mysql');

  await page.getByTestId('mysql-connect-submit').click();
  await expect(page.getByTestId('mysql-create-table-open')).toBeVisible();

  await page.getByTestId('mysql-create-table-open').click();
  const dialog = page.getByTestId('mysql-create-table-dialog');
  await expect(dialog).toBeVisible();

  await page.getByTestId('mysql-create-table-name').fill('broken_table');
  const columnName = page.getByTestId('mysql-create-table-column-name').first();
  await columnName.fill('id');
  await expect(columnName).toHaveValue('id');
  await page.getByTestId('mysql-create-table-execute').click();

  await expectAlertInsideDialog(
    page,
    dialog,
    page.getByTestId('mysql-dialog-error'),
    'mock create table failure',
  );
});

test('Redis destructive action errors stay visible inside the confirmation modal', async ({ page }) => {
  await gotoHarness(page, 'component=redis');

  await page.getByTestId('redis-connect-submit').click();
  await page.getByTestId('redis-key-row').click();
  await expect(page.getByTestId('redis-delete-key-open')).toBeVisible();

  await page.getByTestId('redis-delete-key-open').click();
  const dialog = page.getByTestId('redis-confirm-dialog');
  await expect(dialog).toBeVisible();

  await page.getByTestId('redis-confirm-execute').click();

  await expectAlertInsideDialog(
    page,
    dialog,
    page.getByTestId('redis-confirm-error'),
    'mock redis delete failure',
  );
});

test('File explorer permission errors stay visible inside the properties modal', async ({ page }) => {
  await gotoHarness(page, 'component=file-explorer');

  const row = page.getByTestId('explorer-row-secure.txt');
  await expect(row).toBeVisible();
  await row.click({ button: 'right' });
  await page.getByTestId('explorer-context-properties').click();

  const dialog = page.getByTestId('explorer-properties-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('explorer-permission-mode')).toHaveValue('644');
  await page.getByTestId('explorer-permission-mode').fill('600');
  await page.getByTestId('explorer-permission-save').click();

  await expectAlertInsideDialog(
    page,
    dialog,
    page.getByTestId('explorer-properties-error'),
    'mock chmod permission failure',
  );
});

test('Shared sudo password prompt stays topmost when remote settings command needs elevation', async ({ page }) => {
  await gotoHarness(page, 'component=settings-sudo&scenario=sudo-prompt');

  const dialog = page.getByTestId('sudo-prompt-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('sudo: a password is required');
  await expect(page.getByTestId('sudo-prompt-password')).toBeFocused();
  await expectElementTopmost(dialog);
});

test('Settings login sessions open a detail dialog from mocked session data', async ({ page }) => {
  await gotoHarness(page, 'component=settings-loginsessions');

  await page.getByTestId('login-session-row-demo').click();
  const dialog = page.getByTestId('login-detail-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('demo');
  await expect(dialog).toContainText('192.0.2.10');
  await expectElementTopmost(dialog);
});

test('User manager destructive command errors stay visible inside the confirmation modal', async ({ page }) => {
  await gotoHarness(page, 'component=settings-users');

  const row = page.getByTestId('user-manager-row-demo');
  await expect(row).toBeVisible();
  await row.locator('button.danger').first().click();

  const dialog = page.getByTestId('settings-confirm-dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('button').last().click();

  await expectAlertInsideDialog(
    page,
    dialog,
    page.getByTestId('settings-confirm-error'),
    'mock delete user failure',
  );
});

test('Remote browser renders certificate and proxy failure pages', async ({ page }) => {
  await gotoHarness(page, 'component=browser');

  const addressInput = page.getByTestId('browser-address-input');
  await addressInput.fill('https://badcert.example.test');
  await addressInput.press('Enter');

  const errorPage = page.getByTestId('browser-error-page');
  await expect(errorPage).toBeVisible();
  await expect(errorPage).toContainText('CERT_AUTHORITY_INVALID');
  await expect(page.getByTestId('browser-trust-certificate')).toBeVisible();

  await addressInput.fill('http://proxy-fail.example.test');
  await addressInput.press('Enter');

  await expect(errorPage).toContainText('PROXY_TUNNEL_FAILED');
  await expect(page.getByTestId('browser-trust-certificate')).toBeHidden();
});
