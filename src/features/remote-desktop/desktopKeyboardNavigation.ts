import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

export const overlayFocusableSelector = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function getRovingFocusIndex(
  key: string,
  currentIndex: number,
  itemCount: number,
  columnCount = 1,
) {
  if (itemCount <= 0) return -1;

  const lastIndex = itemCount - 1;
  switch (key) {
    case 'ArrowLeft':
      return currentIndex <= 0 ? lastIndex : currentIndex - 1;
    case 'ArrowRight':
      return currentIndex >= lastIndex ? 0 : currentIndex + 1;
    case 'ArrowUp':
      return Math.max(0, currentIndex - columnCount);
    case 'ArrowDown':
      return Math.min(lastIndex, currentIndex + columnCount);
    case 'Home':
      return 0;
    case 'End':
      return lastIndex;
    default:
      return currentIndex;
  }
}

function getFocusableElements(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>(overlayFocusableSelector)]
    .filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
}

export function focusFirstElement(container: HTMLElement | null, preferredSelector?: string) {
  const preferredElement = preferredSelector
    ? container?.querySelector<HTMLElement>(preferredSelector)
    : null;
  (preferredElement ?? (container ? getFocusableElements(container)[0] : null))?.focus({ preventScroll: true });
}

export function initializeRovingFocus(container: HTMLElement | null, itemSelector: string) {
  if (!container) return;
  const items = [...container.querySelectorAll<HTMLElement>(itemSelector)]
    .filter((item) => item.getAttribute('aria-disabled') !== 'true');
  items.forEach((item, index) => item.setAttribute('tabindex', index === 0 ? '0' : '-1'));
  items[0]?.focus({ preventScroll: true });
}

export function handleModalKeyboardNavigation(
  event: ReactKeyboardEvent<HTMLElement>,
  container: HTMLElement,
  onEscape: () => void,
) {
  if (event.key === 'Escape') {
    event.preventDefault();
    onEscape();
    return;
  }

  if (event.key !== 'Tab') return;

  const focusableElements = getFocusableElements(container);
  if (focusableElements.length === 0) {
    event.preventDefault();
    container.focus({ preventScroll: true });
    return;
  }

  const firstElement = focusableElements[0];
  const lastElement = focusableElements[focusableElements.length - 1];
  if (event.shiftKey && document.activeElement === firstElement) {
    event.preventDefault();
    lastElement.focus();
  } else if (!event.shiftKey && document.activeElement === lastElement) {
    event.preventDefault();
    firstElement.focus();
  }
}

export function handleRovingKeyboardNavigation(
  event: ReactKeyboardEvent<HTMLElement>,
  container: HTMLElement,
  itemSelector: string,
  columnCount = 1,
) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
    return;
  }

  const items = [...container.querySelectorAll<HTMLElement>(itemSelector)]
    .filter((item) => item.getAttribute('aria-disabled') !== 'true');
  if (items.length === 0) return;

  const currentIndex = Math.max(0, items.indexOf(document.activeElement as HTMLElement));
  const nextIndex = getRovingFocusIndex(event.key, currentIndex, items.length, columnCount);
  event.preventDefault();
  items.forEach((item, index) => item.setAttribute('tabindex', index === nextIndex ? '0' : '-1'));
  items[nextIndex]?.focus({ preventScroll: true });
}
