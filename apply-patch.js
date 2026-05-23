#!/usr/bin/env node
// Patches the Claude Chrome extension to behave sanely in Vivaldi.
// Idempotent: safe to re-run after Web Store updates (will fail loudly if
// the upstream bundle changed enough that the anchor strings no longer match).
//
// Usage: node apply-patch.js <ext-dir> [--bypass-block]
//
// Patch groups:
//   v1: mcpPermissions  — findGroupByTab guards
//   v2: mcpPermissions  — getGroupDetails + unprotected callers
//   v3: sidepanel.html  — global unhandledrejection guard
//   v4: sidepanel-*.js  — tab resolver falls back to live active tab
//   bonus (opt-in, --bypass-block):
//        mcpPermissions  — getCategory always returns "category0" (unblocks all sites)
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.filter((a) => !a.startsWith('--'));
const extDir = positional[0];
const BYPASS_BLOCK = flags.has('--bypass-block');
if (!extDir) { console.error('usage: apply-patch.js <ext-dir> [--bypass-block]'); process.exit(2); }

const assets = path.join(extDir, 'assets');

function findBundle(prefix) {
  const f = fs.readdirSync(assets).find((f) => f.startsWith(prefix) && f.endsWith('.js'));
  if (!f) { console.error(`FAIL: bundle ${prefix}*.js not found in ${assets}`); process.exit(2); }
  return path.join(assets, f);
}

const occ = (s, n) => { let c = 0, i = -1; while ((i = s.indexOf(n, i + 1)) !== -1) c++; return c; };

const VERSION = 'v5';

// -------------------- bundle patches --------------------

const bundlePatches = [
  {
    bundle: findBundle('mcpPermissions-'),
    patches: [
      {
        name: 'mcp: findGroupByTab — reject invalid tab IDs early',
        find: 'async findGroupByTab(e){await this.initialize();',
        repl: 'async findGroupByTab(e){/*VIVALDI-FIX-v1*/if(typeof e!=="number"||e<0)return null;await this.initialize();',
      },
      {
        name: 'mcp: findGroupByTab — try/catch around chrome.tabs.get(e)',
        find: 'const r=await chrome.tabs.get(e);if(r.groupId===chrome.tabGroups.TAB_GROUP_ID_NONE)return null;',
        repl: 'let r;try{r=await chrome.tabs.get(e)}catch{return null}if(!r||r.groupId===chrome.tabGroups.TAB_GROUP_ID_NONE)return null;',
      },
      {
        name: 'mcp: getGroupDetails — initialize() first, return null instead of throw',
        find: 'async getGroupDetails(e){const t=this.groupMetadata.get(e);if(!t)throw new Error(`No group found for main tab ${e}`);',
        repl: 'async getGroupDetails(e){/*VIVALDI-FIX-v2*/await this.initialize();const t=this.groupMetadata.get(e);if(!t)return null;',
      },
      {
        name: 'mcp: setGroupIndicatorState — guard null result from getGroupDetails',
        find: 'async setGroupIndicatorState(e,t){const r=await this.getGroupDetails(e);',
        repl: 'async setGroupIndicatorState(e,t){const r=await this.getGroupDetails(e);if(!r)return;',
      },
      {
        name: 'mcp: showSecondaryTabIndicators — guard null result from getGroupDetails',
        find: 'async showSecondaryTabIndicators(e){const t=await this.getGroupDetails(e);',
        repl: 'async showSecondaryTabIndicators(e){const t=await this.getGroupDetails(e);if(!t)return;',
      },
      ...(BYPASS_BLOCK ? [{
        // BONUS (opt-in, --bypass-block): short-circuit category lookup so the
        // extension treats every URL as category0 (unblocked). Bypasses Anthropic's
        // site categorization entirely — useful for sites Anthropic blocks by
        // default (e.g. reddit.com) that you want the assistant to operate on.
        name: 'mcp: getCategory — bypass block (always return category0) [opt-in]',
        find: 'async getCategory(e){if(e=this.normalizeUrl(e),!/^https?:\\/\\//i.test(e))return;if(await G.isUrlBlockedByManagedPolicy(e))return"category_org_blocked";const t=this.cache.get(e);if(t){if(!(Date.now()-t.timestamp>this.CACHE_TTL_MS))return t.category;this.cache.delete(e)}const r=this.pendingRequests.get(e);if(r)return r;const o=this.fetchCategoryFromAPI(e);this.pendingRequests.set(e,o);try{return await o}finally{this.pendingRequests.delete(e)}}',
        repl: 'async getCategory(e){/*VIVALDI-BYPASS-v1*/return"category0"}',
      }] : []),
    ],
  },
  {
    bundle: findBundle('sidepanel-'),
    patches: [
      {
        // v5 — always prefer the live active tab over the URL's ?tabId=.
        // Unconditionally overrides r with whatever tab is active in the
        // currently-focused window, treating the URL tabId as a hint of
        // last resort. The anchor is Anthropic's original code so this
        // applies cleanly to a fresh bundle; idempotence is handled by
        // the repl's /*VIVALDI-FIX-v5*/ sentinel.
        name: 'sidepanel: URL tabId resolver — always prefer live active tab',
        find: 'if(o(r),r)try{const e=await chrome.tabs.get(r);',
        repl: 'try{const[vfx]=await chrome.tabs.query({active:!0,lastFocusedWindow:!0});if(vfx&&vfx.id)r=vfx.id/*VIVALDI-FIX-v5*/}catch{}if(o(r),r)try{const e=await chrome.tabs.get(r);',
      },
      {
        // v5 — inject a useEffect that listens for chrome.tabs.onActivated and
        // updates the panel state (tabId + url + hostname + title) in real time
        // when the user switches tabs. Side panels in Vivaldi often don't
        // unmount on close, so even close+reopen doesn't re-run the resolver.
        // Without this, the panel stays bound to whichever tab was active at
        // first-mount time. The setters o/u/l/p come from the surrounding
        // useState destructure: o=setTabId, u=setUrl, l=setDomain, p=setTitle.
        name: 'sidepanel: inject chrome.tabs.onActivated listener',
        find: 'a.useEffect(()=>{if(!i)return;const e=(e,t)=>{',
        repl: 'a.useEffect(()=>{const vfx_act=async(e)=>{if(!e||typeof e.tabId!=="number")return;o(e.tabId);try{const t=await chrome.tabs.get(e.tabId);if(t.url){u(t.url);try{const e=new URL(t.url);l(e.hostname)}catch{}}if(t.title)p(t.title)}catch{}};chrome.tabs.onActivated.addListener(vfx_act);return()=>chrome.tabs.onActivated.removeListener(vfx_act)},[]/*VIVALDI-FIX-v5-act*/),a.useEffect(()=>{if(!i)return;const e=(e,t)=>{',
      },
    ],
  },
];

let totalApplied = 0, totalSkipped = 0;
for (const group of bundlePatches) {
  const before = fs.readFileSync(group.bundle, 'utf8');
  let src = before;
  let applied = 0, skipped = 0;
  for (const p of group.patches) {
    if (src.includes(p.repl)) { console.log(`SKIP: ${p.name}`); skipped++; continue; }
    const n = occ(src, p.find);
    if (n === 0) {
      console.error(`FAIL: ${p.name} — anchor not found and replacement not present. Bundle has changed; locate the new injection point manually.`);
      process.exit(1);
    }
    if (n > 1) {
      console.error(`FAIL: ${p.name} — anchor appears ${n} times, expected 1. Refusing to patch ambiguously.`);
      process.exit(1);
    }
    src = src.replace(p.find, p.repl);
    console.log(`APPLY: ${p.name}`);
    applied++;
  }
  if (applied > 0) {
    fs.writeFileSync(group.bundle, src);
    console.log(`  -> ${path.basename(group.bundle)} (+${src.length - before.length} bytes; ${applied} applied, ${skipped} already present)`);
  } else {
    console.log(`  -> ${path.basename(group.bundle)}: no changes (${skipped} patches already present)`);
  }
  totalApplied += applied;
  totalSkipped += skipped;
}

// -------------------- v3: rejection guard install --------------------

const GUARD_JS = `// vivaldi-fix-guard.js (auto-installed by apply-patch.js)
(function () {
  const SWALLOW = [
    /No tab with id:/,
    /No group found for main tab/,
    /Value must be at least 0/,
    /Invalid tab ID/,
    /Cannot access contents of url/,
  ];
  let n = 0;
  window.addEventListener('unhandledrejection', function (e) {
    const msg = (e.reason && (e.reason.message || e.reason)) + '';
    if (SWALLOW.some((re) => re.test(msg))) {
      e.preventDefault();
      n++;
      if (n === 1 || n % 25 === 0) {
        console.debug('[vivaldi-fix] swallowed stale-tab rejection (#' + n + '): ' + msg);
      }
    }
  });
})();
`;
const GUARD_FILENAME = 'vivaldi-fix-guard.js';
const GUARD_TAG = `<script src="/${GUARD_FILENAME}"></script>`;
const SIDEPANEL_HTML = path.join(extDir, 'sidepanel.html');

function installGuardFile() {
  const target = path.join(extDir, GUARD_FILENAME);
  if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === GUARD_JS) {
    console.log(`SKIP: write ${GUARD_FILENAME}`); return false;
  }
  fs.writeFileSync(target, GUARD_JS);
  console.log(`APPLY: install ${GUARD_FILENAME}`);
  return true;
}

function injectGuardTag() {
  if (!fs.existsSync(SIDEPANEL_HTML)) { console.error(`FAIL: ${SIDEPANEL_HTML}`); process.exit(1); }
  let html = fs.readFileSync(SIDEPANEL_HTML, 'utf8');
  if (html.includes(GUARD_TAG)) { console.log('SKIP: sidepanel.html guard tag'); return false; }
  const m = html.match(/<title>[^<]*<\/title>\s*\n?/);
  if (!m) { console.error('FAIL: <title> tag not found in sidepanel.html'); process.exit(1); }
  const insertAt = m.index + m[0].length;
  html = html.slice(0, insertAt) + `    ${GUARD_TAG}\n` + html.slice(insertAt);
  fs.writeFileSync(SIDEPANEL_HTML, html);
  console.log('APPLY: inject guard tag into sidepanel.html');
  return true;
}

const guardChanged = [installGuardFile(), injectGuardTag()].some(Boolean);

console.log(`\nDone (${VERSION}). bundle: ${totalApplied} applied, ${totalSkipped} skipped. guard: ${guardChanged ? 'updated' : 'unchanged'}.`);
