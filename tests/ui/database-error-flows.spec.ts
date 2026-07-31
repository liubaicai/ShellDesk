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

async function setComponentInlineSize(component: Locator, width: number) {
  await component.evaluate((node, inlineSize) => {
    const element = node as HTMLElement;
    element.style.inlineSize = `${inlineSize}px`;
    element.style.maxInlineSize = `${inlineSize}px`;
    element.style.flex = '0 0 auto';
  }, width);
}

async function gotoHarness(page: Page, query: string) {
  await page.goto(`/tests/ui/database-error-harness.html?${query}`, { waitUntil: 'domcontentloaded' });
}

async function expectMonitorPaneOwnsLayout(page: Page) {
  const layout = await page.locator('.monitor-pane').evaluate((node) => {
    const style = window.getComputedStyle(node);
    return {
      display: style.display,
      gap: style.gap,
      padding: style.padding,
      minHeight: style.minHeight,
      backgroundImage: style.backgroundImage,
      clientHeight: node.clientHeight,
      parentClientHeight: node.parentElement?.clientHeight ?? -1,
    };
  });

  expect(layout).toMatchObject({
    display: 'grid',
    gap: '10px',
    padding: '0px',
    minHeight: '0px',
  });
  expect(layout.backgroundImage).toContain('linear-gradient');
  expect(layout.clientHeight).toBe(layout.parentClientHeight);
}

test('Shared editor theme subscribers update without losing content', async ({ page }) => {
  await gotoHarness(page, 'component=editor-theme-subscribers&theme=dark');

  const firstSubscriber = page.getByTestId('editor-theme-first');
  const secondSubscriber = page.getByTestId('editor-theme-second');
  const firstContent = page.getByRole('textbox', { name: 'first editor content' });
  const secondContent = page.getByRole('textbox', { name: 'second editor content' });

  await expect(firstSubscriber).toHaveAttribute('data-editor-theme', 'dark');
  await expect(secondSubscriber).toHaveAttribute('data-editor-theme', 'dark');

  await firstContent.fill('SELECT current_database();');
  await secondContent.fill('{"enabled":false,"retries":3}');

  await page.getByRole('button', { name: 'Switch to light theme' }).click();

  await expect(firstSubscriber).toHaveAttribute('data-editor-theme', 'light');
  await expect(secondSubscriber).toHaveAttribute('data-editor-theme', 'light');
  await expect(firstContent).toHaveValue('SELECT current_database();');
  await expect(secondContent).toHaveValue('{"enabled":false,"retries":3}');

  await page.getByRole('button', { name: 'Hide all editors' }).click();
  await expect(firstSubscriber).toHaveCount(0);
  await expect(secondSubscriber).toHaveCount(0);
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  await page.getByRole('button', { name: 'Show all editors' }).click();

  await expect(firstSubscriber).toHaveAttribute('data-editor-theme', 'dark');
  await expect(secondSubscriber).toHaveAttribute('data-editor-theme', 'dark');
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  await expect(firstSubscriber).toHaveAttribute('data-editor-theme', 'light');
  await expect(secondSubscriber).toHaveAttribute('data-editor-theme', 'light');
});

test('MySQL editor consumes the shared theme without replacing its document', async ({ page }) => {
  await gotoHarness(page, 'component=mysql&theme=dark');
  await page.getByTestId('mysql-connect-submit').click();

  const editorContent = page.locator('.mysql-sql-editor .cm-content');
  await expect(editorContent).toBeVisible();
  await editorContent.fill('SELECT 42 AS answer;');
  await expect(editorContent).toContainText('SELECT 42 AS answer;');

  const editor = page.locator('.mysql-sql-editor .cm-editor');
  const darkBackground = await editor.evaluate((node) => window.getComputedStyle(node).backgroundColor);
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));

  await expect.poll(
    () => editor.evaluate((node) => window.getComputedStyle(node).backgroundColor),
  ).not.toBe(darkBackground);
  await expect(editorContent).toContainText('SELECT 42 AS answer;');
});

test('Desktop icons keep a fixed image row when labels wrap and artwork fills each PNG', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 420 });
  await gotoHarness(page, 'component=desktop-icons&theme=dark');

  const buttons = page.locator('.desktop-icons > .desktop-icon-button');
  await expect(buttons).toHaveCount(6);
  await expect(page.getByRole('button', { name: '记事本', exact: true })).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
  });

  const layout = await buttons.evaluateAll((elements) => elements.map((element) => {
    const icon = element.querySelector<HTMLElement>('.desktop-app-icon-shell');
    const label = element.querySelector<HTMLElement>('strong');
    const range = document.createRange();
    range.selectNodeContents(label!);

    return {
      appKey: (element as HTMLElement).dataset.appKey,
      iconTop: icon!.getBoundingClientRect().top,
      labelLines: range.getClientRects().length,
    };
  }));

  const byAppKey = new Map(layout.map((item) => [item.appKey, item]));
  expect(byAppKey.get('notepad')!.iconTop).toBeCloseTo(byAppKey.get('supervisor-manager')!.iconTop, 1);
  expect(byAppKey.get('code-editor')!.iconTop).toBeCloseTo(byAppKey.get('backup-manager')!.iconTop, 1);
  expect(byAppKey.get('browser')!.iconTop).toBeCloseTo(byAppKey.get('rdp-viewer')!.iconTop, 1);
  expect(byAppKey.get('notepad')!.labelLines).toBe(1);
  expect(byAppKey.get('supervisor-manager')!.labelLines).toBeGreaterThan(1);
  expect(byAppKey.get('rdp-viewer')!.labelLines).toBeGreaterThan(1);

  const artwork = await page.locator(
    '[data-app-key="backup-manager"] img, [data-app-key="rdp-viewer"] img',
  ).evaluateAll(async (images) => Promise.all(images.map(async (image) => {
    const img = image as HTMLImageElement;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(img, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let minX = canvas.width;
    let minY = canvas.height;
    let maxX = -1;
    let maxY = -1;

    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] <= 4) continue;
      const pixelIndex = (index - 3) / 4;
      const x = pixelIndex % canvas.width;
      const y = Math.floor(pixelIndex / canvas.width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }

    return {
      appKey: img.closest<HTMLElement>('[data-app-key]')!.dataset.appKey,
      width: canvas.width,
      height: canvas.height,
      bounds: [minX, minY, maxX + 1, maxY + 1],
    };
  })));

  expect(artwork).toEqual([
    { appKey: 'backup-manager', width: 220, height: 220, bounds: [0, 0, 220, 220] },
    { appKey: 'rdp-viewer', width: 220, height: 220, bounds: [0, 0, 220, 220] },
  ]);
});

test('Supervisor manager covers process actions, logs, and read-only config preview', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 760 });
  await gotoHarness(page, 'component=supervisor-manager&theme=dark');

  await expect(page.getByRole('heading', { name: 'Supervisor 管理' })).toBeVisible();
  await expect(page.getByText('Supervisor 服务可用')).toBeVisible();
  await expect(page.locator('.supervisor-stat-grid article').nth(0)).toContainText('4');
  await expect(page.locator('.supervisor-stat-grid article').nth(1)).toContainText('2');

  await page.getByRole('tab', { name: /进程列表/ }).click();
  await expect(page.locator('.supervisor-table tbody tr')).toHaveCount(4);
  await page.getByRole('checkbox', { name: '选择进程 web' }).check();
  await page.getByRole('checkbox', { name: '选择进程 queue:worker' }).check();
  await page.locator('.supervisor-batch-actions').getByRole('button', { name: '停止' }).click();

  const confirmDialog = page.getByRole('alertdialog');
  await expect(confirmDialog).toContainText('将对 2 个进程执行“停止”');
  await expectElementTopmost(confirmDialog);
  await confirmDialog.getByRole('button', { name: '确认执行' }).click();
  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & { __shellDeskUiHarnessLastSupervisorActionCommand?: string })
      .__shellDeskUiHarnessLastSupervisorActionCommand
  ))).toContain("supervisorctl stop 'web' 'queue:worker'");

  await page.locator('.supervisor-process-link').filter({ hasText: 'web' }).first().click();
  await expect(page.getByRole('tab', { name: '进程日志' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.supervisor-log-output')).toContainText('web stdout line 1');

  await page.getByRole('tab', { name: '概览' }).click();
  await page.locator('.supervisor-config-list button').filter({ hasText: 'web.conf' }).click();
  await expect(page.locator('.supervisor-config-preview')).toContainText('[program:web]');

  const supervisorManager = page.locator('.supervisor-manager');
  await setComponentInlineSize(supervisorManager, 620);
  await expect(supervisorManager.locator('.supervisor-header')).toHaveCSS('flex-direction', 'column');
});

test('Backup manager creates, validates, downloads, restores, and schedules without exposing credentials', async ({ page }) => {
  await page.setViewportSize({ width: 1220, height: 780 });
  await gotoHarness(page, 'component=backup-manager&theme=dark');

  await expect(page.getByRole('heading', { name: '备份管理' })).toBeVisible();
  await expect(page.locator('.backup-manager-stats article').nth(0)).toContainText('2');
  await page.getByRole('button', { name: 'MySQL', exact: true }).click();
  await page.getByLabel('用户名').fill('backup_user');
  await page.getByLabel('密码').fill('mock-backup-secret');
  await expect(page.locator('.backup-preview-card code')).not.toContainText('mock-backup-secret');

  await page.getByRole('button', { name: '开始备份' }).click();
  await expect(page.getByRole('tab', { name: '备份历史' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.backup-table-frame tbody tr')).toHaveCount(3);

  const capturedBackup = await page.evaluate(() => {
    const harnessWindow = window as typeof window & {
      __shellDeskUiHarnessLastBackupCommand?: string;
      __shellDeskUiHarnessLastBackupStdin?: string;
    };
    return {
      command: harnessWindow.__shellDeskUiHarnessLastBackupCommand,
      stdin: harnessWindow.__shellDeskUiHarnessLastBackupStdin,
    };
  });
  expect(capturedBackup.command).toBe('sh -s');
  expect(capturedBackup.command).not.toContain('mock-backup-secret');
  expect(capturedBackup.stdin).toContain("MYSQL_PWD='mock-backup-secret'");

  const mysqlRow = page.locator('.backup-table-frame tbody tr').filter({ hasText: 'shelldesk-mysql-production' });
  await mysqlRow.getByRole('button', { name: '校验' }).click();
  await expect(page.locator('.backup-validation-card')).toContainText('abcdef0123456789');
  await mysqlRow.getByRole('button', { name: '下载' }).click();
  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & { __shellDeskUiHarnessLastBackupDownloadPath?: string })
      .__shellDeskUiHarnessLastBackupDownloadPath
  ))).toContain('shelldesk-mysql-production');

  const fileRow = page.locator('.backup-table-frame tbody tr').filter({ hasText: 'shelldesk-files-assets' });
  await fileRow.getByRole('button', { name: '恢复' }).click();
  const restoreDialog = page.getByRole('alertdialog');
  await expect(restoreDialog).toContainText('ShellDesk 会先校验');
  await expectElementTopmost(restoreDialog);
  await restoreDialog.getByLabel('恢复目标').fill('/srv/restored-assets');
  await restoreDialog.getByRole('button', { name: '确认执行' }).click();
  await expect(page.getByText('备份已恢复到 /srv/restored-assets。')).toBeVisible();

  await page.getByRole('tab', { name: '计划任务' }).click();
  await page.getByRole('button', { name: '保存计划' }).click();
  await expect(page.locator('.backup-plan-list article')).toHaveCount(1);
  const planStdin = await page.evaluate(() => (
    (window as typeof window & { __shellDeskUiHarnessLastBackupPlanStdin?: string })
      .__shellDeskUiHarnessLastBackupPlanStdin
  ));
  expect(planStdin).toContain('# SHELLDESK_BACKUP:mysql-production|');
  expect(planStdin).not.toContain('mock-backup-secret');

  await page.getByRole('tab', { name: '创建备份' }).click();
  await page.getByRole('button', { name: '上传 S3 / MinIO' }).click();
  await page.getByLabel('Endpoint').fill('https://minio.example.test');
  await page.getByLabel('Access Key').fill('mock-s3-access');
  await page.getByLabel('Secret Key').fill('mock-s3-secret');
  await page.getByLabel('Bucket').fill('backups');
  await page.getByRole('button', { name: '开始备份' }).click();

  const capturedS3Upload = await page.evaluate(() => {
    const harnessWindow = window as typeof window & {
      __shellDeskUiHarnessLastBackupS3Command?: string;
      __shellDeskUiHarnessLastBackupS3Stdin?: string;
    };
    return {
      command: harnessWindow.__shellDeskUiHarnessLastBackupS3Command,
      stdin: harnessWindow.__shellDeskUiHarnessLastBackupS3Stdin,
    };
  });
  expect(capturedS3Upload.command).toBe('sh -s');
  expect(capturedS3Upload.command).not.toContain('mock-s3-secret');
  expect(capturedS3Upload.stdin).toContain('mock-s3-secret');

  const backupManager = page.locator('.backup-manager');
  await setComponentInlineSize(backupManager, 680);
  await expect(backupManager.locator('.backup-manager-header')).toHaveCSS('flex-direction', 'column');
});

test('RDP viewer initializes IronRDP and probes the tunneled target without persisting a password', async ({ page }) => {
  test.setTimeout(60_000);
  const runtimeErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(message.text());
  });
  page.on('pageerror', (error) => {
    runtimeErrors.push(error.message);
  });
  await page.setViewportSize({ width: 1220, height: 760 });
  await gotoHarness(page, 'component=rdp-viewer&theme=dark');

  await expect(page.getByText('Windows 桌面已准备连接')).toBeVisible({ timeout: 40_000 });
  await expect(page.getByText('SSH 隧道', { exact: true })).toBeVisible();
  await page.getByLabel('RDP 主机').fill('10.20.30.40');
  await page.getByLabel('端口').fill('3390');
  await page.getByLabel('用户名').fill('Administrator');
  await page.getByLabel('域').fill('EXAMPLE');
  await page.getByLabel('密码').fill('ui-only-rdp-secret');
  const diagnostics = page.locator('.rdp-diagnostics');
  await expect(diagnostics.getByText('开始探测或连接后会显示阶段信息。')).toBeVisible();
  await page.getByRole('button', { name: '探测' }).click();

  await expect(page.getByText('RDP 服务探测成功，安全协议：CredSSP Extended。')).toBeVisible();
  await expect(diagnostics.getByText('Checking RDP target 10.20.30.40:3390')).toBeVisible();
  await expect(diagnostics.getByText('RDP negotiation completed.')).toBeVisible();
  await expect(diagnostics.locator('.rdp-diagnostic-empty')).toHaveCount(0);
  await expect(page.getByLabel('密码')).toHaveValue('ui-only-rdp-secret');
  await expect(page.locator('.rdp-statusbar')).toContainText('10.20.30.40:3390');
  await expect(page.getByLabel('色深')).toHaveValue('16');

  await page.getByTitle('显示设置面板').click();
  await expect(page.locator('.rdp-inspector')).toBeHidden();
  await expect(page.locator('.rdp-stage')).toBeVisible();

  const rdpViewer = page.locator('.rdp-viewer');
  await setComponentInlineSize(rdpViewer, 520);
  const [hostBox, portBox] = await Promise.all([
    page.getByLabel('RDP 主机').boundingBox(),
    page.getByLabel('端口').boundingBox(),
  ]);
  expect(hostBox).not.toBeNull();
  expect(portBox).not.toBeNull();
  expect(Math.abs(portBox!.x - hostBox!.x)).toBeLessThanOrEqual(1);
  expect(portBox!.y).toBeGreaterThan(hostBox!.y + hostBox!.height);

  await gotoHarness(page, 'component=rdp-viewer&theme=light');
  const lightEmptyState = page.locator('.rdp-empty-state');
  await expect(lightEmptyState.getByText('Windows 桌面已准备连接')).toBeVisible({ timeout: 40_000 });
  await expect(lightEmptyState.locator('strong')).toHaveCSS('color', 'rgb(241, 247, 255)');
  expect(runtimeErrors).toEqual([]);
});

test('host table keeps every cell border aligned when tags wrap', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 420 });
  await gotoHarness(page, 'component=host-list&theme=dark');

  const wrappedRow = page.locator('.host-table tbody tr').first();
  await expect(wrappedRow.locator('.host-tag-cell .host-chip')).toHaveCount(2);
  const cellMetrics = await wrappedRow.locator('td').evaluateAll((cells) => cells.map((cell) => {
    const bounds = cell.getBoundingClientRect();
    return {
      display: getComputedStyle(cell).display,
      height: bounds.height,
      bottom: bounds.bottom,
    };
  }));

  expect(cellMetrics).toHaveLength(8);
  expect(cellMetrics.every(({ display }) => display === 'table-cell')).toBe(true);
  expect(new Set(cellMetrics.map(({ height }) => Math.round(height))).size).toBe(1);
  expect(new Set(cellMetrics.map(({ bottom }) => Math.round(bottom))).size).toBe(1);
});

test('host inventory keyboard navigation crosses pages and opens the selected host', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 420 });
  await gotoHarness(page, 'component=host-list-keyboard&theme=dark');

  const hostList = page.locator('.host-table-frame');
  await hostList.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-host-id="large-host-1"]')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('PageDown');
  await expect(page.getByRole('button', { name: '2', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('[data-host-id="large-host-11"]')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(page.getByRole('button', { name: '3', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('[data-host-id="large-host-25"]')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('opened-host')).toHaveText('large-host-25');
});

test('SD-Agent host picker virtualizes 5000 hosts and supports keyboard search', async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(message.text());
  });
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  await page.setViewportSize({ width: 420, height: 700 });
  await gotoHarness(page, 'component=agent-host-picker&theme=dark');
  expect(runtimeErrors).toEqual([]);

  const listbox = page.getByRole('listbox', { name: 'SD-Agent 主机列表' });
  await expect(listbox).toBeVisible();
  const renderedOptionCount = await listbox.getByRole('option').count();
  expect(renderedOptionCount).toBeGreaterThan(5);
  expect(renderedOptionCount).toBeLessThan(40);
  await listbox.focus();
  await page.keyboard.press('End');
  await expect(listbox).toHaveAttribute('aria-activedescendant', 'agent-host-option-agent-host-05000');
  await expect(listbox.getByRole('option', { name: /Agent host 05000/ })).toBeVisible();

  const search = page.getByRole('searchbox', { name: '搜索 SD-Agent 主机' });
  await search.fill('host-04200.example.test');
  await expect(listbox.getByRole('option')).toHaveCount(1);
  await listbox.focus();
  await page.keyboard.press('ArrowDown');
  await expect(listbox).toHaveAttribute('aria-activedescendant', 'agent-host-option-agent-host-04200');
  await expect(page.getByText('1/5000')).toBeVisible();
  expect(runtimeErrors).toEqual([]);
});

test('host migration previews duplicates and applies the selected strategy', async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(message.text());
  });
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 860 });
  await gotoHarness(page, 'component=host-import&theme=dark');

  const openButton = page.getByRole('button', { name: '打开主机迁移' });
  await openButton.click();
  const dialog = page.getByRole('dialog', { name: '迁移外部 SSH 主机' });
  await expect(dialog).toBeVisible();
  const selectFilesButton = dialog.getByRole('button', { name: '选择迁移文件' });
  await expect(selectFilesButton).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(openButton).toBeFocused();
  await openButton.click();
  await expect(dialog).toBeVisible();
  await expect(selectFilesButton).toBeFocused();
  await selectFilesButton.click();
  await expect(dialog.getByText('已选择 2 个文件')).toBeVisible();
  await expect(dialog.getByText('识别 3 台')).toBeVisible();
  await expect(dialog.getByText('已选 2 台')).toBeVisible();
  await expect(dialog.getByText('重复 1 台')).toBeVisible();
  await expect(dialog.getByText('Existing web', { exact: true })).toBeVisible();
  await expect(dialog.getByText('New database', { exact: true })).toBeVisible();
  await expect(dialog.getByText('缺少主机地址。')).toBeVisible();
  await expect(dialog.getByText('导入 CSV 中发现的 2 个明文密码（默认关闭）')).toBeVisible();

  await dialog.getByLabel('重复项处理').selectOption('replace');
  await dialog.getByRole('button', { name: '导入 2 台' }).click();
  await expect(dialog.getByText('主机迁移已应用')).toBeVisible();
  await expect(dialog.getByText('新增 1 台，替换 1 台，跳过 0 台。')).toBeVisible();
  await dialog.getByRole('button', { name: '完成' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(openButton).toBeFocused();
  expect(runtimeErrors).toEqual([]);
});

test('global transfer center keeps active work while clearing finished history', async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(message.text());
  });
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoHarness(page, 'component=transfer-center&theme=light');
  await page.waitForTimeout(500);
  expect(runtimeErrors).toEqual([]);

  const trigger = page.getByRole('button', { name: '全局传输中心' });
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(trigger.locator('.global-transfer-badge')).toHaveText('1');
  await trigger.click();

  const dialog = page.getByRole('dialog', { name: '全局传输中心' });
  await expect(dialog).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(dialog.getByText('release.zip', { exact: true })).toBeVisible();
  await expect(dialog.getByText('access.log', { exact: true })).toBeVisible();
  await expect(dialog.locator('.global-transfer-progress').first()).toHaveAttribute('aria-label', '50%');

  await dialog.getByRole('button', { name: '清除已结束' }).click();
  await expect(dialog.getByText('release.zip', { exact: true })).toBeVisible();
  await expect(dialog.getByText('access.log', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: '关闭传输中心' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(runtimeErrors).toEqual([]);
});

test('SFTP directory trees stay rooted and activate the current folder', async ({ page }) => {
  test.setTimeout(90_000);
  const runtimeErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(message.text());
  });
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoHarness(page, 'component=sftp-transfer&theme=light');

  const localPane = page.locator('.sftp-file-pane.local');
  const remotePane = page.locator('.sftp-file-pane.remote');
  const localPath = localPane.locator('.sftp-path-form input');
  const remotePath = remotePane.locator('.sftp-path-form input');

  await expect(localPane.locator('.sftp-directory-tree').getByRole('button', { name: '/', exact: true })).toBeVisible();
  await expect(remotePane.locator('.sftp-directory-tree').getByRole('button', { name: '/', exact: true })).toBeVisible();
  await expect(localPane.locator('.tree-row[aria-current="location"] .tree-label')).toHaveText('/');
  await expect(remotePane.locator('.tree-row[aria-current="location"] .tree-label')).toHaveText('root');

  await localPane.getByRole('button', { name: 'D:', exact: true }).click();
  await localPane.getByRole('button', { name: 'ui-test', exact: true }).click();
  await expect(localPath).toHaveValue('D:/ui-test');

  await localPane.getByRole('button', { name: '展开 shared-folder' }).click();
  await expect(localPane.getByRole('button', { name: 'local-nested-folder', exact: true })).toBeVisible();
  await localPane.getByRole('button', { name: '展开 local-nested-folder' }).click();
  await expect(localPane.getByRole('button', { name: 'local-deep-folder', exact: true })).toBeVisible();
  await expect(localPath).toHaveValue('D:/ui-test');
  await expect(localPane.getByText('local-01.txt', { exact: true })).toBeVisible();

  await remotePane.getByRole('button', { name: '展开 shared-folder' }).click();
  await expect(remotePane.getByRole('button', { name: 'remote-nested-folder', exact: true })).toBeVisible();
  await remotePane.getByRole('button', { name: '展开 remote-nested-folder' }).click();
  await expect(remotePane.getByRole('button', { name: 'remote-deep-folder', exact: true })).toBeVisible();
  await expect(remotePath).toHaveValue('/root');
  await expect(remotePane.getByText('remote-01.txt', { exact: true })).toBeVisible();

  await localPane.getByRole('button', { name: 'shared-folder', exact: true }).click();
  await expect(localPath).toHaveValue('D:/ui-test/shared-folder');
  await expect(localPane.getByText('local-nested-file.txt', { exact: true })).toBeVisible();
  await expect(localPane.locator('.sftp-directory-tree').getByRole('button', { name: '/', exact: true })).toBeVisible();
  await expect(localPane.locator('.tree-row[aria-current="location"] .tree-label')).toHaveText('shared-folder');
  await expect(localPane.getByRole('button', { name: 'local-deep-folder', exact: true })).toBeVisible();

  await remotePane.getByRole('button', { name: 'shared-folder', exact: true }).click();
  await expect(remotePath).toHaveValue('/root/shared-folder');
  await expect(remotePane.locator('.sftp-directory-tree').getByRole('button', { name: '/', exact: true })).toBeVisible();
  await expect(remotePane.locator('.tree-row[aria-current="location"] .tree-label')).toHaveText('shared-folder');
  await expect(remotePane.getByRole('button', { name: 'remote-deep-folder', exact: true })).toBeVisible();
  expect(runtimeErrors).toEqual([]);
});

test('SFTP transfer queue toolbar button toggles the queue and releases its space', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoHarness(page, 'component=sftp-transfer&theme=light');

  const queueToggle = page.locator('.sftp-command-toolbar').getByRole('button', { name: '传输队列', exact: true });
  const queue = page.locator('#sftp-transfer-queue');
  const dualPane = page.locator('.sftp-dual-pane');

  await expect(queue).toBeVisible();
  await expect(queueToggle).toHaveAttribute('aria-pressed', 'true');
  const expandedPaneBox = await dualPane.boundingBox();
  expect(expandedPaneBox).not.toBeNull();

  await queueToggle.click();
  await expect(queue).toHaveCount(0);
  await expect(queueToggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.sftp-transfer-workspace')).toHaveClass(/queue-hidden/);
  const collapsedPaneBox = await dualPane.boundingBox();
  expect(collapsedPaneBox).not.toBeNull();
  expect(collapsedPaneBox!.height).toBeGreaterThan(expandedPaneBox!.height + 100);

  await queueToggle.click();
  await expect(queue).toBeVisible();
  await expect(queueToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.sftp-transfer-workspace')).not.toHaveClass(/queue-hidden/);
});

test('restored terminal workspace stays disconnected until the manual reconnect action', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 760 });
  await gotoHarness(page, 'component=terminal-restore&theme=dark');

  const placeholder = page.getByRole('region', { name: '已恢复的终端位置' });
  await expect(placeholder).toContainText('ShellDesk 只恢复了安全元数据');
  await expect(placeholder.getByText('/srv/app', { exact: true })).toBeVisible();
  await expect(page.getByTestId('manual-terminal-connected')).toHaveCount(0);

  await placeholder.getByRole('button', { name: '手动重新连接' }).click();
  await expect(page.getByTestId('manual-terminal-connected')).toBeVisible();
  await expect(placeholder).toHaveCount(0);
});

test('saved SSH forwarding can be created, started, and deleted with confirmation', async ({ page }) => {
  await gotoHarness(page, 'component=port-forwarding&theme=dark');

  await expect(page.getByText('PostgreSQL', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '启动', exact: true }).click();
  await expect(page.getByText('运行中', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '新建转发' }).click();
  await page.getByLabel('名称').fill('Internal SOCKS');
  await page.getByLabel('转发类型').selectOption('dynamic');
  await page.getByLabel('监听端口（0 为自动）').fill('0');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('Internal SOCKS', { exact: true })).toBeVisible();
  await expect(page.getByText(/动态 SOCKS5/)).toBeVisible();

  const createdCard = page.locator('.port-forward-card').filter({ hasText: 'Internal SOCKS' });
  await createdCard.getByRole('button', { name: '删除', exact: true }).click();
  await expect(createdCard.getByRole('button', { name: '再次点击确认删除' })).toBeVisible();
  await createdCard.getByRole('button', { name: '再次点击确认删除' }).click();
  await expect(page.getByText('Internal SOCKS', { exact: true })).toHaveCount(0);
});

test('SFTP directory tree dividers resize both panes independently', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoHarness(page, 'component=sftp-transfer&theme=light');

  const localPane = page.locator('.sftp-file-pane.local');
  const remotePane = page.locator('.sftp-file-pane.remote');
  const localTree = localPane.locator('.sftp-directory-tree');
  const remoteTree = remotePane.locator('.sftp-directory-tree');
  const localFileList = localPane.locator('.sftp-file-table-frame');
  const remoteFileList = remotePane.locator('.sftp-file-table-frame');
  const localDivider = localPane.getByRole('separator', { name: '本地 · 调整目录树宽度' });
  const remoteDivider = remotePane.getByRole('separator', { name: '远程 · 调整目录树宽度' });
  const localWidthBefore = (await localTree.boundingBox())!.width;
  const remoteWidthBefore = (await remoteTree.boundingBox())!.width;
  const [localTreeScrollbar, localFileScrollbar, remoteTreeScrollbar, remoteFileScrollbar] = await Promise.all([
    localTree.evaluate((element) => getComputedStyle(element).scrollbarColor),
    localFileList.evaluate((element) => getComputedStyle(element).scrollbarColor),
    remoteTree.evaluate((element) => getComputedStyle(element).scrollbarColor),
    remoteFileList.evaluate((element) => getComputedStyle(element).scrollbarColor),
  ]);
  expect(localTreeScrollbar).toBe(localFileScrollbar);
  expect(remoteTreeScrollbar).toBe(remoteFileScrollbar);
  expect(localTreeScrollbar).not.toBe('auto');
  const [localTreeThumb, localFileThumb] = await Promise.all([
    localTree.evaluate((element) => getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor),
    localFileList.evaluate((element) => getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor),
  ]);
  expect(localTreeThumb).toBe(localFileThumb);
  expect(localTreeThumb).toBe('rgb(51, 69, 90)');
  const localDividerBox = await localDivider.boundingBox();
  expect(localDividerBox).not.toBeNull();

  await page.mouse.move(localDividerBox!.x + localDividerBox!.width / 2, localDividerBox!.y + 80);
  await page.mouse.down();
  await page.mouse.move(localDividerBox!.x + 72, localDividerBox!.y + 80, { steps: 5 });
  await page.mouse.up();

  const localWidthAfter = (await localTree.boundingBox())!.width;
  const remoteWidthAfterLocalDrag = (await remoteTree.boundingBox())!.width;
  expect(localWidthAfter).toBeGreaterThan(localWidthBefore + 55);
  expect(Math.abs(remoteWidthAfterLocalDrag - remoteWidthBefore)).toBeLessThan(2);
  await expect(localDivider).toHaveAttribute('aria-valuenow', String(Math.round(localWidthAfter)));

  await remoteDivider.press('ArrowRight');
  const remoteWidthAfterKeyboard = (await remoteTree.boundingBox())!.width;
  expect(remoteWidthAfterKeyboard).toBeGreaterThan(remoteWidthBefore + 10);
  await expect(remotePane.locator('.sftp-file-table-frame')).toBeVisible();
});

test('Host table scrollbar corner follows the active theme surface', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 640, height: 480 });
  await gotoHarness(page, 'component=host-table-scroll&theme=dark');

  const tableScroll = page.locator('.host-table-scroll');
  await expect(tableScroll).toBeVisible();
  const darkThemeMetrics = await tableScroll.evaluate((element) => ({
    horizontalOverflow: element.scrollWidth - element.clientWidth,
    verticalOverflow: element.scrollHeight - element.clientHeight,
    surface: getComputedStyle(element.closest('.host-table-frame')!).backgroundColor,
    corner: getComputedStyle(element, '::-webkit-scrollbar-corner').backgroundColor,
  }));
  expect(darkThemeMetrics.horizontalOverflow).toBeGreaterThan(0);
  expect(darkThemeMetrics.verticalOverflow).toBeGreaterThan(0);
  expect(darkThemeMetrics.corner).toBe(darkThemeMetrics.surface);
  expect(darkThemeMetrics.corner).not.toBe('rgb(255, 255, 255)');

  await gotoHarness(page, 'component=host-table-scroll&theme=light');
  const lightThemeMetrics = await tableScroll.evaluate((element) => ({
    surface: getComputedStyle(element.closest('.host-table-frame')!).backgroundColor,
    corner: getComputedStyle(element, '::-webkit-scrollbar-corner').backgroundColor,
  }));
  expect(lightThemeMetrics.corner).toBe(lightThemeMetrics.surface);
});

test('SFTP toolbar keeps transfers in the middle rail and recursive skip reaches the backend', async ({ page }) => {
  test.setTimeout(60_000);
  const runtimeErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(message.text());
  });
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoHarness(page, 'component=sftp-transfer&theme=light');

  const commandToolbar = page.locator('.sftp-command-toolbar');
  await expect(commandToolbar.getByRole('button', { name: '上传', exact: true })).toHaveCount(0);
  await expect(commandToolbar.getByRole('button', { name: '下载', exact: true })).toHaveCount(0);

  const selectedTreeItems = page.locator('.sftp-directory-tree .tree-row.selected');
  await expect(selectedTreeItems).toHaveCount(2);
  await expect(selectedTreeItems.nth(0)).toHaveCSS('background-color', 'rgb(222, 235, 245)');
  await expect(selectedTreeItems.nth(1)).toHaveCSS('background-color', 'rgb(222, 235, 245)');
  const transferButtons = page.locator('.sftp-transfer-rail button');
  await expect(transferButtons).toHaveCount(3);
  await expect(transferButtons.nth(0)).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  const queueSelects = page.locator('.sftp-queue-footer select');
  await expect(queueSelects).toHaveCount(3);
  await expect(queueSelects.nth(0)).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(queueSelects.nth(1)).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(queueSelects.nth(2)).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  const profileSelect = page.getByLabel('传输模式');
  const concurrencySelect = page.getByLabel('并行任务');
  await expect(profileSelect).toHaveValue('balanced');
  await profileSelect.selectOption('compatibility');
  await expect(concurrencySelect).toBeDisabled();
  await expect(concurrencySelect).toHaveValue('1');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('shelldesk.sftp-transfer-profile'))).toBe('compatibility');
  await commandToolbar.getByRole('button', { name: '传输队列', exact: true }).click();
  await expect(page.locator('#sftp-transfer-queue')).toHaveCount(0);

  const localPane = page.locator('.sftp-file-pane.local');
  await localPane.getByRole('button', { name: 'D:', exact: true }).click();
  await localPane.getByRole('button', { name: 'ui-test', exact: true }).click();

  const frames = page.locator('.sftp-file-table-frame');
  await expect(frames).toHaveCount(2);
  for (let index = 0; index < 2; index += 1) {
    const frame = frames.nth(index);
    await frame.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    const finalRowName = index === 0 ? 'local-72.txt' : 'remote-72.txt';
    const finalRow = frame.getByText(finalRowName, { exact: true });
    await expect(finalRow).toBeVisible();
    const [frameBox, rowBox] = await Promise.all([frame.boundingBox(), finalRow.boundingBox()]);
    expect(frameBox).not.toBeNull();
    expect(rowBox).not.toBeNull();
    expect(rowBox!.y + rowBox!.height).toBeLessThanOrEqual(frameBox!.y + frameBox!.height + 1);
  }

  await frames.nth(0).evaluate((node) => { node.scrollTop = 0; });
  await page.locator('.sftp-file-pane.local tbody tr').filter({ hasText: 'shared-folder' }).click();
  await expect(page.locator('.sftp-file-pane.local tbody tr.selected td').first()).toHaveCSS('background-color', 'rgb(207, 232, 248)');
  await page.locator('.sftp-transfer-rail').getByRole('button', { name: '上传', exact: true }).click();
  const conflictDialog = page.getByRole('dialog', { name: '目标中已存在同名项目' });
  await expect(conflictDialog).toContainText('跳过会继续遍历同名文件夹');
  await conflictDialog.getByRole('button', { name: '跳过已存在项' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__shellDeskUiHarnessLastSftpTransferOptions?.conflictPolicy)).toBe('skip');
  await expect.poll(() => page.evaluate(() => (window as any).__shellDeskUiHarnessLastSftpTransferOptions?.transferProfile)).toBe('compatibility');
  await expect.poll(() => page.evaluate(() => (window as any).__shellDeskUiHarnessSftpRuntimeEnqueueCount)).toBe(1);
  await expect(page.locator('#sftp-transfer-queue')).toBeVisible();
  expect(runtimeErrors).toEqual([]);
});

test('Virtual machine manager follows the dense split-pane reference layout', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1584, height: 992 });
  await gotoHarness(page, 'component=vm-manager');

  await expect(page.getByText('home-ldev.example.com')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /新建虚拟机/ })).toBeVisible();
  await expect(page.locator('.vm-manager-table tbody tr')).toHaveCount(8);
  await page.locator('.vm-manager-table tbody tr').filter({ hasText: 'db-01' }).click();
  await expect(page.locator('.vm-manager-detail-header')).toContainText('db-01');

  const [layoutBox, tableBox, detailBox] = await Promise.all([
    page.locator('.vm-manager-domain-layout').boundingBox(),
    page.locator('.vm-manager-table-panel').boundingBox(),
    page.locator('.vm-manager-detail').boundingBox(),
  ]);
  expect(layoutBox).not.toBeNull();
  expect(tableBox).not.toBeNull();
  expect(detailBox).not.toBeNull();
  expect(tableBox!.width / layoutBox!.width).toBeGreaterThan(0.65);
  expect(tableBox!.width / layoutBox!.width).toBeLessThan(0.7);
  expect(detailBox!.width / layoutBox!.width).toBeGreaterThan(0.3);

  const selectedColor = await page.locator('.vm-manager-table tbody tr.selected').evaluate((node) => getComputedStyle(node).backgroundImage);
  expect(selectedColor).toContain('linear-gradient');
  await page.getByRole('button', { name: /新建虚拟机/ }).click();
  await expect(page.getByRole('dialog', { name: '创建虚拟机' })).toBeVisible();
  await page.getByRole('dialog', { name: '创建虚拟机' }).getByRole('button', { name: '取消' }).click();
});

test('Virtual machine manager creates, configures, and guards deletion through custom dialogs', async ({ page }) => {
  test.setTimeout(90_000);
  await gotoHarness(page, 'component=vm-manager');
  await expect(page.locator('.vm-manager-table tbody tr')).toHaveCount(8);

  await page.getByRole('button', { name: /新建虚拟机/ }).click();
  const createDialog = page.getByRole('dialog', { name: '创建虚拟机' });
  await createDialog.getByLabel('名称').fill('ui-test-vm');
  await createDialog.getByRole('textbox', { name: '存储卷', exact: true }).fill('ui-test-vm.qcow2');
  await createDialog.getByRole('button', { name: '创建虚拟机' }).click();
  await expect(createDialog).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as any).__shellDeskUiHarnessLastVirshCommand as string)).toContain('vol-create-as');
  expect(await page.evaluate(() => (window as any).__shellDeskUiHarnessLastVirshStdin as string)).toContain('<name>ui-test-vm</name>');

  await page.locator('.vm-manager-table tbody tr').filter({ hasText: 'db-01' }).click();
  const detailPanel = page.locator('.vm-manager-detail');
  await detailPanel.getByRole('button', { name: '资源设置' }).click();
  const settingsDialog = page.getByRole('dialog', { name: '资源设置' });
  await settingsDialog.getByLabel('vCPU').fill('6');
  await settingsDialog.getByRole('button', { name: '资源设置' }).click();
  await expect(settingsDialog).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as any).__shellDeskUiHarnessLastVirshCommand as string)).toContain('setvcpus');

  await detailPanel.getByRole('button', { name: '删除虚拟机' }).click();
  const deleteDialog = page.getByRole('alertdialog', { name: '删除虚拟机' });
  const deleteButton = deleteDialog.getByRole('button', { name: '删除虚拟机' });
  await expect(deleteButton).toBeDisabled();
  await deleteDialog.getByLabel('输入“db-01”确认操作').fill('db-01');
  await expect(deleteButton).toBeDisabled();
  await deleteDialog.getByText('先强制停止运行中的虚拟机').click();
  await expect(deleteButton).toBeEnabled();
  await deleteButton.click();
  await expect(deleteDialog).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as any).__shellDeskUiHarnessLastVirshCommand as string)).toContain('undefine');
  expect(await page.evaluate(() => (window as any).__shellDeskUiHarnessLastVirshCommand as string)).not.toContain('--remove-all-storage');

  await page.locator('.vm-manager-table tbody tr').filter({ hasText: 'db-01' }).click();
  await detailPanel.getByRole('button', { name: '迁移' }).click();
  const migrationDialog = page.getByRole('dialog', { name: '迁移' });
  await migrationDialog.getByLabel('目标 Libvirt URI').fill('qemu+ssh://target.example/system');
  await migrationDialog.getByRole('button', { name: '迁移' }).click();
  await expect(migrationDialog).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as any).__shellDeskUiHarnessLastVirshCommand as string)).toContain('migrate --live --persistent --undefinesource --p2p');
});

test('Virtual machine manager remains usable at a compact desktop width', async ({ page }) => {
  await page.setViewportSize({ width: 980, height: 760 });
  await gotoHarness(page, 'component=vm-manager');

  await expect(page.locator('.vm-manager-table tbody tr')).toHaveCount(8);
  const horizontalOverflow = await page.locator('.vm-manager-container').evaluate((node) => node.scrollWidth - node.clientWidth);
  expect(horizontalOverflow).toBeLessThanOrEqual(1);
  await expect(page.locator('.vm-manager-detail')).toBeVisible();
});

test('Virtual machine manager applies URI changes only after explicit confirmation', async ({ page }) => {
  await gotoHarness(page, 'component=vm-manager');
  await expect(page.locator('.vm-manager-table tbody tr')).toHaveCount(8);

  const getVirshRequestCount = () => page.evaluate(() => Number((window as typeof window & {
    __shellDeskUiHarnessVirshRequestCount?: number;
  }).__shellDeskUiHarnessVirshRequestCount ?? 0));
  await expect.poll(getVirshRequestCount).toBeGreaterThanOrEqual(3);
  const initialRequestCount = await getVirshRequestCount();
  const uriInput = page.locator('.vm-manager-uri input');

  await uriInput.fill('qemu:///session');
  await page.waitForTimeout(250);
  expect(await getVirshRequestCount()).toBe(initialRequestCount);

  await uriInput.press('Enter');
  await expect.poll(getVirshRequestCount).toBeGreaterThan(initialRequestCount);
});

test('FRP client and server lazy styles preserve themes and the 860px layout boundary', async ({ page }) => {
  const managerCases = [
    {
      component: 'frp-manager',
      root: '.frp-manager',
      layout: '.frp-layout',
      config: '.frp-config',
      installPanel: '.frp-install-panel',
      tabs: '.frp-tabs',
      settings: '.frp-settings',
      overflow: 'hidden',
    },
    {
      component: 'frps-manager',
      root: '.frps-manager',
      layout: '.frps-layout',
      config: '.frps-config',
      installPanel: '.frps-install-panel',
      tabs: '.frps-tabs',
      settings: '.frps-settings',
      overflow: 'auto',
    },
  ] as const;

  for (const manager of managerCases) {
    await page.setViewportSize({ width: 861, height: 720 });
    await gotoHarness(page, `component=${manager.component}&theme=dark`);
    await expect(page.locator(manager.installPanel)).toBeVisible();

    const darkStyle = await page.locator(manager.root).evaluate((node) => {
      const style = window.getComputedStyle(node);
      return { color: style.color, backgroundImage: style.backgroundImage };
    });
    expect(darkStyle.color).toBe('rgb(238, 244, 255)');
    expect(darkStyle.backgroundImage).toContain('linear-gradient');
    await expect(page.locator(manager.config)).toHaveCSS('overflow', manager.overflow);

    const wideColumns = await page.locator(manager.layout).evaluate(
      (node) => window.getComputedStyle(node).gridTemplateColumns,
    );
    expect(wideColumns.trim().split(/\s+/)).toHaveLength(2);

    const settingsTab = page.locator(manager.tabs).getByRole('button', { name: '设置', exact: true });
    await settingsTab.click();
    await expect(page.locator(manager.settings)).toBeVisible();

    await page.setViewportSize({ width: 860, height: 720 });
    const compactColumns = await page.locator(manager.layout).evaluate(
      (node) => window.getComputedStyle(node).gridTemplateColumns,
    );
    expect(compactColumns.trim().split(/\s+/)).toHaveLength(1);

    await page.setViewportSize({ width: 861, height: 720 });
    await gotoHarness(page, `component=${manager.component}&theme=light`);
    await expect(page.locator(manager.installPanel)).toBeVisible();
    await expect(page.locator(manager.root)).toHaveCSS('color', 'rgb(29, 40, 56)');
  }
});

test('Monitor persistence remains opt-in and can return to real-time only', async ({ page }) => {
  await gotoHarness(page, 'component=monitor');
  await expectMonitorPaneOwnsLayout(page);

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
  await expect.poll(() => page.evaluate(() => (window as any).__shellDeskUiHarnessMetricsRequestCount)).toBeGreaterThan(0);
  const realtimeMetricsRequestCount = await page.evaluate(() => (window as any).__shellDeskUiHarnessMetricsRequestCount as number);
  await optInDialog.getByRole('button', { name: '开启持久化' }).click();

  await expect(optInDialog).toBeHidden();
  await expect(page.getByText('持久化分析')).toBeVisible();
  await page.waitForTimeout(2_200);
  await expect.poll(() => page.evaluate(() => (window as any).__shellDeskUiHarnessMetricsRequestCount)).toBe(realtimeMetricsRequestCount);
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
  await expectMonitorPaneOwnsLayout(page);

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

test('File explorer danger action keeps readable theme contrast', async ({ page }) => {
  for (const theme of ['light', 'dark'] as const) {
    await gotoHarness(page, `component=file-explorer&theme=${theme}`);

    const row = page.getByTestId('explorer-row-secure.txt');
    await expect(row).toBeVisible();
    await row.click({ button: 'right' });

    const deleteAction = page.getByTestId('explorer-context-delete');
    await expect(deleteAction).toBeVisible();
    const metrics = await deleteAction.evaluate((node) => {
      type Rgba = { red: number; green: number; blue: number; alpha: number };

      const parseColor = (value: string): Rgba => {
        const match = value.match(
          /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/,
        );
        if (!match) {
          throw new Error(`Unsupported computed color: ${value}`);
        }
        return {
          red: Number(match[1]),
          green: Number(match[2]),
          blue: Number(match[3]),
          alpha: match[4] === undefined ? 1 : Number(match[4]),
        };
      };
      const composite = (foreground: Rgba, background: Rgba): Rgba => {
        const alpha = foreground.alpha + background.alpha * (1 - foreground.alpha);
        const channel = (foregroundValue: number, backgroundValue: number) => (
          alpha === 0
            ? 0
            : (
              foregroundValue * foreground.alpha
              + backgroundValue * background.alpha * (1 - foreground.alpha)
            ) / alpha
        );
        return {
          red: channel(foreground.red, background.red),
          green: channel(foreground.green, background.green),
          blue: channel(foreground.blue, background.blue),
          alpha,
        };
      };
      const luminance = ({ red, green, blue }: Rgba) => {
        const channel = (value: number) => {
          const normalized = value / 255;
          return normalized <= 0.04045
            ? normalized / 12.92
            : ((normalized + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
      };

      const actionColor = getComputedStyle(node).color;
      const menu = node.closest('.context-menu, .context-submenu') ?? node.parentElement;
      if (!menu) {
        throw new Error('Danger action menu is missing.');
      }
      const effectiveBackground = composite(
        parseColor(getComputedStyle(menu).backgroundColor),
        parseColor(getComputedStyle(document.documentElement).backgroundColor),
      );
      const foregroundLuminance = luminance(parseColor(actionColor));
      const backgroundLuminance = luminance(effectiveBackground);
      const contrastRatio = (
        Math.max(foregroundLuminance, backgroundLuminance) + 0.05
      ) / (
        Math.min(foregroundLuminance, backgroundLuminance) + 0.05
      );
      const tokenProbe = document.createElement('span');
      tokenProbe.style.color = 'var(--danger)';
      document.body.append(tokenProbe);
      const tokenColor = getComputedStyle(tokenProbe).color;
      tokenProbe.remove();

      return { actionColor, contrastRatio, tokenColor };
    });

    expect(metrics.actionColor).toBe(metrics.tokenColor);
    expect(metrics.contrastRatio).toBeGreaterThanOrEqual(4.5);
  }
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
