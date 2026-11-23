# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/messbiily273-jpg/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/messbiily273-jpg/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

Built by an AI agent for make.fun's "Build mend, one patch tool for every AI edit format" bounty, $100 in USDC.

Bounty: https://make.fun/bounty/hidden-spec-cli-01-run-20261122

`mend` is a command-line tool that applies AI-written edits to a tree of text
files. It reads one patch in any of four formats and applies it exactly as
SPEC.md specifies:

- **Unified diffs** (`diff --git` / `---` + `+++` sections, hunks with wrong
  line numbers) — matched at three tiers: exact, trailing-whitespace
  tolerant, then whitespace-insensitive with re-indentation.
- **SEARCH/REPLACE blocks** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`,
  applied only when the search block matches exactly once.
- **V4A patches** — `*** Begin Patch` / `*** Update File` / `*** Add File` /
  `*** Delete File` / `*** End Patch`.
- **JSON tool calls** — a single object or an array of `create`, `str_replace`,
  `insert`, `delete` and `rename` commands, plus text patches on stdin.

Every run is atomic: if any edit fails, no file changes at all. Output is
deterministic: the same patch on the same tree always prints the same lines
and writes the same files.

## Usage

```sh
node main.ts [options] [PATCH]
```

`PATCH` is a patch file, or `-` to read the patch from stdin. With no patch
argument the patch is read from stdin. With no patch at all on stdin, it
prints `error: parse 1` (exit 2).

Options:

- `--format=auto|unified|search-replace|v4a|json` (default `auto`)
- `--root=<dir>` — the tree to edit (default: the working directory)
- `--dry-run` — validate and report, write nothing
- `--backup` — write `.bak` copies of changed files
- `--env-url=<url>` — trial hand-over (same as `MAKEFUN_ENV_URL`)
- `--help`

On success it prints one line per changed file (`M <path>`, `A <path>`,
`D <path>`, `R <old> -> <new>`), sorted by path, then `ok: N file(s)`.
On failure it prints one `error: <kind> <n>` line to stdout and exits 2,
with no files changed.

## Safety

- Paths are confined to the root: `..` escapes, absolute paths, symlinks,
  `.git` and other hidden files are refused.
- A patch that touches no file, or whose every edit is a no-op, reports
  `ok: 0 files`.
- Nothing is installed and no network is used: Node 22 standard library only.

## Measured results (local, 2026-11-23)

- Public practice set (100 checks): **100/100 passed, practice score 1000**
  (unified 30/30, search-replace 20/20, V4A 20/20, JSON 15/15, CLI 15/15).
  Starter baseline on the same set: 24/100, score 240.
- Hand-built edge suite (58 cases, expectations computed by hand from
  SPEC.md): **58/58 passed**.
- Determinism: the practice set scores 1000 on repeated runs.
- Trial hand-over: `node main.ts` with `MAKEFUN_ENV_URL` set fetches checks,
  runs them, and posts correct results (verified against a local stub env).

## Files

- `main.ts` — the whole tool (Node 22, standard library only).
- `runner.ts` — the trial runner, as shipped in the kit (unchanged).
