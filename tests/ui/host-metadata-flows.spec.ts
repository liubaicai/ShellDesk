import { expect, type Locator, type Page, test } from '@playwright/test';

test.describe.configure({ timeout: 90_000 });

const now = '2026-07-23T00:00:00.000Z';
const seededHosts = [
  {
    id: 'host-existing',
    name: 'Production Web',
    address: '10.0.0.10',
    port: 22,
    username: 'root',
    group: 'Production',
    tags: ['linux', 'prod'],
    note: '',
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'host-card-empty',
    name: 'Card Empty',
    address: '10.0.0.20',
    port: 22,
    username: 'root',
    group: '',
    tags: [],
    note: '',
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'host-list-empty',
    name: 'List Empty',
    address: '10.0.0.30',
    port: 22,
    username: 'root',
    group: '',
    tags: [],
    note: '',
    createdAt: now,
    updatedAt: now,
  },
];

async function gotoSeededHostPage(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('region', { name: '全部主机' })).toBeVisible();
  await page.evaluate(async (hosts) => {
    const snapshot = await window.guiSSH.vault.getSnapshot();
    await window.guiSSH.vault.saveCollections({
      hosts,
      sshKeys: snapshot.sshKeys,
      proxyProfiles: snapshot.proxyProfiles,
      knownHosts: snapshot.knownHosts,
      settings: snapshot.settings,
    });
  }, seededHosts);
  await page.getByRole('button', { name: '刷新主机列表' }).click();
  await expect(page.getByText('Production Web', { exact: true })).toBeVisible();
}

async function expectCheckedOptionToBeReadable(select: Locator) {
  const metrics = await select.locator('option:checked').evaluate((option) => {
    const style = getComputedStyle(option);
    const sampleColor = (color: string) => {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext('2d')!;
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    };
    const luminance = ([red, green, blue]: number[]) => {
      const linear = [red, green, blue].map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    };
    const background = sampleColor(style.backgroundColor);
    const foreground = sampleColor(style.color);
    const backgroundLuminance = luminance(background);
    const foregroundLuminance = luminance(foreground);

    return {
      backgroundAlpha: background[3],
      contrastRatio: (Math.max(backgroundLuminance, foregroundLuminance) + 0.05)
        / (Math.min(backgroundLuminance, foregroundLuminance) + 0.05),
    };
  });

  expect(metrics.backgroundAlpha).toBe(255);
  expect(metrics.contrastRatio).toBeGreaterThanOrEqual(4.5);
}

test('host editor reuses existing groups and tags while preserving custom input', async ({ page }) => {
  await gotoSeededHostPage(page);
  await page.getByRole('button', { name: '添加主机' }).click();

  const editor = page.getByRole('complementary', { name: '新建主机' });
  const groupInput = editor.getByLabel('分组', { exact: true });
  const tagsInput = editor.getByLabel('标签', { exact: true });

  await expect(editor.getByText('保活', { exact: true })).toBeVisible();
  await expect(editor.getByText('定期发送心跳包防止连接因空闲断开', { exact: true })).toBeVisible();
  await expect(editor.getByText('心跳间隔（秒）', { exact: true })).toBeVisible();
  await expect(editor.getByText('host.ssh.keepalive', { exact: true })).toHaveCount(0);
  await expect(editor.getByText('host.ssh.keepaliveDescription', { exact: true })).toHaveCount(0);
  await expect(editor.getByText('host.ssh.keepaliveInterval', { exact: true })).toHaveCount(0);

  await expect(editor.getByRole('button', { name: 'Production', exact: true })).toBeVisible();
  await expect(editor.getByRole('button', { name: 'linux', exact: true })).toBeVisible();
  await expect(editor.getByRole('button', { name: 'prod', exact: true })).toBeVisible();

  await editor.getByRole('button', { name: 'Production', exact: true }).click();
  await editor.getByRole('button', { name: 'linux', exact: true }).click();
  await expect(groupInput).toHaveValue('Production');
  await expect(tagsInput).toHaveValue('linux');

  await groupInput.fill('Staging');
  await tagsInput.fill('windows, staging');
  await expect(groupInput).toHaveValue('Staging');
  await expect(tagsInput).toHaveValue('windows, staging');
});

test('empty metadata can be assigned from cards and list rows, and card actions show icons', async ({ page }) => {
  await gotoSeededHostPage(page);
  await page.getByRole('button', { name: '卡片模式' }).click();

  const card = page.locator('.host-list-card').filter({ hasText: 'Card Empty' });
  await expect(card).toHaveCount(1);

  const menuTrigger = card.locator('summary[aria-label="主机操作"]');
  await menuTrigger.click();
  await expect(card.getByRole('button', { name: '编辑' }).locator('svg')).toHaveCount(1);
  await expect(card.getByRole('button', { name: '删除' }).locator('svg')).toHaveCount(1);
  await menuTrigger.click();

  const cardGroupSelect = card.locator('select[aria-label="为主机选择分组"]');
  const cardTagSelect = card.locator('select[aria-label="为主机选择标签"]');
  for (const theme of ['dark', 'light']) {
    await page.evaluate((nextTheme) => {
      document.documentElement.dataset.theme = nextTheme;
    }, theme);
    await expectCheckedOptionToBeReadable(cardGroupSelect);
    await expectCheckedOptionToBeReadable(cardTagSelect);
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });

  await cardGroupSelect.selectOption('Production');
  await expect(card.getByText('Production', { exact: true })).toBeVisible();
  await cardTagSelect.selectOption('linux');
  await expect(card.getByText('linux', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '列表模式' }).click();
  const row = page.getByRole('row').filter({ hasText: 'List Empty' });
  await expect(row).toHaveCount(1);
  await row.locator('select[aria-label="为主机选择分组"]').selectOption('Production');
  await row.locator('select[aria-label="为主机选择标签"]').selectOption('prod');
  await expect(row.getByText('Production', { exact: true })).toBeVisible();
  await expect(row.getByText('prod', { exact: true })).toBeVisible();
});
