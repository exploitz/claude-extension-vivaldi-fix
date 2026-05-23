# claude-extension-vivaldi-fix

A small, idempotent Node.js script that patches the **Claude in Chrome (Beta)** extension to work correctly in **Vivaldi** and other non-Chrome Chromium browsers (Brave, Arc, etc.).

## What's broken

The Claude extension assumes its side panel will always be opened on, and stay on, a single specific tab. That's *usually* true in Chrome — but not in Vivaldi, where the sidebar keeps the panel mounted across tab switches, or in multi-window Chrome workflows.

The user-visible symptoms are some combination of:

- The side panel "gets stuck" and acts on a tab you closed minutes ago.
- Claude replies "your active tab is showing an error and isn't accessible" while you're staring at a perfectly fine webpage.
- Claude refuses to act on your real tab and offers to open a new one instead.
- Console fills with `Uncaught (in promise) Error: No tab with id: <N>`, `No group found for main tab <N>`, or `Unchecked runtime.lastError: Cannot access a chrome:// URL`.

Underneath, there are five separate code defects in the extension bundle — all the same architectural pattern (async functions that throw instead of returning null, plus a React state that captures the tab ID at mount and never refreshes). This script patches them all in one shot.

## What the script does

| # | Fix | Why |
|---|-----|-----|
| 1 | `findGroupByTab` rejects invalid tab IDs early | Throws on `-1` (`chrome.tabs.TAB_ID_NONE`, common in Vivaldi sidebar contexts) |
| 2 | `findGroupByTab` wraps `chrome.tabs.get` in try/catch | Stops unhandled promise rejection when the tab is gone |
| 3 | `getGroupDetails` calls `initialize()` first and returns null instead of throwing | Survives MV3 service-worker restarts |
| 4 | `setGroupIndicatorState` and `showSecondaryTabIndicators` guard the null result | Prevents cascading errors from #3 |
| 5 | Installs a global `unhandledrejection` handler in the side panel | Catches the remaining fire-and-forget call sites (16+ of them) |
| 6 | Side panel resolver always uses the live active tab | URL's `?tabId=` is treated as a hint of last resort |
| 7 | Side panel listens for `chrome.tabs.onActivated` | Updates target tab in real time when you switch tabs |

Total: ~50 lines of injected code into a 2.3 MB minified bundle. The script is **idempotent** — safe to re-run after extension updates.

## Install

You need Node.js (any recent version) and a one-time install of the Claude extension from the Chrome Web Store inside Vivaldi.

```bash
# 1. Install the Claude extension from the Chrome Web Store in Vivaldi (one-time).
#    Sign in and complete pairing as usual.

# 2. Clone this repo somewhere
git clone https://github.com/exploitz/claude-extension-vivaldi-fix.git
cd claude-extension-vivaldi-fix

# 3. Copy the installed extension to a writable location.
#    Paths below assume the default install location for each OS.

# --- Windows (from WSL) ---
SRC="/mnt/c/Users/$USER/AppData/Local/Vivaldi/User Data/Default/Extensions/fcoeoabgfenejglbffodgkkbkcdhcgfn"

# --- macOS ---
# SRC="$HOME/Library/Application Support/Vivaldi/Default/Extensions/fcoeoabgfenejglbffodgkkbkcdhcgfn"

# --- Linux ---
# SRC="$HOME/.config/vivaldi/Default/Extensions/fcoeoabgfenejglbffodgkkbkcdhcgfn"

VER=$(ls "$SRC" | sort -V | tail -1)
cp -r "$SRC/$VER" ./claude-ext-patched
rm -rf ./claude-ext-patched/_metadata        # required for "Load unpacked"

# 4. Apply the patches
node apply-patch.js ./claude-ext-patched
```

The script will print which patches were applied and which were skipped (already present). It refuses to patch ambiguously — if Anthropic refactored the bundle and an anchor string no longer matches, it fails loudly with the patch name so you know where to look.

## Load the patched extension in Vivaldi

1. Open `vivaldi://extensions`
2. **Remove** the Web Store "Claude" extension (not just disable — the `key` field in the manifest makes both resolve to the same extension ID and they'll conflict). Removing it also prevents Vivaldi from silently auto-updating over your patched copy.
3. Toggle **Developer mode** on (top-right of the page).
4. Click **Load unpacked** → select the `claude-ext-patched/` folder.
5. Confirm it appears as "Claude" v1.0.x. The extension ID will be the same as before because of the `key` field, so your login and pairing carry over.

## When Anthropic ships an update

Unpacked extensions don't auto-update. To pull in a new version:

```bash
# 1. Re-install the Web Store version temporarily inside Vivaldi.
# 2. Re-run the copy + patch steps from "Install" above.
# 3. Remove the Web Store version again, then reload your unpacked copy.
```

The patch script is **idempotent** and will tell you per-patch whether it was applied or already present. If Anthropic refactored a function and an anchor no longer matches, the script fails with the patch name so you know where to look. Open an issue here and we'll re-locate it.

## Why this approach (vs. forking the extension)

This repo intentionally ships **only the patch script**, not Anthropic's extension code. Reasons:

- **License clean.** You install the official extension from the Chrome Web Store; this script only modifies your local copy. No third-party code redistribution.
- **Version-agnostic.** The script targets minified function signatures, not specific line numbers. It works for any version Anthropic ships until they refactor those functions.
- **Tiny diff to review.** ~250 lines of Node.js. You can read the whole thing in a few minutes before running it.

## Reporting upstream

The bugs aren't Vivaldi-specific — they're latent in Chrome too, just harder to trigger. If you have a channel to Anthropic, the relevant details:

- All five bugs live in `assets/mcpPermissions-*.js` and `assets/sidepanel-*.js`.
- Common shape: async tab-lookup functions that `throw` instead of returning `null`; React state that captures `tabId` at mount and never re-resolves.
- Repro: open a second Vivaldi window, click into the side panel there, send a message. Or in Chrome: reload the extension while the side panel is open.
- Fix is essentially what this script does — wrap `chrome.tabs.get` in try/catch, return null on failure, add a `chrome.tabs.onActivated` listener.

## License

MIT — see `LICENSE`.

The patch script itself is original work. Running it against the Claude extension produces a modified local copy of Anthropic's code; that modified copy is for personal use under whatever terms Anthropic's extension is distributed.
