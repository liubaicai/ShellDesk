import { useCallback, useEffect, useRef, useState } from 'react';

import type { RemoteSystemType } from '../../components/remote-desktop/types';
import {
  clearDesktopCapabilitySnapshot,
  createStaticDesktopCapabilitySnapshot,
  loadDesktopCapabilitySnapshot,
} from './desktopCapabilities';

export function useDesktopCapabilities(
  connectionId: string,
  systemType: RemoteSystemType | undefined,
  enabled: boolean,
) {
  const requestSequenceRef = useRef(0);
  const [snapshot, setSnapshot] = useState(() => createStaticDesktopCapabilitySnapshot(systemType));

  const refresh = useCallback(async (force = false) => {
    const requestId = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestId;

    if (force) {
      clearDesktopCapabilitySnapshot(connectionId);
    }

    setSnapshot(createStaticDesktopCapabilitySnapshot(systemType));
    const nextSnapshot = await loadDesktopCapabilitySnapshot(connectionId, systemType, force);

    if (requestSequenceRef.current === requestId) {
      setSnapshot(nextSnapshot);
    }
  }, [connectionId, systemType]);

  useEffect(() => {
    if (!enabled) {
      requestSequenceRef.current += 1;
      setSnapshot(createStaticDesktopCapabilitySnapshot(systemType));
      return;
    }

    void refresh();
  }, [enabled, refresh, systemType]);

  return { snapshot, refresh };
}
