# PageShotter — Engineering Conventions

How code is written in this repository, for people and coding agents alike. Read it before changing
anything.

## Commands

```bash
npm run verify     # lint + typecheck + test + page checks + build — run before opening a pull request
npm test           # vitest, pure functions only
npm run build      # esbuild → dist/ (unpacked extension, load this in Chrome)
npm run build:edge # esbuild → dist-edge/ (load this in Edge)
npm run build:firefox # esbuild → dist-firefox/ (load as a temporary add-on in Firefox)
npm run dev        # rebuild dist/ on every change; add `-- --target edge` for dist-edge/
npm run package    # build + zip → pageshotter-extension.zip
npm run package:edge # build + zip → pageshotter-extension-edge.zip
npm run package:firefox # build + zip → pageshotter-extension-firefox.zip, plus -source.zip for AMO (clean tree only)
npm run fixtures   # serve tests/fixtures on http://localhost:4173
```

## Engineering posture

The default is the simplest solution that actually works. Simple means efficient, not careless.
Stop at the first rung that holds:

1. **Does this need to exist at all?** Speculative need — skip it, and say so in one line.
2. **Already in this codebase?** A helper, type or pattern that already lives here — reuse it.
3. **Standard library?** Use it.
4. **Native platform feature?** CSS over JS, a DOM API over a wrapper, a build step over a runtime
   library.
5. **An already-installed dependency?** Use it. Never add a new one for what a few lines can do.
6. **Can it be one line?** One line.
7. **Only then**, the minimum code that works.

- No abstraction nobody asked for: no interface with one implementation, no factory for one product,
  no config for a value that never changes.
- Deletion over addition. Boring over clever.
- **A bug fix is the root cause, not the symptom.** Before editing, find every caller of the function
  you are about to touch. One guard in the shared function beats a guard in every caller.
- Mark a deliberate shortcut with a known ceiling using a `ponytail:` comment naming the ceiling and
  the upgrade path — `// ponytail: O(n^2) over segments, fine under the 200-segment cap`. `rg
  'ponytail:'` is the debt ledger.

**Never simplified away:** input validation at trust boundaries, error handling that prevents data
loss, and accessibility basics. **Capture correctness outranks a shorter diff** every time.

This is already how the codebase was built: the PDF writer is hand-written rather than a dependency,
and the icon set is inlined at build time rather than shipped as a runtime library.

## Architecture

```
src/
  background/service-worker.ts   orchestration, chrome.tabs.captureVisibleTab, job state, cancellation
  content/capture-session.ts     page analysis, scrolling, reversible DOM mutation, lazy settling
  result/stitcher.ts             stitch planning + tiled assembly
  result/result.ts               preview and export UI
  result/pdf-export.ts           PDF writer (hand-written, no dependencies)
  editor/scene.ts                the editor's document and every number derived from it
  batch/batch.ts                 batch capture: opens each listed page, then saves it like the result page
  shared/                        messages, geometry, capture limits, IndexedDB, errors
```

Three roles, kept separate:

- **Content script** measures and mutates the page. It never captures.
- **Service worker** drives the loop and calls Chrome's capture API. It never touches the DOM.
- **Result page** assembles and exports. It never talks to the page.
- **Batch page** opens and loads each listed page in a tab beside itself, asks the worker to capture
  it (`START_BATCH_CAPTURE`, which opens no result page), then assembles and saves it the way the
  result page would. It never talks to the page either. It is a background tab while it runs, so it
  waits on events (`BATCH_JOB_SETTLED`, tab updates), never on a polling timer the browser throttles.

A capture whose page goes off screen -- tab switched away from, window covered or minimised --
**pauses and carries on**; it does not fail. The browser draws nothing for such a page, so frame
waits hold, the worker waits for the page to be on screen before each screenshot and positions the
section again afterwards, and the content watchdog does not fire while a request is being served.
Time spent hidden is left out of the capture deadline.

Segments travel through IndexedDB (`shared/capture-db.ts`), not through service-worker memory, and
are deleted after assembly, failure, or cancellation.

In the editor, `scene.ts` owns every number. The interactive preview and the banded export renderer
both consume its output and never derive geometry of their own; two renderers computing their own
geometry is how a preview and an exported file come to disagree.

## Invariants

These are product requirements, not preferences. Breaking one is a store-review or user-trust risk,
and a pull request that breaks one will not be merged.

- **Required permissions stay at `activeTab` + `scripting` + `contextMenus`.** No host permissions, no `tabs`, no
  `debugger`, and no required `downloads`. `downloads` exists only under `optional_permissions`,
  requested at runtime when the user saves into a folder or starts a batch. `<all_urls>` exists only
  under `optional_host_permissions`, requested when a batch starts (`captureVisibleTab` accepts
  nothing narrower), and nothing but batch capture may depend on it. A new permission also changes the store
  listing and the privacy policy, so it needs discussion in an issue first.
- **Anything newly persisted is a disclosure change**, even when it needs no permission. IndexedDB
  asks Chrome for nothing, so the permission rule above never fires on it. If a change stores a new
  *kind* of thing, or keeps an existing kind for longer, it updates the facts table in
  `public/welcome.html` in the same change and says so in the pull request, so the published privacy
  policy can follow.
- **No remote code.** No `eval`, no `new Function`, no injected script URLs, no CDN. `dist/` is
  scanned before packaging.
- **Everything local.** No screenshot upload, no page DOM leaving the device, no telemetry, and no
  webfont or other network request of any kind.
- **Every page mutation is reversible.** Style changes go through `MutationLedger`, which restores on
  success, failure, cancellation, watchdog timeout, and worker restart. Never mutate a page directly.
- **No per-hostname special-casing.** Detection must be generic. Hostname lists read as suspicious to
  store reviewers, and someone else's DOM is a permanent maintenance liability.
- **Fail safely and say why.** A partial screenshot with an explanation beats an error; an error with
  a plain-English cause beats a silent failure.

## Browsers

One source tree builds for every browser; `src/shared/browsers.json` holds what differs between them
(the name in copy, the extensions page, the store). Code reads it through `src/shared/browser.ts`,
chosen at build time by `--target`, never by sniffing the browser at runtime. Pages name the browser
only inside a marker, `<span data-browser="name">Chrome</span>`, which the build fills per target;
`verify:pages` fails on a bare "Chrome" anywhere else in a page. Comments that explain how Chrome
behaves stay as they are.

- **The manifest is Chrome's**, and Edge ships it unchanged. Firefox's differences are applied by
  `manifestFor` in `scripts/targets.mjs`: an event page instead of a service worker, the AMO ID, the
  minimum version and the data-collection declaration. **A permission never differs between
  browsers**; a test holds that.
- **Firefox won't let an extension open `about:addons`.** Shortcuts go through
  `commands.openShortcutSettings()` (`openShortcutSettings` in `browser.ts`), and anything that
  would link to the extension's own page states the steps in words instead
  (`extensionsPageOpenable`).
- **Restricted pages are recognised by error text and, after a failure, by the tab's address**
  (`isRestrictedPageUrl`). Firefox words every refusal the same way, so its text alone can't tell a
  forbidden page from a fault.
- `npx web-ext lint --source-dir dist-firefox` should report nothing. It is run ad hoc rather than
  added as a dependency. Build DOM from nodes, not `innerHTML`; AMO review reads every assignment.

## Design

Every extension page loads `public/tokens.css` first, then its own stylesheet; the full-tab pages
(result, history, settings) also load `public/page-frame.css` for the shapes they share. Put a rule
in `page-frame.css` only if every page on that shape wants it.

- **Tokens live in `tokens.css` and nowhere else.** A component rule that declares its own colour is
  the failure that file exists to prevent. `--accent` (#E11900) marks state; `--accent-hi` (#FF0000)
  is the logo's red and belongs only to the mark and the primary capture button, because white text
  on it is under the 4.5:1 contrast floor.
- **Every page applies the stored theme on load.** `src/shared/theme.ts` stores `system` / `light` /
  `dark`, and `tokens.css` carries the matching cascade. A page that skips `applyStoredTheme`
  silently ignores the setting.
- The six annotation colours are user content: they are baked into exports and never follow the
  theme.

## Testing

Vitest runs in **plain Node — there is no DOM, no canvas, no `OffscreenCanvas`**. Anything testable
must therefore be a pure function over numbers, which is why geometry, stitch planning, tile banding,
capture limits and the editor's scene model all live behind pure exports.

Rendering correctness is checked by hand against the pages in `tests/fixtures/`. When a fix depends
on visual output, add a fixture that makes the defect **self-announcing** rather than something you
have to pixel-peep — `seam-ruler` is the model: labelled offsets over a gradient, so a skipped
number is a gap and a repeated one is a bad overlap.

- Live sites are never fixtures. They are login-gated and change without notice.
- Fixtures that depend on viewport size must size themselves against the live viewport
  (`tall-fixed-header` and `narrow-scroller` do this) so they cannot silently stop reproducing.
- Say in the pull request which fixtures you captured and what you saw.

## Working style

- One coherent change per branch and per pull request; never push to `main`.
- Run `npm run verify` before opening a pull request, and report failures with their output.
- Comments, test names and markup say **why** the code is the way it is. Who asked for it, when, and
  in which conversation belongs in the pull request, not in the code.
