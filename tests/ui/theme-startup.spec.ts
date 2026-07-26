import { expect, type Page, test } from '@playwright/test';

const themeStartupPath = '/tests/ui/theme-startup-harness.html';
const preloadTokens = [
  '--bg',
  '--chrome',
  '--surface',
  '--surface-elevated',
  '--text',
] as const;

const expectedTokens = {
  dark: {
    '--bg': '#080e16',
    '--chrome': '#1b222b',
    '--surface': '#111b28',
    '--surface-elevated': '#0f1823',
    '--text': '#e8eef5',
  },
  light: {
    '--bg': '#eef2f5',
    '--chrome': '#f8fafb',
    '--surface': '#ffffff',
    '--surface-elevated': '#f8fafb',
    '--text': '#23313d',
  },
} as const;

type ResolvedTheme = keyof typeof expectedTokens;
type ThemeSnapshot = {
  theme: string | null;
  colorScheme: string;
  metaColorScheme: string | null;
  tokens: Record<(typeof preloadTokens)[number], string>;
  inlineTokens: Record<(typeof preloadTokens)[number], string>;
};

type ThemeHarnessWindow = Window & {
  __shellDeskThemeHarness?: {
    preRuntime: ThemeSnapshot;
    snapshot: () => ThemeSnapshot;
  };
};

async function getHarnessSnapshots(page: Page) {
  return page.evaluate(() => {
    const harness = (window as ThemeHarnessWindow).__shellDeskThemeHarness;

    if (!harness) {
      throw new Error('Theme startup harness did not initialize.');
    }

    return {
      preRuntime: harness.preRuntime,
      runtime: harness.snapshot(),
    };
  });
}

async function expectStableStartup(
  page: Page,
  preference: 'light' | 'dark' | 'system',
  expectedTheme: ResolvedTheme,
) {
  const runtimeErrors: string[] = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      runtimeErrors.push(message.text());
    }
  });

  await page.goto(`${themeStartupPath}?shelldeskTheme=${preference}`);
  await expect(page.locator('#theme-startup-harness')).toHaveAttribute('data-ready', 'true');

  const { preRuntime, runtime } = await getHarnessSnapshots(page);

  expect(preRuntime.theme).toBe(expectedTheme);
  expect(preRuntime.colorScheme).toBe(expectedTheme);
  expect(preRuntime.metaColorScheme).toBe(expectedTheme);
  expect(preRuntime.tokens).toEqual(expectedTokens[expectedTheme]);
  expect(preRuntime.inlineTokens).toEqual(expectedTokens[expectedTheme]);

  expect(runtime.theme).toBe(expectedTheme);
  expect(runtime.colorScheme).toBe(expectedTheme);
  expect(runtime.metaColorScheme).toBe(expectedTheme);
  expect(runtime.tokens).toEqual(preRuntime.tokens);
  expect(runtime.inlineTokens).toEqual(
    Object.fromEntries(preloadTokens.map((token) => [token, ''])),
  );
  expect(runtimeErrors).toEqual([]);
}

test.describe('theme startup handoff', () => {
  test('keeps an explicit light startup stable', async ({ page }) => {
    await expectStableStartup(page, 'light', 'light');
  });

  test('keeps an explicit dark startup stable', async ({ page }) => {
    await expectStableStartup(page, 'dark', 'dark');
  });

  test('resolves system light before runtime without a token jump', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await expectStableStartup(page, 'system', 'light');
  });

  test('resolves system dark before runtime without a token jump', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectStableStartup(page, 'system', 'dark');
  });

  test('reacts to a system appearance change after runtime startup', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await expectStableStartup(page, 'system', 'light');

    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    const { runtime } = await getHarnessSnapshots(page);
    expect(runtime.theme).toBe('dark');
    expect(runtime.colorScheme).toBe('dark');
    expect(runtime.metaColorScheme).toBe('dark');
    expect(runtime.tokens).toEqual(expectedTokens.dark);
    expect(runtime.inlineTokens).toEqual(
      Object.fromEntries(preloadTokens.map((token) => [token, ''])),
    );
  });
});
