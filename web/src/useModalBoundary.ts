import { useLayoutEffect, type RefObject } from "react";
import {
  containModalFocus,
  createOutsideInertOwner,
  focusAdjacentToModalFrame,
  focusModal,
  isModalFrameBoundaryReadyMessage,
  lockDocumentScroll,
  modalContainsFocus,
  modalFrameBoundaryStateMessage,
  readModalFrameBoundaryKey,
  restoreModalFocus,
} from "./modalBoundary";

export function useModalBoundary({
  backdropRef,
  fallbackFocusRef,
  initialFocusRef,
  onDismiss,
  open,
  panelRef,
  returnFocusRef,
}: {
  backdropRef?: RefObject<HTMLElement | null>;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  onDismiss(): void;
  open: boolean;
  panelRef: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  useLayoutEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const document = panel.ownerDocument;
    const window = document.defaultView;
    if (!window) return;

    const restoreScroll = lockDocumentScroll(
      document.documentElement,
      document.body,
    );
    const backdrop = backdropRef?.current;
    const inertOwner = createOutsideInertOwner(
      panel,
      document.body,
      backdrop ? [backdrop] : [],
    );
    const observer = new MutationObserver(inertOwner.refresh);
    observer.observe(document.body, { childList: true, subtree: true });
    const frames = () => Array.from(panel.querySelectorAll("iframe"));
    const setFrameBoundaryState = (active: boolean) => {
      const message = modalFrameBoundaryStateMessage(active);
      for (const frame of frames()) frame.contentWindow?.postMessage(message, "*");
    };
    setFrameBoundaryState(true);

    const focusFrame = window.requestAnimationFrame(() => {
      focusModal(panel, initialFocusRef?.current);
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onDismiss();
        return;
      }
      containModalFocus(event, panel);
    };
    const onFocusIn = (event: FocusEvent) => {
      if (!modalContainsFocus(panel, event)) {
        focusModal(panel, initialFocusRef?.current);
      }
    };
    const onFrameMessage = (event: MessageEvent) => {
      const frame = frames().find(
        (candidate) => candidate.contentWindow === event.source,
      );
      if (!frame) return;
      if (isModalFrameBoundaryReadyMessage(event.data)) {
        frame.contentWindow?.postMessage(modalFrameBoundaryStateMessage(true), "*");
        return;
      }
      const key = readModalFrameBoundaryKey(event.data);
      if (!key) return;
      if (key === "Escape") {
        onDismiss();
        return;
      }
      focusAdjacentToModalFrame(panel, frame, key);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("message", onFrameMessage);
    document.addEventListener("focusin", onFocusIn, { capture: true });
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("message", onFrameMessage);
      document.removeEventListener("focusin", onFocusIn, { capture: true });
      setFrameBoundaryState(false);
      observer.disconnect();
      inertOwner.restore();
      restoreScroll();
      restoreModalFocus(returnFocusRef?.current, fallbackFocusRef?.current);
    };
  }, [
    backdropRef,
    fallbackFocusRef,
    initialFocusRef,
    onDismiss,
    open,
    panelRef,
    returnFocusRef,
  ]);
}
