const MODAL_FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "audio[controls]",
  "button:not(:disabled)",
  '[contenteditable]:not([contenteditable="false"])',
  "details > summary:first-of-type",
  "embed",
  "iframe",
  'input:not(:disabled):not([type="hidden"])',
  "object",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "video[controls]",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export const MODAL_FRAME_BOUNDARY_MESSAGE = "nanocodex-modal-boundary-key";
export const MODAL_FRAME_BOUNDARY_READY_MESSAGE = "nanocodex-modal-boundary-ready";
export const MODAL_FRAME_BOUNDARY_STATE_MESSAGE = "nanocodex-modal-boundary-state";

export type ModalFrameBoundaryKey = "Escape" | "TabBackward" | "TabForward";

type ScrollStyle = {
  overflow: string;
  overscrollBehavior: string;
};

type ScrollOwner = {
  style: ScrollStyle;
};

export type OutsideInertOwner = {
  refresh(): void;
  restore(): void;
};

export function lockDocumentScroll(
  root: ScrollOwner,
  body: ScrollOwner,
): () => void {
  const previous = {
    rootOverflow: root.style.overflow,
    rootOverscroll: root.style.overscrollBehavior,
    bodyOverflow: body.style.overflow,
    bodyOverscroll: body.style.overscrollBehavior,
  };
  root.style.overflow = "hidden";
  root.style.overscrollBehavior = "none";
  body.style.overflow = "hidden";
  body.style.overscrollBehavior = "none";
  return () => {
    root.style.overflow = previous.rootOverflow;
    root.style.overscrollBehavior = previous.rootOverscroll;
    body.style.overflow = previous.bodyOverflow;
    body.style.overscrollBehavior = previous.bodyOverscroll;
  };
}

export function createOutsideInertOwner(
  boundary: HTMLElement,
  root: HTMLElement,
  exemptions: readonly HTMLElement[] = [],
): OutsideInertOwner {
  const previous = new Map<HTMLElement, boolean>();
  const exempt = new Set(exemptions);
  const refresh = () => {
    let current: HTMLElement | null = boundary;
    while (current && current !== root) {
      const parent: HTMLElement | null = current.parentElement;
      if (!parent) break;
      const siblings = Array.from(parent.children) as Element[];
      for (const sibling of siblings) {
        if (
          sibling === current
          || exempt.has(sibling as HTMLElement)
          || !("inert" in sibling)
        ) continue;
        const element = sibling as HTMLElement;
        if (!previous.has(element)) previous.set(element, element.inert);
        element.inert = true;
      }
      current = parent;
    }
  };
  refresh();
  return {
    refresh,
    restore() {
      for (const [element, inert] of previous) element.inert = inert;
      previous.clear();
    },
  };
}

export function wrappedModalFocusIndex({
  activeIndex,
  focusableCount,
  shiftKey,
}: {
  activeIndex: number;
  focusableCount: number;
  shiftKey: boolean;
}): number | undefined {
  if (focusableCount <= 0) return undefined;
  if (activeIndex < 0) return shiftKey ? focusableCount - 1 : 0;
  if (shiftKey && activeIndex === 0) return focusableCount - 1;
  if (!shiftKey && activeIndex === focusableCount - 1) return 0;
  return undefined;
}

export function modalFrameTabBoundaryKey({
  activeIndex,
  focusableCount,
  shiftKey,
}: {
  activeIndex: number;
  focusableCount: number;
  shiftKey: boolean;
}): ModalFrameBoundaryKey | undefined {
  if (focusableCount <= 0) return shiftKey ? "TabBackward" : "TabForward";
  if (shiftKey && activeIndex <= 0) return "TabBackward";
  if (!shiftKey && activeIndex === focusableCount - 1) return "TabForward";
  return undefined;
}

export function modalFrameBoundaryMessage(key: ModalFrameBoundaryKey) {
  return { type: MODAL_FRAME_BOUNDARY_MESSAGE, key } as const;
}

export function modalFrameBoundaryReadyMessage() {
  return { type: MODAL_FRAME_BOUNDARY_READY_MESSAGE } as const;
}

export function modalFrameBoundaryStateMessage(active: boolean) {
  return { type: MODAL_FRAME_BOUNDARY_STATE_MESSAGE, active } as const;
}

export function isModalFrameBoundaryReadyMessage(value: unknown): boolean {
  return isRecordWithType(value, MODAL_FRAME_BOUNDARY_READY_MESSAGE);
}

export function readModalFrameBoundaryState(value: unknown): boolean | undefined {
  if (!isRecordWithType(value, MODAL_FRAME_BOUNDARY_STATE_MESSAGE)) {
    return undefined;
  }
  const active = (value as Record<string, unknown>).active;
  return typeof active === "boolean" ? active : undefined;
}

export function readModalFrameBoundaryKey(
  value: unknown,
): ModalFrameBoundaryKey | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const message = value as Record<string, unknown>;
  if (message.type !== MODAL_FRAME_BOUNDARY_MESSAGE) return undefined;
  return message.key === "Escape"
    || message.key === "TabBackward"
    || message.key === "TabForward"
    ? message.key
    : undefined;
}

export function containModalFocus(event: KeyboardEvent, panel: HTMLElement) {
  if (event.key !== "Tab") return;
  const focusable = modalFocusableElements(panel);
  const active = deepActiveElement(panel.ownerDocument);
  const activeIndex = focusable.findIndex((element) => element === active);
  const nextIndex = wrappedModalFocusIndex({
    activeIndex: isWithinDeepRoot(panel, active) ? activeIndex : -1,
    focusableCount: focusable.length,
    shiftKey: event.shiftKey,
  });
  if (nextIndex === undefined) return;
  event.preventDefault();
  focusable[nextIndex]?.focus();
}

export function focusAdjacentToModalFrame(
  panel: HTMLElement,
  frame: HTMLIFrameElement,
  direction: "TabBackward" | "TabForward",
) {
  const focusable = modalFocusableElements(panel);
  if (focusable.length === 0) {
    panel.focus();
    return;
  }
  const frameIndex = focusable.findIndex((element) => element === frame);
  const offset = direction === "TabBackward" ? -1 : 1;
  const origin = frameIndex < 0
    ? direction === "TabBackward" ? 0 : focusable.length - 1
    : frameIndex;
  const nextIndex = (origin + offset + focusable.length) % focusable.length;
  focusable[nextIndex]?.focus();
}

export function focusModal(panel: HTMLElement, preferred?: HTMLElement | null) {
  const active = deepActiveElement(panel.ownerDocument);
  if (isWithinDeepRoot(panel, active)) return;
  const target = preferred ?? modalFocusableElements(panel)[0] ?? panel;
  target.focus();
}

export function modalContainsFocus(panel: HTMLElement, event: FocusEvent): boolean {
  const target = event.composedPath()[0];
  return isElementLike(target) && isWithinDeepRoot(panel, target);
}

export function restoreModalFocus(
  primary?: HTMLElement | null,
  fallback?: HTMLElement | null,
): boolean {
  for (const target of new Set([primary, fallback])) {
    if (!target || !canRestoreModalFocus(target)) continue;
    target.focus({ preventScroll: true });
    const active = deepActiveElement(target.ownerDocument);
    if (active === target || isWithinDeepRoot(target, active)) return true;
  }
  return false;
}

export function modalFocusableElements(
  root: Document | ShadowRoot | HTMLElement,
): HTMLElement[] {
  const elements: HTMLElement[] = [];
  for (const element of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
    if (
      element.matches(MODAL_FOCUSABLE_SELECTOR)
      && element.tabIndex >= 0
      && !element.matches(":disabled")
      && isRenderedForFocus(element)
    ) elements.push(element);
    if (element.shadowRoot) elements.push(...modalFocusableElements(element.shadowRoot));
  }
  return orderModalTabSequence(
    elements.filter((element) => isRadioTabStop(element, elements)),
  );
}

export function orderModalTabSequence<T extends { tabIndex: number }>(
  elements: readonly T[],
): T[] {
  return elements
    .map((element, index) => ({ element, index }))
    .sort((left, right) => {
      const leftPositive = left.element.tabIndex > 0;
      const rightPositive = right.element.tabIndex > 0;
      if (leftPositive !== rightPositive) return leftPositive ? -1 : 1;
      if (
        leftPositive
        && left.element.tabIndex !== right.element.tabIndex
      ) return left.element.tabIndex - right.element.tabIndex;
      return left.index - right.index;
    })
    .map(({ element }) => element);
}

export function deepActiveElement(root: Document | ShadowRoot): Element | null {
  let active = root.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

function canRestoreModalFocus(target: HTMLElement): boolean {
  return target.isConnected
    && isRenderedForFocus(target)
    && !target.matches(":disabled");
}

function isRenderedForFocus(element: HTMLElement): boolean {
  if (
    element.closest("[hidden], [inert]")
    || element.getClientRects().length === 0
  ) return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return style?.display !== "none"
    && style?.visibility !== "hidden"
    && style?.visibility !== "collapse"
    && style?.contentVisibility !== "hidden";
}

function isRadioTabStop(
  element: HTMLElement,
  candidates: readonly HTMLElement[],
): boolean {
  if (!element.matches('input[type="radio"]')) return true;
  const radio = element as HTMLInputElement;
  if (!radio.name) return true;
  const root = radio.getRootNode();
  const group = candidates.filter((candidate): candidate is HTMLInputElement => {
    if (!candidate.matches('input[type="radio"]')) return false;
    const grouped = candidate as HTMLInputElement;
    return grouped.name === radio.name
      && grouped.form === radio.form
      && grouped.getRootNode() === root;
  });
  return (group.find((candidate) => candidate.checked) ?? group[0]) === radio;
}

function isWithinDeepRoot(container: Element, element: Element | null): boolean {
  let current = element;
  while (current) {
    if (container.contains(current)) return true;
    const root = current.getRootNode() as ShadowRoot;
    current = root.host ?? null;
  }
  return false;
}

function isElementLike(value: unknown): value is Element {
  return typeof value === "object"
    && value !== null
    && "getRootNode" in value;
}

function isRecordWithType(value: unknown, type: string): boolean {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (value as Record<string, unknown>).type === type;
}
