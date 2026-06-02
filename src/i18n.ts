import { useEffect, useState } from 'react';
import { formatMessageTemplate, messageCatalog, type MessageId, type MessageParams } from './i18nCatalog';

export type AppLanguage = ShellDeskAppSettings['language'];
export type { MessageId, MessageParams } from './i18nCatalog';

export function getSystemLanguage(): AppLanguage {
  const locales = [
    ...(Array.isArray(navigator.languages) ? navigator.languages : []),
    navigator.language,
    Intl.DateTimeFormat().resolvedOptions().locale,
  ].filter(Boolean);

  return locales.some((locale) => /^zh\b|^zh-/i.test(locale)) ? 'zh-CN' : 'en-US';
}

export function normalizeAppLanguage(value: unknown): AppLanguage {
  return value === 'zh-CN' || value === 'en-US' ? value : getSystemLanguage();
}

export function getAppLocale(language: AppLanguage) {
  return language === 'zh-CN' ? 'zh-CN' : 'en-US';
}

export function getCurrentAppLocale() {
  if (typeof document === 'undefined') {
    return getAppLocale(getSystemLanguage());
  }

  return getAppLocale(normalizeAppLanguage(document.documentElement.getAttribute('data-language')));
}

export function getCurrentAppLanguage(): AppLanguage {
  if (typeof document === 'undefined') {
    return getSystemLanguage();
  }

  return normalizeAppLanguage(document.documentElement.getAttribute('data-language'));
}

export function useCurrentAppLanguage(): AppLanguage {
  const [language, setLanguage] = useState<AppLanguage>(() => getCurrentAppLanguage());

  useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
      return undefined;
    }

    const updateLanguage = () => setLanguage(getCurrentAppLanguage());
    const observer = new MutationObserver(updateLanguage);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-language'] });
    updateLanguage();
    return () => observer.disconnect();
  }, []);

  return language;
}

export function t(id: MessageId, language: AppLanguage, params?: MessageParams) {
  const normalizedLanguage = normalizeAppLanguage(language);
  const messages = messageCatalog[normalizedLanguage] ?? messageCatalog['zh-CN'];
  const template = messages[id] ?? messageCatalog['zh-CN'][id] ?? id;
  return formatMessageTemplate(template, params);
}

export function tCurrent(id: MessageId, params?: MessageParams) {
  return t(id, getCurrentAppLanguage(), params);
}

export function translateText(value: string, language: AppLanguage) {
  void language;
  return value;
}

export function translateStructuredText(value: string, language: AppLanguage) {
  void language;
  return value;
}

export function useShellDeskI18n(language: AppLanguage) {
  useEffect(() => {
    const appLanguage = normalizeAppLanguage(language);
    document.documentElement.lang = getAppLocale(appLanguage);
    document.documentElement.setAttribute('data-language', appLanguage);
  }, [language]);
}
