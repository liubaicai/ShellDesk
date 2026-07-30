import { expect, test } from '@playwright/test';

import { defaultSettingsSection, settingsSections } from '../../src/pages/settingsPageModel';

test('the settings page opens on the general section by default', () => {
  expect(defaultSettingsSection).toBe('general');
  expect(settingsSections[0].key).toBe(defaultSettingsSection);
});
