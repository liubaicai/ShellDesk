import { enUS } from './i18nCatalog.en-US';
import { zhCN } from './i18nCatalog.zh-CN';

export type { MessageId } from './i18nCatalog.zh-CN';
export type MessageParams = Record<string, string | number | boolean | null | undefined>;

export const messageCatalog = {
  'zh-CN': zhCN,
  'en-US': enUS,
} as const;

export function formatMessageTemplate(template: string, params?: MessageParams) {
  if (!params) {
    return template;
  }

  return template.replace(/\{(\w+)\}/gu, (match, key: string) => {
    const value = params[key];
    return value === undefined || value === null ? match : String(value);
  });
}
