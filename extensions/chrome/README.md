# Nanocodex Chrome extension

Nanocodex for Chrome is a Manifest V3 consumer of the account-owned hosted
agent contract. The React side panel opens the durable agent authorized by
Nanocodex Connect and reverse-attaches one explicitly selected Chrome tab as a
host tool. The background service worker owns only Chrome tab leases, bounded
page inspection, reversible previews, and saved site recipes. There is no
parallel extension backend, native host, or extension-to-process protocol.

## MVP flow

1. Open an HTTP(S) page and click the Nanocodex toolbar action. The action opens
   one React side panel and grants temporary `activeTab` access.
2. Connect Nanocodex. The hosted Connect popup reuses the canonical Nanocodex
   passkey account and asks only for final replies, conversation history, and
   ChatGPT-backed agent access. Action summaries and raw traces stay hidden.
   The app-scoped grant is retained in extension-local storage and validated
   when the panel is reopened.
3. The Connect SDK opens the account-owned durable agent and exchanges the
   grant for a one-time ticket to its private tool-host socket. The extension's
   `cleanup` catalog is attached to that exact agent and grant. No OpenAI or
   ChatGPT credential enters extension storage or browser traffic.
4. Chat with the cleanup agent. The panel immediately records each user turn,
   labels its local inspect/preview activity, streams the reply, and exposes a
   stop control. The hosted agent calls the attached `cleanup` tool with
   `inspect`, `preview`, and `revert_preview` actions. Follow-on prompts and
   browser restarts restore the account-owned conversation.
5. Inspection returns at most 500 visible semantic DOM candidates and 60,000
   characters. It omits form values, storage, cookies, other tabs, subframes,
   and URL queries/fragments.
6. A recipe `{name, css, hide_selectors}` is validated and previewed as one
   removable style element. Model output can never inject JavaScript, HTML,
   event handlers, remote resources, or extension capabilities.
7. **Revert** removes the preview. **Keep for this site** asks for an optional
   permission for that HTTP(S) host, stores the recipe in
   `chrome.storage.local`, and installs a persistent dynamic content script only
   for origins with approved recipes.
8. Saved recipes are listed in the side panel. **Forget** removes the recipe
   from storage and every open matching tab, unregisters future injection, and
   revokes site access when no other saved origin on that host still needs it.
   Both saved and forgotten state survive closing and reopening Chrome.

The selected document is represented by an extension-owned opaque lease. Every
tool call checks that lease; navigation or tab closure invalidates it and
cancels the active turn. Page requests continue to use Chrome's existing
logged-in session, but cookie values are never copied into the agent, Connect,
or extension storage.

Only one side panel in the Chrome profile can own the reverse-attached cleanup
host at a time. The panel keeps that browser-owned lock for its agent session,
so a second window cannot redirect an in-flight tool call to a different tab.
Disconnect performs an ordered shutdown after an active turn settles. On panel
unload, the page synchronously fences its tool dispatcher and initiates turn
cancellation, lease release, attachment closure, and lock release before Chrome
can destroy the document; Chrome also releases the Web Lock with the document.
Grants created by the earlier local-agent preview are discarded on reconnect
and require one fresh approval because they do not identify a durable agent.

## Build and check

```sh
npm ci --prefix js/bindings
npm ci --prefix extensions/chrome
npm test --prefix extensions/chrome
npm run build --prefix extensions/chrome
```

Load `extensions/chrome/.output/chrome-mv3` from `chrome://extensions` in
developer mode. Exercise prompt → inspection → preview → Revert, then repeat
and Keep on a local fixture page. Reload or open a second tab to prove the saved
recipe reapplies. Close and reopen Chrome to prove both the Connect grant and
recipe return. Inspect the extension page, selected-page console, failed
requests, and ticketed Connect WebSocket before considering a browser change
complete.

## Permissions and security boundary

- Required Chrome APIs: `activeTab`, `scripting`, `sidePanel`, and `storage`.
- Required network origin: the pinned Nanocodex Connect API. The passkey flow
  opens the canonical HTTPS Connect host as a top-level popup; it is not embedded
  and receives no extension host permission.
- Optional: HTTP(S) host access, requested for one host only after **Keep**.
- Deliberately absent: `nativeMessaging`, `tabs`, `debugger`, `cookies`,
  `webRequest`, downloads, clipboard, broad required page access, externally
  connectable pages, and remote code.
- The Connect dialog owns passkey approval. The extension retains only its
  app-scoped grant session in origin-local storage; content scripts cannot read
  extension-local storage, and one-time tool-host tickets are never retained. No
  OpenAI API key, ChatGPT OAuth token, cookie, or provider credential is stored
  by the extension.
- Preview and persistence run in Chrome's isolated world. The model sees only
  the narrow cleanup schema, never tab IDs, lease tokens, browser inventory, or
  Chrome APIs.
