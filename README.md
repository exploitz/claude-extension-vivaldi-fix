# claude-extension-vivaldi-fix

A small Node.js script that patches the **Claude in Chrome (Beta)** extension so it works correctly in **Vivaldi** (and any other Chromium-based browser whose sidebar UI re-mounts the side panel across tab switches — Brave, Arc, multi-window Chrome, etc.).

## Symptoms this fixes

- Side panel "gets stuck" and operates on a tab you closed minutes ago.
- Claude replies "your active tab is showing an error and isn't accessible" while you're staring at a perfectly fine webpage.
- Claude refuses to use your real tab and offers to open a new one instead.
- Console errors like:
  - `Uncaught (in promise) Error: No tab with id: <N>`
  - `No group found for main tab <N>`
  - `Unchecked runtime.lastError: Cannot access a chrome:// URL`

If any of those describe what you're seeing, this script will fix it.

## Prerequisites

- **Node.js** v16 or newer ([download](https://nodejs.org/))
- **Git**
- Vivaldi (or another Chromium browser) with the **Claude extension installed once from the Chrome Web Store**, signed in and paired

## Install

### Step 1 — Clone this repo

```
git clone https://github.com/exploitz/claude-extension-vivaldi-fix.git
cd claude-extension-vivaldi-fix
```

### Step 2 — Copy the installed extension here

Pick the section that matches your OS. Each one ends with a `claude-ext-patched/` folder next to `apply-patch.js`, ready for Step 3.

<details open>
<summary><b>Windows (PowerShell)</b></summary>

```powershell
$Src = "$env:LOCALAPPDATA\Vivaldi\User Data\Default\Extensions\fcoeoabgfenejglbffodgkkbkcdhcgfn"
$Ver = (Get-ChildItem $Src | Sort-Object Name | Select-Object -Last 1).Name
Copy-Item -Recurse "$Src\$Ver" .\claude-ext-patched
Remove-Item -Recurse -Force .\claude-ext-patched\_metadata
```
</details>

<details>
<summary><b>Windows (WSL / Git Bash)</b></summary>

```bash
# Replace WIN_USER with your Windows username (the folder name under C:\Users\)
WIN_USER=YourWindowsUsername
SRC="/mnt/c/Users/$WIN_USER/AppData/Local/Vivaldi/User Data/Default/Extensions/fcoeoabgfenejglbffodgkkbkcdhcgfn"
VER=$(ls "$SRC" | sort -V | tail -1)
cp -r "$SRC/$VER" ./claude-ext-patched
rm -rf ./claude-ext-patched/_metadata
```
</details>

<details>
<summary><b>macOS</b></summary>

```bash
SRC="$HOME/Library/Application Support/Vivaldi/Default/Extensions/fcoeoabgfenejglbffodgkkbkcdhcgfn"
VER=$(ls "$SRC" | sort -V | tail -1)
cp -r "$SRC/$VER" ./claude-ext-patched
rm -rf ./claude-ext-patched/_metadata
```
</details>

<details>
<summary><b>Linux</b></summary>

```bash
SRC="$HOME/.config/vivaldi/Default/Extensions/fcoeoabgfenejglbffodgkkbkcdhcgfn"
VER=$(ls "$SRC" | sort -V | tail -1)
cp -r "$SRC/$VER" ./claude-ext-patched
rm -rf ./claude-ext-patched/_metadata
```
</details>

### Step 3 — Apply the patches

```
node apply-patch.js ./claude-ext-patched
```

The script will list each patch with `APPLY` or `SKIP` (skip = already patched, safe to re-run). If Anthropic refactored the bundle and an anchor no longer matches, it fails loudly with the patch name so you know where to look — [open an issue](https://github.com/exploitz/claude-extension-vivaldi-fix/issues) and I'll re-locate it.

> **Optional:** pass `--bypass-block` to also short-circuit the extension's site-categorization gate so it treats every URL as allowed. This is not a bug fix — it overrides intentional Anthropic behavior. See [Optional: bypass site categorization](#optional-bypass-site-categorization) below.
>
> ```
> node apply-patch.js ./claude-ext-patched --bypass-block
> ```

### Step 4 — Load it in Vivaldi

1. Open `vivaldi://extensions`.
2. **Remove** the Web Store "Claude" extension (not just disable — the `key` field in the manifest makes both resolve to the same extension ID and they'll conflict). Removing also prevents Vivaldi from silently auto-updating over your patched copy.
3. Toggle **Developer mode** on (top-right of the page).
4. Click **Load unpacked** → select the `claude-ext-patched/` folder.
5. Confirm it appears as "Claude" v1.0.x. The extension ID will be the same as before because of the `key` field, so your login and pairing carry over.

## Updating

Unpacked extensions don't auto-update. When Anthropic ships a new version:

1. Re-install the Web Store version inside Vivaldi temporarily.
2. Re-run **Step 2** (copy) and **Step 3** (patch).
3. Remove the Web Store version again and reload your unpacked copy.

The script is **idempotent** — re-running it after a version bump only applies patches that aren't already in place.

## How it works

The script makes 7 surgical edits to the extension's minified bundles plus installs one global error handler. All five underlying defects share the same architectural pattern: async tab-lookup functions that `throw` instead of returning `null`, plus React state that captures `tabId` at mount and never refreshes.

<details>
<summary>Patch breakdown</summary>

| # | Fix | Why |
|---|-----|-----|
| 1 | `findGroupByTab` rejects invalid tab IDs early | Throws on `-1` (`chrome.tabs.TAB_ID_NONE`, common in Vivaldi sidebar contexts) |
| 2 | `findGroupByTab` wraps `chrome.tabs.get` in try/catch | Stops unhandled promise rejection when the tab is gone |
| 3 | `getGroupDetails` calls `initialize()` first and returns null instead of throwing | Survives MV3 service-worker restarts |
| 4 | `setGroupIndicatorState` and `showSecondaryTabIndicators` guard the null result | Prevents cascading errors from #3 |
| 5 | Global `unhandledrejection` handler installed in side panel | Catches 16+ fire-and-forget chrome.tabs.* calls |
| 6 | Side panel resolver always uses the live active tab | URL's `?tabId=` is treated as a hint of last resort |
| 7 | Side panel listens for `chrome.tabs.onActivated` | Updates target tab in real time when you switch tabs |
| — | `getCategory` → `"category0"` *(opt-in, `--bypass-block`)* | Short-circuits the site-categorization gate so every URL is treated as allowed. Not a bug fix; off by default. |

Total: ~50 lines of injected code into a 2.3 MB minified bundle.
</details>

## Optional: bypass site categorization

The extension fetches a per-URL "category" from Anthropic and refuses to operate on URLs that come back as a blocked category — `reddit.com` is the canonical example users hit. Passing `--bypass-block` rewrites the `getCategory` function in `mcpPermissions-*.js` to always return `"category0"` (the allowed category):

```
node apply-patch.js ./claude-ext-patched --bypass-block
```

This is **not a bug fix** — Anthropic categorizes those sites on purpose. The flag is off by default so the standard invocation stays scoped to the seven tab-tracking bug fixes. Re-run with `--bypass-block` after each upstream version bump if you want this behavior to persist. The patch is idempotent and the script will `FAIL` loudly with the patch name if Anthropic refactors `getCategory`.

## Why this approach (vs. forking the extension)

- **License clean.** You install the official extension from the Chrome Web Store; this script only modifies your local copy. No third-party code in this repo.
- **Version-agnostic.** The script targets minified function signatures, not line numbers. It survives upstream changes until Anthropic refactors those specific functions.
- **Tiny diff to review.** ~250 lines of plain Node.js. You can read the whole script in a few minutes before running it.

## Reporting upstream

The bugs aren't actually Vivaldi-specific — they're latent in Chrome too, just harder to trigger (reload the extension while the side panel is open, or open multiple windows). If you have a channel to Anthropic, the relevant details are in [`apply-patch.js`](./apply-patch.js) — each patch's `name` and inline comment describes the bug and the fix.

## License

MIT — see [`LICENSE`](./LICENSE).
