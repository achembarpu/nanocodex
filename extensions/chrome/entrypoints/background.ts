import {
  validateCleanupInput,
  type CleanupInput,
  type PageInterrupted,
  type PageLease,
  type TabClaim,
} from "../lib/extension";
import {
  compileRecipeCss,
  normalizeOrigin,
  permissionPattern,
  recipeStorageKey,
  validateRecipe,
  type SiteRecipe,
  type StoredSiteRecipe,
} from "../lib/recipe";
import {
  commitPreview,
  inspectPage,
  installPreview,
  removePersistedRecipe,
  removePreview,
} from "../lib/page";

const REGISTRATION_ID = "nanocodex-site-recipes-v1";
const RUNNER_FILE = "content-scripts/recipe-runner.js";
const INSTANCE_KEY = "browser-instance-id";
const LEASE_PREFIX = "page-lease:";
const SELECTED_TAB_KEY = "selected-page-tab";

interface SelectedTab {
  tab_id: number;
  window_id: number;
}

interface Lease {
  id: string;
  claim: TabClaim;
  documentRevision?: string;
  previewId?: string;
  preview?: SiteRecipe;
}

const activeRequests = new Set<string>();
const cancelledRequests = new Set<string>();
const invalidatedLeases = new Set<string>();
const leaseQueues = new Map<string, Promise<unknown>>();
let recipeQueue: Promise<unknown> = Promise.resolve();
let selectedTab: SelectedTab | undefined;
let selectedTabWrite: Promise<void> = Promise.resolve();

export default defineBackground(() => {
  void chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  void serializeRecipes(repairRecipeRegistration);
  chrome.runtime.onStartup.addListener(() => void serializeRecipes(repairRecipeRegistration));
  chrome.runtime.onInstalled.addListener(() => void serializeRecipes(repairRecipeRegistration));
  chrome.action.onClicked.addListener((tab) => {
    selectTab(tab);
    void chrome.sidePanel.open({ windowId: tab.windowId });
  });
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    void handleRuntimeMessage(message, sender).then(sendResponse, (error: unknown) => {
      sendResponse({ error: errorMessage(error) });
    });
    return true;
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    void interruptTab(tabId, "The selected tab was closed.");
  });
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status === "loading") {
      void interruptTab(tabId, "The selected tab navigated. Run the prompt again to inspect the new document.");
    }
  });
});

async function handleRuntimeMessage(value: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const message = asRecord(value);
  if (message.type !== "recipe.for_document") requireSidePanelSender(sender);
  switch (message.type) {
    case "page.claim": {
      if (typeof message.previous_lease_id === "string") await releaseLease(message.previous_lease_id);
      const claim = await claimSelectedTab();
      const current: Lease = { id: crypto.randomUUID(), claim };
      await saveLease(current);
      return { lease_id: current.id, tab: claim } satisfies PageLease;
    }
    case "page.cleanup": {
      const leaseId = requiredString(message, "lease_id");
      const requestId = requiredString(message, "request_id");
      if (activeRequests.has(requestId)) throw new Error("The cleanup request ID is already active.");
      activeRequests.add(requestId);
      try {
        return await serializeLease(leaseId, () =>
          handleCleanup(leaseId, requestId, validateCleanupInput(message.input)));
      } finally {
        activeRequests.delete(requestId);
        cancelledRequests.delete(requestId);
      }
    }
    case "page.cancel": {
      const requestId = requiredString(message, "request_id");
      if (activeRequests.has(requestId)) cancelledRequests.add(requestId);
      return {};
    }
    case "lease.release":
      await releaseLease(requiredString(message, "lease_id"));
      return {};
    case "preview.revert": {
      const leaseId = requiredString(message, "lease_id");
      await serializeLease(leaseId, async () => clearPreview(await requireLease(leaseId)));
      return {};
    }
    case "preview.info": {
      const current = await requireLease(requiredString(message, "lease_id"));
      if (!current.preview) return undefined;
      return {
        origin: current.claim.origin,
        permission: permissionPattern(current.claim.origin),
        recipe: current.preview,
      };
    }
    case "recipe.keep": {
      const leaseId = requiredString(message, "lease_id");
      return serializeLease(leaseId, async () => keepRecipe(
        await requireLease(leaseId),
        requiredString(message, "origin"),
      ));
    }
    case "recipe.list":
      return listRecipes();
    case "recipe.forget":
      return serializeRecipes(() => forgetRecipe(requiredString(message, "origin")));
    case "recipe.for_document":
      return recipeForDocument(requiredString(message, "url"), sender);
    default:
      throw new Error("Unknown extension request.");
  }
}

async function listRecipes(): Promise<StoredSiteRecipe[]> {
  const stored = await chrome.storage.local.get(null);
  const recipes: StoredSiteRecipe[] = [];
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith("site-recipe:") || !value || typeof value !== "object") continue;
    try {
      const candidate = value as StoredSiteRecipe;
      const origin = normalizeOrigin(candidate.origin);
      if (!Number.isFinite(candidate.updated_at_ms)) continue;
      recipes.push({
        origin,
        recipe: validateRecipe(candidate.recipe),
        updated_at_ms: candidate.updated_at_ms,
      });
    } catch {
      // Invalid retained state is not exposed to the panel.
    }
  }
  return recipes.sort((left, right) => right.updated_at_ms - left.updated_at_ms);
}

async function forgetRecipe(originValue: string): Promise<{ forgotten: boolean }> {
  const origin = normalizeOrigin(originValue);
  const key = recipeStorageKey(origin);
  const stored = await chrome.storage.local.get(key);
  if (!stored[key]) return { forgotten: false };
  const pattern = permissionPattern(origin);
  await chrome.storage.local.remove(key);
  try {
    await repairRecipeRegistration();
  } catch (error) {
    await chrome.storage.local.set({ [key]: stored[key] });
    await repairRecipeRegistration().catch(() => {});
    throw error;
  }
  await removeRecipeFromOpenTabs(pattern);
  const sharedByAnotherRecipe = (await listRecipes())
    .some((recipe) => permissionPattern(recipe.origin) === pattern);
  if (!sharedByAnotherRecipe) await chrome.permissions.remove({ origins: [pattern] });
  return { forgotten: true };
}

async function handleCleanup(leaseId: string, requestId: string, input: CleanupInput): Promise<unknown> {
  const current = await requireLease(leaseId);
  throwIfCancelled(requestId);
  await assertLeaseDocument(current);
  throwIfCancelled(requestId);
  switch (input.action) {
    case "inspect": {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId: current.claim.tab_id, documentIds: [current.claim.document_id] },
        world: "ISOLATED",
        func: inspectPage,
      });
      throwIfCancelled(requestId);
      if (!injection?.result) throw new Error("The selected document could not be inspected.");
      current.documentRevision = injection.result.document_revision;
      await saveLease(current);
      return injection.result;
    }
    case "preview": {
      if (!current.documentRevision || input.document_revision !== current.documentRevision) {
        throw new Error("The inspected document revision is stale.");
      }
      const recipe = validateRecipe(input.recipe);
      for (const selector of recipe.hide_selectors) {
        await validateSelector(current.claim, selector);
        throwIfCancelled(requestId);
      }
      const css = compileRecipeCss(recipe);
      await chrome.scripting.executeScript({
        target: { tabId: current.claim.tab_id, documentIds: [current.claim.document_id] },
        world: "ISOLATED",
        func: installPreview,
        args: [css],
      });
      if (cancelledRequests.has(requestId)) {
        await clearPreview(current);
        throw new Error("The cleanup request was cancelled.");
      }
      current.preview = recipe;
      current.previewId = crypto.randomUUID();
      await saveLease(current);
      if (cancelledRequests.has(requestId)) {
        await clearPreview(current);
        throw new Error("The cleanup request was cancelled.");
      }
      return { previewed: true, preview_id: current.previewId, name: recipe.name };
    }
    case "revert_preview":
      if (input.preview_id !== current.previewId) {
        throw new Error("The preview ID does not match the active preview.");
      }
      await clearPreview(current);
      return { reverted: true };
  }
}

async function keepRecipe(current: Lease, originValue: string): Promise<{ name: string }> {
  if (!current.preview) throw new Error("There is no preview to keep.");
  const origin = normalizeOrigin(originValue);
  if (origin !== current.claim.origin) throw new Error("The selected tab changed before the recipe was saved.");
  const pattern = permissionPattern(origin);
  if (!await chrome.permissions.contains({ origins: [pattern] })) {
    throw new Error("Site access was not granted.");
  }
  const stored: StoredSiteRecipe = { origin, recipe: current.preview, updated_at_ms: Date.now() };
  const key = recipeStorageKey(origin);
  await serializeRecipes(async () => {
    const previous = await chrome.storage.local.get(key);
    await chrome.storage.local.set({ [key]: stored });
    try {
      await repairRecipeRegistration();
    } catch (error) {
      if (previous[key] === undefined) await chrome.storage.local.remove(key);
      else await chrome.storage.local.set({ [key]: previous[key] });
      await repairRecipeRegistration().catch(() => {});
      throw error;
    }
  });
  const css = compileRecipeCss(current.preview);
  await applyRecipeToOpenTabs(pattern, css);
  delete current.preview;
  delete current.previewId;
  await saveLease(current);
  return { name: stored.recipe.name };
}

function selectTab(tab: chrome.tabs.Tab): void {
  if (tab.id === undefined) return;
  selectedTab = { tab_id: tab.id, window_id: tab.windowId };
  selectedTabWrite = chrome.storage.session.set({ [SELECTED_TAB_KEY]: selectedTab });
}

async function claimSelectedTab(): Promise<TabClaim> {
  await selectedTabWrite;
  if (!selectedTab) {
    const stored = await chrome.storage.session.get(SELECTED_TAB_KEY);
    if (isSelectedTab(stored[SELECTED_TAB_KEY])) selectedTab = stored[SELECTED_TAB_KEY];
  }
  if (!selectedTab) {
    throw new Error("Click the Nanocodex toolbar icon on the HTTP or HTTPS page you want to change.");
  }
  const target = selectedTab;
  const tab = await chrome.tabs.get(target.tab_id);
  if (tab.windowId !== target.window_id || !tab.url) {
    throw new Error("The selected tab is no longer available. Click the Nanocodex toolbar icon on the page again.");
  }
  const origin = normalizeOrigin(tab.url);
  let probe: chrome.scripting.InjectionResult<string> | undefined;
  try {
    [probe] = await chrome.scripting.executeScript({
      target: { tabId: target.tab_id, frameIds: [0] },
      world: "ISOLATED",
      func: () => location.href,
    });
  } catch {
    throw new Error("Nanocodex no longer has access to that page. Click its toolbar icon on the page again.");
  }
  if (!probe?.documentId || normalizeOrigin(String(probe.result)) !== origin) {
    throw new Error("The selected tab changed while it was being claimed.");
  }
  return {
    browser_instance_id: await browserInstanceId(),
    window_id: target.window_id,
    tab_id: target.tab_id,
    document_id: probe.documentId,
    origin,
    url: String(probe.result),
    ...(tab.groupId !== undefined && tab.groupId >= 0 ? { group_id: tab.groupId } : {}),
    observed_at_ms: Date.now(),
  };
}

async function assertLeaseDocument(current: Lease): Promise<void> {
  const tab = await chrome.tabs.get(current.claim.tab_id);
  if (
    tab.windowId !== current.claim.window_id
    || !tab.url
    || normalizeOrigin(tab.url) !== current.claim.origin
  ) {
    throw new Error("The leased document changed. Run the prompt again to claim the current page.");
  }
}

async function browserInstanceId(): Promise<string> {
  const stored = await chrome.storage.local.get(INSTANCE_KEY);
  if (typeof stored[INSTANCE_KEY] === "string") return stored[INSTANCE_KEY];
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [INSTANCE_KEY]: id });
  return id;
}

async function requireLease(leaseId: string): Promise<Lease> {
  const stored = await chrome.storage.session.get(leaseStorageKey(leaseId));
  const value = stored[leaseStorageKey(leaseId)] as Lease | undefined;
  if (!value || value.id !== leaseId) throw new Error("The selected-page lease expired.");
  return value;
}

async function saveLease(current: Lease): Promise<void> {
  if (invalidatedLeases.has(current.id)) throw new Error("The selected-page lease expired.");
  await chrome.storage.session.set({ [leaseStorageKey(current.id)]: current });
}

async function releaseLease(leaseId: string): Promise<void> {
  await serializeLease(leaseId, async () => {
    const stored = await chrome.storage.session.get(leaseStorageKey(leaseId));
    const current = stored[leaseStorageKey(leaseId)] as Lease | undefined;
    if (current?.id === leaseId) await clearPreview(current);
    await chrome.storage.session.remove(leaseStorageKey(leaseId));
  });
}

async function validateSelector(claim: TabClaim, selector: string): Promise<void> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: claim.tab_id, documentIds: [claim.document_id] },
    world: "ISOLATED",
    func: (candidate: string) => {
      try { document.querySelector(candidate); return true; } catch { return false; }
    },
    args: [selector],
  });
  if (result?.result !== true) throw new Error(`Invalid selector: ${selector}`);
}

async function clearPreview(current: Lease): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: current.claim.tab_id, documentIds: [current.claim.document_id] },
      world: "ISOLATED",
      func: removePreview,
    });
  } catch {
    // A closed or navigated document already discarded the preview.
  } finally {
    delete current.preview;
    delete current.previewId;
    await saveLease(current);
  }
}

async function interruptTab(tabId: number, reason: string): Promise<void> {
  const stored = await chrome.storage.session.get(null);
  const interrupted = Object.entries(stored)
    .filter(([key, value]) => key.startsWith(LEASE_PREFIX) && isLease(value) && value.claim.tab_id === tabId)
    .map(([, value]) => value as Lease);
  for (const current of interrupted) {
    invalidatedLeases.add(current.id);
    await chrome.storage.session.remove(leaseStorageKey(current.id));
    const message: PageInterrupted = { type: "page.interrupted", lease_id: current.id, reason };
    void chrome.runtime.sendMessage(message).catch(() => {});
  }
}

async function serializeLease<Result>(leaseId: string, operation: () => Promise<Result>): Promise<Result> {
  const previous = leaseQueues.get(leaseId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  leaseQueues.set(leaseId, current);
  try {
    return await current;
  } finally {
    if (leaseQueues.get(leaseId) === current) leaseQueues.delete(leaseId);
  }
}

async function serializeRecipes<Result>(operation: () => Promise<Result>): Promise<Result> {
  const current = recipeQueue.catch(() => {}).then(operation);
  recipeQueue = current;
  return current;
}

async function applyRecipeToOpenTabs(pattern: string, css: string): Promise<void> {
  const tabs = await chrome.tabs.query({ url: pattern });
  await Promise.all(tabs.flatMap((tab) => tab.id === undefined ? [] : [
    chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      world: "ISOLATED",
      func: commitPreview,
      args: [css],
    }).catch(() => []),
  ]));
}

async function removeRecipeFromOpenTabs(pattern: string): Promise<void> {
  const tabs = await chrome.tabs.query({ url: pattern });
  await Promise.all(tabs.flatMap((tab) => tab.id === undefined ? [] : [
    chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      world: "ISOLATED",
      func: removePersistedRecipe,
    }).catch(() => []),
  ]));
}

function throwIfCancelled(requestId: string): void {
  if (cancelledRequests.has(requestId)) throw new Error("The cleanup request was cancelled.");
}

function leaseStorageKey(leaseId: string): string {
  return `${LEASE_PREFIX}${leaseId}`;
}

function isLease(value: unknown): value is Lease {
  return Boolean(value) && typeof value === "object" && typeof (value as Lease).id === "string"
    && Boolean((value as Lease).claim) && typeof (value as Lease).claim.tab_id === "number";
}

function isSelectedTab(value: unknown): value is SelectedTab {
  return Boolean(value) && typeof value === "object"
    && typeof (value as SelectedTab).tab_id === "number"
    && typeof (value as SelectedTab).window_id === "number";
}

async function recipeForDocument(urlValue: string, sender: chrome.runtime.MessageSender): Promise<{ css: string } | undefined> {
  if (sender.frameId !== 0 || !sender.tab?.url || normalizeOrigin(sender.tab.url) !== normalizeOrigin(urlValue)) return undefined;
  const origin = normalizeOrigin(urlValue);
  const stored = await chrome.storage.local.get(recipeStorageKey(origin));
  const value = stored[recipeStorageKey(origin)] as StoredSiteRecipe | undefined;
  if (!value || value.origin !== origin) return undefined;
  return { css: compileRecipeCss(validateRecipe(value.recipe)) };
}

async function repairRecipeRegistration(): Promise<void> {
  const stored = await chrome.storage.local.get(null);
  const matches = new Set<string>();
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith("site-recipe:") || !value || typeof value !== "object") continue;
    try {
      const origin = normalizeOrigin((value as StoredSiteRecipe).origin);
      validateRecipe((value as StoredSiteRecipe).recipe);
      const pattern = permissionPattern(origin);
      if (await chrome.permissions.contains({ origins: [pattern] })) matches.add(pattern);
    } catch {
      // Invalid application state is ignored rather than broadening site access.
    }
  }
  const [registered] = await chrome.scripting.getRegisteredContentScripts({ ids: [REGISTRATION_ID] });
  if (matches.size === 0) {
    if (registered) await chrome.scripting.unregisterContentScripts({ ids: [REGISTRATION_ID] });
    return;
  }
  const desired: chrome.scripting.RegisteredContentScript = {
    id: REGISTRATION_ID,
    matches: [...matches].sort(),
    js: [RUNNER_FILE],
    runAt: "document_start",
    persistAcrossSessions: true,
    world: "ISOLATED",
  };
  if (!registered) {
    await chrome.scripting.registerContentScripts([desired]);
    return;
  }
  const currentMatches = [...(registered.matches ?? [])].sort();
  if (JSON.stringify(currentMatches) !== JSON.stringify(desired.matches)) {
    await chrome.scripting.updateContentScripts([desired]);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  if (typeof record[key] !== "string" || !record[key]) throw new Error(`${key} must be a non-empty string`);
  return record[key];
}

function requireSidePanelSender(sender: chrome.runtime.MessageSender): void {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("sidepanel.html")) {
    throw new Error("This extension request is restricted to the Nanocodex side panel.");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
