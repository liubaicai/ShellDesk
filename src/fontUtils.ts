const genericFontFamilies = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'emoji',
  'math',
  'fangsong',
]);

function normalizeFontFamily(fontFamily: string) {
  return fontFamily.replace(/\s+/g, ' ').trim();
}

export function quoteCssFontFamily(fontFamily: string) {
  const normalizedFontFamily = normalizeFontFamily(fontFamily);

  if (!normalizedFontFamily) {
    return '';
  }

  if (genericFontFamilies.has(normalizedFontFamily.toLocaleLowerCase())) {
    return normalizedFontFamily;
  }

  return JSON.stringify(normalizedFontFamily);
}

export function buildFontStack(primaryFontFamily: string, fallbackFontFamilies: readonly string[]) {
  const fontFamilies = [primaryFontFamily, ...fallbackFontFamilies];
  const seenFontFamilies = new Set<string>();

  return fontFamilies
    .map(normalizeFontFamily)
    .filter((fontFamily) => {
      if (!fontFamily) {
        return false;
      }

      const key = fontFamily.toLocaleLowerCase();

      if (seenFontFamilies.has(key)) {
        return false;
      }

      seenFontFamilies.add(key);
      return true;
    })
    .map(quoteCssFontFamily)
    .filter(Boolean)
    .join(', ');
}
