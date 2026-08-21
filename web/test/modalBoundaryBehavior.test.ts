import assert from "node:assert/strict";
import test from "node:test";
import {
  modalFrameBoundaryMessage,
  modalFrameBoundaryReadyMessage,
  modalFrameTabBoundaryKey,
  readModalFrameBoundaryState,
} from "../src/artifactModalBoundary.ts";
import {
  isModalFrameBoundaryReadyMessage,
  modalFrameBoundaryStateMessage,
  readModalFrameBoundaryKey,
} from "../src/useModalFrameBoundary.ts";
import {
  createOutsideInertOwner,
  lockDocumentScroll,
  orderModalTabSequence,
  restoreModalFocus,
  wrappedModalFocusIndex,
} from "../src/modalBoundary.ts";

test("document scroll ownership locks and restores html and body exactly", () => {
  const root = { style: { overflow: "clip", overscrollBehavior: "contain" } };
  const body = { style: { overflow: "auto", overscrollBehavior: "auto" } };

  const restore = lockDocumentScroll(root, body);
  assert.deepEqual(root.style, { overflow: "hidden", overscrollBehavior: "none" });
  assert.deepEqual(body.style, { overflow: "hidden", overscrollBehavior: "none" });

  restore();
  assert.deepEqual(root.style, { overflow: "clip", overscrollBehavior: "contain" });
  assert.deepEqual(body.style, { overflow: "auto", overscrollBehavior: "auto" });
});

test("outside inert ownership follows the modal path and includes later siblings", () => {
  const body = fakeElement();
  const application = append(body, fakeElement());
  const unrelatedBodyChild = append(body, fakeElement());
  const header = append(application, fakeElement());
  header.inert = true;
  const workspace = append(application, fakeElement());
  const backdrop = append(workspace, fakeElement());
  const panel = append(workspace, fakeElement());
  const viewer = append(workspace, fakeElement());

  const owner = createOutsideInertOwner(
    panel as unknown as HTMLElement,
    body as unknown as HTMLElement,
    [backdrop as unknown as HTMLElement],
  );
  assert.equal(backdrop.inert, false, "the modal backdrop remains its close surface");
  assert.equal(viewer.inert, true, "the covered workspace is inert");
  assert.equal(header.inert, true, "the application header is inert");
  assert.equal(unrelatedBodyChild.inert, true, "body siblings are inert");

  const lateViewer = append(workspace, fakeElement());
  owner.refresh();
  assert.equal(lateViewer.inert, true, "new outside content joins the modal boundary");

  owner.restore();
  assert.equal(backdrop.inert, false);
  assert.equal(viewer.inert, false);
  assert.equal(lateViewer.inert, false);
  assert.equal(header.inert, true, "pre-existing inert state is preserved");
  assert.equal(unrelatedBodyChild.inert, false);
});

test("focus wrapping handles both endpoints and focus that starts outside", () => {
  assert.equal(wrappedModalFocusIndex({
    activeIndex: -1,
    focusableCount: 3,
    shiftKey: false,
  }), 0);
  assert.equal(wrappedModalFocusIndex({
    activeIndex: -1,
    focusableCount: 3,
    shiftKey: true,
  }), 2);
  assert.equal(wrappedModalFocusIndex({
    activeIndex: 2,
    focusableCount: 3,
    shiftKey: false,
  }), 0);
  assert.equal(wrappedModalFocusIndex({
    activeIndex: 0,
    focusableCount: 3,
    shiftKey: true,
  }), 2);
  assert.equal(wrappedModalFocusIndex({
    activeIndex: 1,
    focusableCount: 3,
    shiftKey: false,
  }), undefined);
});

test("artifact frames relay only modal boundary keys", () => {
  assert.equal(modalFrameTabBoundaryKey({
    activeIndex: 0,
    focusableCount: 2,
    shiftKey: false,
  }), undefined, "forward Tab remains inside the frame before its last target");
  assert.equal(modalFrameTabBoundaryKey({
    activeIndex: 1,
    focusableCount: 2,
    shiftKey: false,
  }), "TabForward");
  assert.equal(modalFrameTabBoundaryKey({
    activeIndex: 0,
    focusableCount: 2,
    shiftKey: true,
  }), "TabBackward");
  assert.equal(modalFrameTabBoundaryKey({
    activeIndex: -1,
    focusableCount: 0,
    shiftKey: false,
  }), "TabForward", "an empty frame returns focus to the outer modal");

  assert.equal(
    readModalFrameBoundaryKey(modalFrameBoundaryMessage("Escape")),
    "Escape",
  );
  assert.equal(readModalFrameBoundaryKey({
    type: "nanocodex-modal-boundary-key",
    key: "Enter",
  }), undefined);
  assert.equal(readModalFrameBoundaryKey({ type: "artifact-action", key: "Escape" }), undefined);
  assert.equal(isModalFrameBoundaryReadyMessage(modalFrameBoundaryReadyMessage()), true);
  assert.equal(readModalFrameBoundaryState(modalFrameBoundaryStateMessage(true)), true);
  assert.equal(readModalFrameBoundaryState(modalFrameBoundaryStateMessage(false)), false);
  assert.equal(readModalFrameBoundaryState({
    type: "nanocodex-modal-boundary-state",
    active: "true",
  }), undefined);
});

test("focus restoration skips hidden responsive openers for a visible fallback", () => {
  const ownerDocument = { activeElement: null as unknown };
  const hidden = fakeFocusTarget(ownerDocument, false);
  const fallback = fakeFocusTarget(ownerDocument, true);

  assert.equal(restoreModalFocus(
    hidden as unknown as HTMLElement,
    fallback as unknown as HTMLElement,
  ), true);
  assert.equal(hidden.focusCalls, 0);
  assert.equal(fallback.focusCalls, 1);
  assert.equal(ownerDocument.activeElement, fallback);
});

test("modal tab order follows positive tabindex before stable DOM order", () => {
  const elements = [
    { id: "zero-a", tabIndex: 0 },
    { id: "three-a", tabIndex: 3 },
    { id: "one", tabIndex: 1 },
    { id: "three-b", tabIndex: 3 },
    { id: "zero-b", tabIndex: 0 },
  ];
  assert.deepEqual(
    orderModalTabSequence(elements).map(({ id }) => id),
    ["one", "three-a", "three-b", "zero-a", "zero-b"],
  );
});

type FakeElement = {
  children: FakeElement[];
  inert: boolean;
  parentElement: FakeElement | null;
};

function fakeElement(): FakeElement {
  return { children: [], inert: false, parentElement: null };
}

function append(parent: FakeElement, child: FakeElement): FakeElement {
  parent.children.push(child);
  child.parentElement = parent;
  return child;
}

function fakeFocusTarget(ownerDocument: { activeElement: unknown }, rendered: boolean) {
  const target = {
    focusCalls: 0,
    isConnected: true,
    ownerDocument,
    closest: () => null,
    getClientRects: () => rendered ? [{}] : [],
    matches: () => false,
    focus() {
      target.focusCalls += 1;
      ownerDocument.activeElement = target;
    },
  };
  return target;
}
