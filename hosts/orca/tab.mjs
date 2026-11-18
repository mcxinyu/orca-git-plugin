// The center tab (hosts/orca/README.md "A center tab for everything a panel opens"). What a panel opens (an opener of
// ui/git/openers.js: { name, args } with plain JSON arguments) is shown in Orca's editor area through a custom editor
// (orca-plugin.json `customEditors`, entry hosts/orca/panels/editor.html): Orca opens a file of the workspace in our
// editor frame (`editor.open`, a path relative to the workspace), which runs the same opener. The file is one constant
// marker per repository, `.git/git-panel/Diff.gitpanel` ({"view":"diff"}): written once when missing, never rewritten,
// never deleted (Orca tells a plugin nothing when a tab closes, so a file per opening would pile up). What the tab
// shows lives here, per repository root: the current opener, in memory and in <home>/orca-tabs.json (a worker or Orca
// restart keeps it). Only for a repository whose root IS the workspace folder; a repository below the workspace gets
// no note and no tab, and the panel opens it itself.
// A linked worktree (`.git` is a file) has no `.git` folder to hold the note, and Orca opens only a file inside the
// workspace that exists (`..` is refused; a missing file is "ENOENT", measured 18 Nov 2026). There the note is
// `.git-panel/Diff.gitpanel` in the worktree folder, hidden from git by a line `/.git-panel/` in the repository's own
// `info/exclude` (local to the machine, never committed, shared by all its worktrees), written before the note so the
// note never shows as untracked (the owner, 18 Nov 2026: "yap", after a commit's diff opened in the side panel of a
// worktree workspace). A panel of a workspace that shows another worktree
// of the repository (ui/git/worktrees.js) still gets the tab: `opener.worktree` names that worktree, `root` stays the
// workspace folder, and the tab's frame shows the worktree before it runs the opener (hosts/orca/editor.js).
//   tab.open    { workspaceId, root, opener: { name, args, worktree? } } -> { taken: true } | { taken: false, reason }
//   tab.current { root } -> { opener | null }
// Centre presence (ui/git/centre.js): Orca says nothing when the tab is closed or hidden, so the tab's frame reports
// itself while it renders, and a report older than PRESENCE_TTL counts as gone.
//   centre.beat  { root, diff, visible } -> { ok }        the frame: shows a diff / is laid out (every second, and on change)
//   centre.state { root } -> { shown }                    a panel: whether a diff shows in the centre for that repository
import fs from 'node:fs';
import path from 'node:path';
import { PRODUCT } from './product.mjs';
import { isLocalHost } from './workspace.mjs';

export const NOTE_REL = '.git/' + PRODUCT.id + '/Diff' + PRODUCT.noteExt;
/** The note of a linked worktree, and the line of `info/exclude` that hides its folder. */
export const WT_NOTE_REL = '.' + PRODUCT.id + '/Diff' + PRODUCT.noteExt;
export const WT_EXCLUDE = '/.' + PRODUCT.id + '/';
export const NOTE_TEXT = '{"view":"diff"}\n';
const STORE = 'orca-tabs.json';
const CAP = 50;
const MAX_FILES = 5000;
export const PRESENCE_TTL = 2500;   // ui/git/centre.js TTL: the frame reports every second

const str = (v, max = 4096) => typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0');
/** The openers of ui/git/openers.js a panel may hand over (every one builds its view from plain descriptors). */
export const OPENERS = Object.freeze(['diff', 'file', 'texts', 'history', 'compare', 'branchDiff', 'repoAt', 'versions']);
const MAX_ARGS = 48 * 1024;   // bytes of the arguments' JSON (a panel request is refused over 64 KiB anyway)
const MAX_DEPTH = 8;
/** Plain JSON data only (objects, arrays, strings, finite numbers, booleans, null), not too deep, no NUL in strings. */
function plain(v, depth) {
  if (v === null || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') return !v.includes('\0');
  if (depth >= MAX_DEPTH || typeof v !== 'object') return false;
  if (Array.isArray(v)) return v.every((x) => plain(x, depth + 1));
  if (Object.getPrototypeOf(v) !== Object.prototype) return false;
  return Object.keys(v).every((k) => k !== '__proto__' && plain(v[k], depth + 1));
}
/** `{ name, args }` the tab can run, from what a panel sent: a known opener and plain, small arguments; else null.
    `diff` and `file` are checked field by field (cleanSpec); an older stored `spec` is read as one of those. */
export function cleanOpener(o) {
  if (o && typeof o === 'object' && typeof o.kind === 'string') {           // orca-tabs.json of the first version
    const s = cleanSpec(o);
    if (!s) return null;
    const { kind, ...rest } = s;
    return kind === 'file' ? { name: 'file', args: rest } : { name: 'diff', args: s };
  }
  if (!o || typeof o !== 'object' || OPENERS.indexOf(o.name) < 0) return null;
  const args = o.args === undefined ? {} : o.args;
  let json;
  try { json = JSON.stringify(args); } catch (e) { return null; }
  if (!json || Buffer.byteLength(json) > MAX_ARGS || !plain(args, 0) || typeof args !== 'object' || Array.isArray(args)) return null;
  if (o.name === 'diff') { const s = cleanSpec(args); return s && s.kind !== 'file' ? { name: 'diff', args: s } : null; }
  if (o.name === 'file') { const s = cleanSpec(Object.assign({}, args, { kind: 'file' })); if (!s) return null; const { kind, ...rest } = s; return { name: 'file', args: rest }; }
  return { name: o.name, args: JSON.parse(json) };
}
/** A spec the tab can show, from what a panel sent: only plain fields of the kinds the tab knows, else null. */
export function cleanSpec(s) {
  if (!s || typeof s !== 'object' || !str(s.path)) return null;
  const files = Array.isArray(s.files) ? s.files.filter((f) => str(f)).slice(0, MAX_FILES) : null;
  if (s.kind === 'commit') {
    if (!str(s.commit, 64) || !/^[0-9a-f]{4,64}$/i.test(s.commit)) return null;
    const out = { kind: 'commit', commit: s.commit, path: s.path, files };
    if (str(s.parent, 64) && /^[0-9a-f]{4,64}$/i.test(s.parent)) out.parent = s.parent;
    return out;
  }
  if (s.kind === 'local') { const out = { kind: 'local', path: s.path, files }; if (str(s.tabId, 200)) out.tabId = s.tabId; return out; }
  if (s.kind === 'file') {
    const out = { kind: 'file', path: s.path };
    if (str(s.rev, 256)) out.rev = s.rev;
    if (Number.isInteger(s.line) && s.line >= 0) out.line = s.line;
    return out;
  }
  return null;
}

const real = (p) => { try { return fs.realpathSync(p); } catch (e) { return null; } };
/**
 * Where the note goes for workspace folder `ws` and repository `root`: { dir, rel, exclude } (`rel`: the path Orca
 * opens, relative to the workspace; `exclude`: the `info/exclude` file to hide it in, for a linked worktree), or null
 * when it must not be written.
 */
export function noteDir(ws, root) {
  const a = real(ws), b = real(root);
  if (!a || !b || a !== b) return null;                               // the repository root is the workspace folder
  let st;
  try { st = fs.lstatSync(path.join(a, '.git')); } catch (e) { return null; }
  if (st.isDirectory()) return { dir: path.join(a, '.git', PRODUCT.id), rel: NOTE_REL, exclude: null };
  if (!st.isFile()) return null;
  // a linked worktree: `.git` says `gitdir: <common>/worktrees/<name>`, whose `commondir` names the common folder
  const common = commonDir(a);
  if (!common) return null;
  return { dir: path.join(a, path.dirname(WT_NOTE_REL)), rel: WT_NOTE_REL, exclude: path.join(common, 'info', 'exclude') };
}
/** The common git folder of the linked worktree at `wt` (from the files git keeps, no git process), or null. */
export function commonDir(wt) {
  try {
    const m = /^gitdir: (.+)$/m.exec(fs.readFileSync(path.join(wt, '.git'), 'utf8'));
    if (!m) return null;
    const gitdir = path.resolve(wt, m[1].trim());
    let common = path.dirname(path.dirname(gitdir));                  // <common>/worktrees/<name>
    try { common = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim()); } catch (e) { /* the layout above */ }
    const r = real(common);
    return r && fs.lstatSync(path.join(r, 'HEAD')).isFile() && path.basename(path.dirname(gitdir)) === 'worktrees' ? r : null;
  } catch (e) { return null; }
}
/**
 * `wt` as a real path when it is a linked worktree of the repository at `root`: its `.git` file names a folder right
 * under root's `.git/worktrees`. Read from the files git keeps, no git process; anything else is null.
 */
export function linkedWorktree(root, wt) {
  if (!str(wt) || !path.isAbsolute(wt)) return null;
  const a = real(root), b = real(wt);
  if (!a || !b || a === b) return null;
  let text;
  try {
    const file = path.join(b, '.git');
    if (!fs.lstatSync(file).isFile()) return null;
    text = fs.readFileSync(file, 'utf8');
  } catch (e) { return null; }
  const m = /^gitdir: (.+)$/m.exec(text);
  if (!m) return null;
  const gitdir = real(path.resolve(b, m[1].trim())), store = real(path.join(a, '.git', 'worktrees'));
  return gitdir && store && path.dirname(gitdir) === store ? b : null;
}
/**
 * Writes the marker when it is missing; an existing file is never touched. `note`: noteDir's answer (or a folder, as
 * before). For a linked worktree the exclude line comes first: it is appended once to `info/exclude` (what is there
 * stays), so the note is never seen by git.
 */
export function ensureNote(note) {
  const n = typeof note === 'string' ? { dir: note, rel: NOTE_REL, exclude: null } : note;
  if (n.exclude) {
    let text = '';
    try { text = fs.readFileSync(n.exclude, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!text.split(/\r?\n/).some((l) => l.trim() === WT_EXCLUDE)) {
      fs.mkdirSync(path.dirname(n.exclude), { recursive: true });
      fs.appendFileSync(n.exclude, (text && !text.endsWith('\n') ? '\n' : '') + '# ' + PRODUCT.name + ': the marker its editor tab opens\n' + WT_EXCLUDE + '\n');
    }
  }
  fs.mkdirSync(n.dir, { recursive: true });
  try { fs.writeFileSync(path.join(n.dir, path.basename(n.rel)), NOTE_TEXT, { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
}

/** `host`: orca.host; `home`: core/home.js store; `bridge`: hosts/orca/bridge.mjs; `now`: the clock (tests). */
export function createTabs({ host, home, bridge, log = () => {}, now = Date.now }) {
  const mem = new Map();   // real root -> { name, args }
  const stored = () => { const all = home.readJson(STORE, []); return Array.isArray(all) ? all.filter((e) => Array.isArray(e) && typeof e[0] === 'string') : []; };
  function remember(root, opener) {
    mem.set(root, opener);
    try { home.writeJson(STORE, [[root, opener, Date.now()]].concat(stored().filter((e) => e[0] !== root)).slice(0, CAP)); } catch (e) { log('tab: cannot store the opener: ' + e.message); }
  }
  function current(input) {
    const root = real(input && input.root);
    if (!root) return { opener: null };
    if (mem.has(root)) return { opener: mem.get(root) };
    const hit = stored().find((e) => e[0] === root);
    let opener = hit ? cleanOpener(hit[1]) : null;
    if (opener && hit[1] && hit[1].worktree != null) {
      const wt = linkedWorktree(root, hit[1].worktree);
      if (wt) opener.worktree = wt; else opener = null;                 // that worktree is gone: nothing to show
    }
    if (opener) mem.set(root, opener);
    return { opener };
  }
  async function open(input) {
    const no = (reason) => ({ taken: false, reason });
    const { workspaceId } = input || {};
    const spec = cleanOpener(input && input.opener);
    if (!spec) return no('opener');
    if (typeof workspaceId !== 'string' || !workspaceId) return no('workspace');
    let ws;
    try {
      const list = await host.call('workspace.list', {});
      ws = (list && list.workspaces || []).find((w) => w && w.id === workspaceId);
    } catch (e) { return no('workspace'); }
    if (!ws || !isLocalHost(ws) || typeof ws.path !== 'string' || !path.isAbsolute(ws.path)) return no('workspace');
    const note = noteDir(ws.path, input.root);
    if (!note) return no('folder');
    const root = real(input.root);
    // A panel that shows another worktree of the repository (ui/git/worktrees.js) names it: the tab is still the
    // workspace folder's, and shows that worktree. Only a linked worktree of this very repository counts.
    if (input.opener.worktree != null) {
      const wt = linkedWorktree(root, input.opener.worktree);
      if (!wt) return no('worktree');
      spec.worktree = wt;
    }
    try { ensureNote(note); } catch (e) { log('tab: cannot write the note (' + ((e && e.code) || e) + ')'); return no('note'); }
    remember(root, spec);
    bridge.broadcast('tab', 'tab', { root, opener: spec });  // a tab that is open shows it at once
    try {
      await host.call('editor.open', { workspaceId, path: note.rel });
    } catch (e) {
      log('tab: editor.open refused (' + ((e && e.code) || e) + ')');
      return no('editor');
    }
    return { taken: true };
  }
  // ---------------------------------------------------------------- centre presence
  const presence = new Map();   // root as reported -> { diff, visible, at }
  const seen = new Map();       // root as asked -> real root (realpath once per path)
  const realOf = (p) => { if (!str(p)) return null; if (!seen.has(p)) { if (seen.size > 200) seen.clear(); seen.set(p, real(p)); } return seen.get(p); };
  function beat(input) {
    const root = realOf(input && input.root);
    if (!root) return { ok: false };
    presence.set(root, { diff: input.diff === true, visible: input.visible === true, at: now() });
    return { ok: true };
  }
  function state(input) {
    const root = realOf(input && input.root);
    const p = root ? presence.get(root) : null;
    return { shown: !!(p && p.diff && p.visible && now() - p.at < PRESENCE_TTL) };
  }
  return { open, current, beat, state };
}
