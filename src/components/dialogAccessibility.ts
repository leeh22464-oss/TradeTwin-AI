import { useEffect, useRef, type RefObject } from 'react';

export function useDialogAccessibility(dialogRef: RefObject<HTMLElement | null>, onClose: () => void) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialogRoot = document.getElementById('dialog-root');
    const portalContainer = dialog.closest<HTMLElement>('[data-dialog-portal]');
    const inerted: Array<{ element: HTMLElement; value: string | null }> = [];
    for (const child of Array.from(document.body.children)) {
      if (child !== dialogRoot && child !== portalContainer && child instanceof HTMLElement) {
        inerted.push({ element: child, value: child.getAttribute('inert') });
        child.setAttribute('inert', '');
      }
    }
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusSelector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusFirst = () => {
      const initial = dialog.querySelector<HTMLElement>('[data-dialog-initial-focus]');
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusSelector));
      (initial || focusable[0] || dialog).focus();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusSelector));
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener('keydown', onKeyDown);
    const focusFrame = requestAnimationFrame(focusFirst);
    return () => {
      cancelAnimationFrame(focusFrame);
      dialog.removeEventListener('keydown', onKeyDown);
      for (const item of inerted) {
        if (item.value === null) item.element.removeAttribute('inert');
        else item.element.setAttribute('inert', item.value);
      }
      document.body.style.overflow = bodyOverflow;
      if (previousFocus?.isConnected) requestAnimationFrame(() => previousFocus.focus());
    };
  }, [dialogRef]);
}
