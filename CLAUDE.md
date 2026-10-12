# PageShotter

Read `AGENTS.md` first: it holds every convention for this repository (commands, architecture,
invariants, design and testing rules).

The extension cannot be loaded by automated tests. They cover geometry and planning math only, so a
change that affects captured output is not done until someone has captured the relevant pages in
`tests/fixtures/` in a real Chrome with the unpacked `dist/` loaded. Say which fixtures were checked
and what they showed; never describe visual behaviour as working on the strength of tests alone.

Personal notes for a local checkout belong in `CLAUDE.local.md`, which is gitignored.
