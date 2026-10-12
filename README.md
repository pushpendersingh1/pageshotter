# PageShotter

Full-page, visible-area and selection screenshots for Chrome, captured and edited entirely on your
own computer. Export PNG, JPEG, WebP, or a PDF with searchable text and clickable links.

[Install from the Chrome Web Store](https://chromewebstore.google.com/detail/ndinpmhlpgieahdpmkibnngijihalclf) ·
[Website](https://www.pageshotter.com) · [Privacy policy](https://www.pageshotter.com/privacy/)

## What it does

- **Full page.** Scrolls to the bottom and stitches every screenful into one image. Sticky headers
  appear once, where they belong, instead of being stamped into every section. Lazy-loaded images,
  infinite feeds and pages that scroll inside a container are handled generically, never with
  per-site rules.
- **Visible area.** One frame of exactly what is on screen; the page is not touched.
- **Selection.** Drag a region, or hold Ctrl to pick a whole element.
- **Editor.** Rectangles, ellipses, arrows, lines, text, highlights, numbered badges, a magnifier,
  emoji and blur, with layers, groups, crop and undo. The original capture is never overwritten.
- **Present.** Wrap a capture in a mock browser window with a background, margin, corners, shadow
  and date stamp.
- **History.** Reopen and re-export earlier captures, and search them by the words on the page.

## Privacy

PageShotter makes no network requests. There is no server, account, analytics or remote code, and
its only required permissions are `activeTab` and `scripting`. `downloads` is optional and requested
only if you choose to save into a folder. Everything it keeps is in the extension's own browser
storage; [`public/welcome.html`](public/welcome.html) lists exactly what is stored and for how long.

## Build and load it yourself

Requires Node.js 22+ and Chrome 120+.

```bash
npm ci
npm run verify     # lint + typecheck + tests + build
npm run dev        # rebuild dist/ on every change
npm run package    # build + zip for the store
```

Then open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked** and select
`dist/`. Chrome must keep the source tab active during a full-page capture, because
`tabs.captureVisibleTab()` only captures the active tab.

`npm run fixtures` serves the difficult-page test corpus at `http://localhost:4173`: sticky headers,
lazy images, nested scrollers, infinite feeds and more. Automated tests cover geometry and planning
only, so a change to captured output is checked by capturing those pages by hand.

## Architecture

```
src/
  background/   capture orchestration, cancellation, rate limiting, recovery
  content/      page analysis, scrolling, reversible page mutations, lazy-content settling
  result/       stitching, preview, export (PNG/JPEG/WebP and a hand-written PDF writer)
  editor/       the annotation editor: a pure scene model and two renderers
  popup/        the toolbar popup
  history/      saved captures
  settings/     preferences
  welcome/      the first-run page
  shared/       messages, geometry, limits, IndexedDB, errors
public/         extension pages, styles, icons and the manifest
tests/          Vitest unit tests (plain Node, no DOM) and the fixture corpus
```

[`AGENTS.md`](AGENTS.md) holds the engineering conventions and the invariants every change must keep.

## Contributing

Bug reports and feature ideas are welcome as [issues](../../issues). For a pull request, keep it to
one change, run `npm run verify`, and read [`AGENTS.md`](AGENTS.md) first: a change that adds a
permission, sends anything off the device or special-cases a website will not be merged. If a change
affects what a capture looks like, say which fixtures you checked by hand.

To report a security problem, see [`SECURITY.md`](SECURITY.md); please do not open a public issue.

## License

The code is [MIT](LICENSE). The PageShotter name and logo are not covered by that license; see
[`TRADEMARKS.md`](TRADEMARKS.md). Bundled third-party components and their licenses are listed in
[`public/THIRD_PARTY_NOTICES.txt`](public/THIRD_PARTY_NOTICES.txt).
