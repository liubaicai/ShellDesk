export type AppThemePreference = 'dark' | 'light' | 'system';
export type ResolvedTheme = Exclude<AppThemePreference, 'system'>;

export const THEME_PRELOAD_STORAGE_KEY = 'shelldesk:theme-preload';
export const THEME_PRELOAD_TOKENS = [
  '--bg',
  '--chrome',
  '--surface',
  '--surface-elevated',
  '--text',
] as const;

export const DEFAULT_ACCENT_COLOR = '#0f6bff';

const darkTextColor = '#0b1220';
const lightTextColor = '#ffffff';

type ColorChannels = {
  red: number;
  green: number;
  blue: number;
};

export function isAppTheme(value: unknown): value is AppThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

function readQueryTheme(search: string) {
  // This is a bootstrap/testing override only. Persisted vault settings become
  // the runtime source of truth after the desktop application hydrates.
  try {
    const queryTheme = new URLSearchParams(search).get('shelldeskTheme');
    return isAppTheme(queryTheme) ? queryTheme : null;
  } catch {
    return null;
  }
}

function readStoredTheme(storedTheme: string | null) {
  const normalizedStoredTheme = storedTheme?.trim();
  if (!normalizedStoredTheme) {
    return null;
  }

  if (isAppTheme(normalizedStoredTheme)) {
    return normalizedStoredTheme;
  }

  try {
    const parsedTheme = JSON.parse(normalizedStoredTheme) as { theme?: unknown };
    return isAppTheme(parsedTheme.theme) ? parsedTheme.theme : null;
  } catch {
    return null;
  }
}

export function readThemePreference(search: string, storedTheme: string | null): AppThemePreference {
  return readQueryTheme(search) ?? readStoredTheme(storedTheme) ?? 'dark';
}

export function readPreloadThemePreference(): AppThemePreference {
  let storedTheme: string | null = null;

  try {
    storedTheme = window.localStorage.getItem(THEME_PRELOAD_STORAGE_KEY);
  } catch {
    // Restricted WebViews may deny localStorage access.
  }

  return readThemePreference(window.location.search, storedTheme);
}

export function resolveThemePreference(
  themePreference: AppThemePreference,
  systemPrefersLight: boolean,
): ResolvedTheme {
  return themePreference === 'system'
    ? (systemPrefersLight ? 'light' : 'dark')
    : themePreference;
}

export function readHexColorChannels(hexColor: string): ColorChannels {
  const match = /^#(?<red>[0-9a-f]{2})(?<green>[0-9a-f]{2})(?<blue>[0-9a-f]{2})$/i.exec(hexColor);

  if (!match?.groups) {
    return { red: 15, green: 107, blue: 255 };
  }

  return {
    red: Number.parseInt(match.groups.red, 16),
    green: Number.parseInt(match.groups.green, 16),
    blue: Number.parseInt(match.groups.blue, 16),
  };
}

function normalizeHexColor(hexColor: string) {
  return /^#[0-9a-f]{6}$/i.test(hexColor) ? hexColor : DEFAULT_ACCENT_COLOR;
}

function toRgba(hexColor: string, alpha: number) {
  const { red, green, blue } = readHexColorChannels(hexColor);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

export function getRelativeLuminance(red: number, green: number, blue: number) {
  const toLinearChannel = (channel: number) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * toLinearChannel(red) + 0.7152 * toLinearChannel(green) + 0.0722 * toLinearChannel(blue);
}

export function getContrastRatio(firstColor: string, secondColor: string) {
  const first = readHexColorChannels(firstColor);
  const second = readHexColorChannels(secondColor);
  const firstLuminance = getRelativeLuminance(first.red, first.green, first.blue);
  const secondLuminance = getRelativeLuminance(second.red, second.green, second.blue);

  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}

export function getReadableTextColor(hexColor: string) {
  const normalizedColor = normalizeHexColor(hexColor);
  const darkTextContrast = getContrastRatio(normalizedColor, darkTextColor);
  const lightTextContrast = getContrastRatio(normalizedColor, lightTextColor);

  return darkTextContrast > lightTextContrast ? darkTextColor : lightTextColor;
}

export function getLightThemeAccentColor(hexColor: string) {
  const normalizedColor = normalizeHexColor(hexColor);
  const channels = readHexColorChannels(normalizedColor);

  if (getContrastRatio(normalizedColor, lightTextColor) >= 4.5) {
    return normalizedColor;
  }

  let minimumScale = 0;
  let maximumScale = 1;
  let accessibleChannels = channels;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const scale = (minimumScale + maximumScale) / 2;
    const candidate = {
      red: Math.round(channels.red * scale),
      green: Math.round(channels.green * scale),
      blue: Math.round(channels.blue * scale),
    };
    const candidateColor = formatHexColor(candidate);

    if (getContrastRatio(candidateColor, lightTextColor) >= 4.5) {
      accessibleChannels = candidate;
      minimumScale = scale;
    } else {
      maximumScale = scale;
    }
  }

  return formatHexColor(accessibleChannels);
}

function formatHexColor(channels: ColorChannels) {
  return `#${[channels.red, channels.green, channels.blue]
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')}`;
}

export function getAccentStyleProperties(
  configuredAccentColor: string,
  resolvedTheme: ResolvedTheme,
): Record<string, string> {
  const accentColor = resolvedTheme === 'light'
    ? getLightThemeAccentColor(configuredAccentColor)
    : normalizeHexColor(configuredAccentColor);
  const isLightTheme = resolvedTheme === 'light';

  return {
    '--accent': accentColor,
    '--accent-strong': accentColor,
    '--accent-contrast': getReadableTextColor(accentColor),
    '--focus-border': toRgba(accentColor, isLightTheme ? 0.42 : 0.46),
    '--focus-ring': toRgba(accentColor, isLightTheme ? 0.11 : 0.12),
    '--accent-soft': toRgba(accentColor, isLightTheme ? 0.09 : 0.16),
    '--accent-border': toRgba(accentColor, isLightTheme ? 0.25 : 0.42),
    '--accent-strong-border': toRgba(accentColor, isLightTheme ? 0.38 : 0.58),
  };
}

export function clearThemePreloadTokens(root: HTMLElement = document.documentElement) {
  for (const token of THEME_PRELOAD_TOKENS) {
    root.style.removeProperty(token);
  }
}
