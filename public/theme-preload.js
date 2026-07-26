(function () {
  var storageKey = 'shelldesk:theme-preload';
  var light = {
    '--bg': '#eef2f5',
    '--chrome': '#f8fafb',
    '--surface': '#ffffff',
    '--surface-elevated': '#f8fafb',
    '--text': '#23313d',
  };
  var dark = {
    '--bg': '#080e16',
    '--chrome': '#1b222b',
    '--surface': '#111b28',
    '--surface-elevated': '#0f1823',
    '--text': '#e8eef5',
  };

  function readThemePreference() {
    try {
      var params = new URLSearchParams(window.location.search);
      var queryTheme = params.get('shelldeskTheme');

      if (queryTheme === 'dark' || queryTheme === 'light' || queryTheme === 'system') {
        return queryTheme;
      }
    } catch {
      // Ignore URL parsing failures.
    }

    try {
      var storedTheme = window.localStorage.getItem(storageKey);

      if (!storedTheme) {
        return '';
      }

      storedTheme = storedTheme.trim();

      if (storedTheme.charAt(0) === '{') {
        var parsedTheme = JSON.parse(storedTheme);
        return typeof parsedTheme.theme === 'string' ? parsedTheme.theme : '';
      }

      return storedTheme;
    } catch {
      return '';
    }
  }

  function getSystemTheme() {
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch {
      return 'dark';
    }
  }

  function normalizeTheme(themePreference) {
    if (themePreference === 'dark' || themePreference === 'light') {
      return themePreference;
    }

    if (themePreference === 'system') {
      return getSystemTheme();
    }

    return 'dark';
  }

  function applyTheme(theme) {
    var palette = theme === 'light' ? light : dark;
    var root = document.documentElement;
    var colorSchemeMeta = document.querySelector('meta[name="color-scheme"]');

    root.setAttribute('data-theme', theme);
    root.style.colorScheme = theme;

    Object.keys(palette).forEach(function (property) {
      root.style.setProperty(property, palette[property]);
    });

    if (colorSchemeMeta) {
      colorSchemeMeta.setAttribute('content', theme);
    }
  }

  var theme = normalizeTheme(readThemePreference());
  applyTheme(theme);
}());
