# HayBrains Git for Orca

HayBrains Git is an IntelliJ IDEA-style Git tool window for [Orca](https://github.com/stablyai/orca): local changes and commit, the Log
with its graph, branches, merge, rebase (interactive too) and conflict resolution, for the repository of the focused
workspace.

This is an independent plugin. It is not affiliated with or endorsed by JetBrains or by the makers of Orca.

## Install

```sh
orca plugin install omerfarukgzr/orca-git-plugin
```

The plugin runs code, so Orca stops with `approval_required`, lists what the plugin would be granted and prints the
same command with `--approve <fingerprint>`. Read the grants, then run that command. Later versions:
`orca plugin update`.

Needs Orca 1.4.248 or newer and `git` on the `PATH`. Developed and tested on macOS.

## What you get

- **Commit** panel (right sidebar): the local changes tree with unversioned files, diff preview, commit, amend, commit
  and push, rollback. Drag a file between Unversioned Files and Changes to add it or take it out again.
- **Git** panel (right sidebar): the Log with its commit graph, filters, commit details and changed files, and the
  branches pane. Checkout, new branch, merge, rebase, interactive rebase, cherry-pick, revert, reset, reword, squash,
  fetch, pull, push. The layout follows the panel's width (one column, two, or IntelliJ's three).
- **Center tabs**: a diff, a file at a revision, File History, a comparison or the repository at a revision opens as a
  tab in Orca's center area. "+ ▸ Git" opens the whole tool window as a tab.
- **Conflicts**: the conflicts dialog and a three-pane merge tool. An unfinished merge, rebase or cherry-pick is always
  shown and can always be aborted.
- **Annotate** (blame) in the file view, and an inline blame at the end of the line you click.
- **Console**: every `git` command the plugin runs, as it ran.
- **Worktrees**: when the repository has more than one worktree (say, one per agent session), a chip in the panel's
  header lists them with their branch and how many changes each has. Pick one to see its changes, diffs and Log in the
  same panel, without checking anything out; a strip names it and takes you back.
- English by default; Turkish can be chosen in each panel's View Options.
- **Your editor font**: diffs, the file view with blame and the Console use the font family, size and line height of
  Orca's file editor (Settings, editor zoom included) and follow it when it changes (Orca 1.4.256 or newer; older
  versions keep the plugin's own font).
- **Orca's look**: the panels are set in Geist, Orca's default interface font, and file icons are the ones Orca's own
  file explorer draws. Orca does not tell plugins about a changed interface font or an installed icon theme, so the
  panels always show Orca's defaults.

## Safety net

The plugin runs real `git` commands, including destructive ones (rollback, hard reset, forced checkout, abort). Before
an operation throws content away, that content is saved under `<repository>/.git/git-panel/trash`, and the
notification offers **Restore**. The last 30 entries are kept, for at most 14 days.

An answer that says "could not be done" or "move these first" has changed nothing in the repository.

One deliberate difference from git: git silently overwrites an *ignored* file that stands in the way of a checkout or
merge. This plugin asks first, and when told to go on it moves the file's content to the trash above.

## What it asks for

- `trusted-worker`: the engine runs `git` as your user, in a Node.js process of its own.
- `workspace:read`: which workspace is focused, the list of workspaces with their folders, and their change events.
- `workspace:write`: only to open a file or a diff tab in Orca's editor area.

No network access of its own: the only traffic is what `git` does with your remotes.

## Where it keeps things

| Where | What |
|---|---|
| `<repository>/.git/git-panel/` | the trash described above, small state files, the note file behind the diff tab |
| `~/.config/git-panel/` | settings, and `log/` with one file per day (7 days, at most 20 MB a day) |

The log holds git commands with their duration and exit code, operations and page errors. It holds no file content,
no diff and no commit message text, and user names and passwords in URLs are removed.

Nothing is written into a working tree.

## Limits

- A workspace on another machine (SSH, WSL) is not supported; the panel shows the repository picker instead.
- In a linked worktree, or while the panel shows another worktree than the workspace's, diffs open inside the panel
  instead of a center tab.
- Worktrees can be listed and shown, not created, removed, locked or pruned.
- An Orca plugin cannot decorate Orca's Source editor, so the inline blame lives in the plugin's own file view (a file
  opened from the Git or Commit panel), not in the file's Source tab.
- Not included: changelists, shelve and stash UI, patches, pull requests, managing worktrees, commit checks, GPG, a submodule
  UI, committing single lines of a file.

## This repository

It holds the plugin exactly as Orca loads it, published from a development tree where the tests and build tools live.

| Path | What |
|---|---|
| `orca-plugin.json` | the plugin's manifest |
| `core/` | the engine: Node.js, runs the real `git`, no npm dependencies |
| `ui/` | the web UI. `ui/orca-bundle.js` and `ui/css/orca-bundle.css` are its plain scripts and stylesheets joined in order, not minified or changed: each part stands under a `/* ==== <file> ==== */` line (the one minified part is highlight.js, as its authors distribute it). `ui/git/boot.js` starts the UI |
| `hosts/orca/` | the worker and the panels that connect the two to Orca |

License: MIT ([LICENSE](LICENSE)). Third-party files keep their own licenses: [NOTICE.md](NOTICE.md).
