import defaultDesktopWallpaperUrl from './images/default-desktop-wallpaper.png';
import amberRoutesWallpaperUrl from './images/desktop-wallpaper-amber-routes.png';
import greenHealthWallpaperUrl from './images/desktop-wallpaper-green-health.png';
import indigoTracesWallpaperUrl from './images/desktop-wallpaper-indigo-traces.png';
import midnightOpsWallpaperUrl from './images/desktop-wallpaper-midnight-ops.png';
import mistConsoleWallpaperUrl from './images/desktop-wallpaper-mist-console.png';
import type { MessageId } from '../i18nCatalog';

export const defaultDesktopWallpaperPresetId = 'default';

export const desktopWallpaperPresets: ReadonlyArray<{
  id: string;
  labelId: MessageId;
  url: string;
}> = [
  {
    id: defaultDesktopWallpaperPresetId,
    labelId: 'settings.wallpaper.preset.default',
    url: defaultDesktopWallpaperUrl,
  },
  {
    id: 'midnight-ops',
    labelId: 'settings.wallpaper.preset.midnightOps',
    url: midnightOpsWallpaperUrl,
  },
  {
    id: 'amber-routes',
    labelId: 'settings.wallpaper.preset.amberRoutes',
    url: amberRoutesWallpaperUrl,
  },
  {
    id: 'mist-console',
    labelId: 'settings.wallpaper.preset.mistConsole',
    url: mistConsoleWallpaperUrl,
  },
  {
    id: 'green-health',
    labelId: 'settings.wallpaper.preset.greenHealth',
    url: greenHealthWallpaperUrl,
  },
  {
    id: 'indigo-traces',
    labelId: 'settings.wallpaper.preset.indigoTraces',
    url: indigoTracesWallpaperUrl,
  },
] as const;

export type DesktopWallpaperPreset = (typeof desktopWallpaperPresets)[number];

export function getDesktopWallpaperPreset(presetId: string | null | undefined): DesktopWallpaperPreset {
  return desktopWallpaperPresets.find((preset) => preset.id === presetId) ?? desktopWallpaperPresets[0];
}
