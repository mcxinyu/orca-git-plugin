// Which repository a panel shows: the focused Orca workspace, mapped to a local folder (hosts/orca/README.md).
// `workspace.readContext` names the focused workspace (displayName, branch) but carries no id or path, so it is
// matched against `workspace.list` (id, kind, name, path, branch, hostId). Only an unambiguous match counts; a
// workspace on another host is refused. Nothing here guesses a path: no match means "no repository".
import path from 'node:path';

/** This machine: the running app says `hostId: "local"` (seen in Orca 1.4.255); its typings allow null. */
export const isLocalHost = (w) => w.hostId === null || w.hostId === undefined || w.hostId === 'local';

/** What a remembered choice is filed under: the two things `workspace.readContext` tells. */
export const contextKey = (name, branch) => String(name) + '\n' + (branch == null ? '' : String(branch));

/**
 * resolveWorkspace(context, list, { prefer? }) ->
 *   { status: 'local', workspaceId, name, path, branch, chosen?, candidates? }
 *   { status: 'none' }                                  nothing is focused
 *   { status: 'remote', workspaceId, name, hostId }     the workspace lives on another host (SSH, WSL…)
 *   { status: 'unmatched', name }                       no listed workspace has that name
 *   { status: 'ambiguous', name, branch, count, candidates: [{ workspaceId, name, path, branch }] }
 * Ambiguous is the everyday case, not an oddity: Orca names the main worktree of every project `main`, and the
 * context carries no id. Then the local folders that fit are returned as `candidates`, and `prefer` (the folder the
 * owner picked for this name and branch before) decides when it is still one of them (`chosen: true`).
 */
export function resolveWorkspace(context, list, opts = {}) {
  if (!context || typeof context.displayName !== 'string') return { status: 'none' };
  const name = context.displayName;
  const all = list && Array.isArray(list.workspaces) ? list.workspaces : [];
  // A context with the workspace's id needs no matching by name. Who gets the id differs by Orca version and by
  // workspace: 1.4.255 (API 1.6) gave it to a PANEL only; from host API 1.7 a worker always gets it, and a panel only
  // for a workspace with an `identity:` or `folder:` id (contextOf below fills that gap from the worker's own reading).
  if (typeof context.workspaceId === 'string' && context.workspaceId) {
    const exact = all.find((w) => w && w.id === context.workspaceId);
    if (exact) {
      if (!isLocalHost(exact)) return { status: 'remote', workspaceId: exact.id, name, hostId: String(exact.hostId) };
      if (typeof exact.path === 'string' && path.isAbsolute(exact.path)) {
        return { status: 'local', workspaceId: exact.id, name, path: exact.path, branch: exact.branch == null ? null : exact.branch, exact: true };
      }
    }
  }
  let found = all.filter((w) => w && w.name === name);
  if (found.length > 1 && typeof context.branch === 'string') {
    const byBranch = found.filter((w) => w.branch === context.branch);
    if (byBranch.length) found = byBranch;
  }
  const local = (w) => ({ status: 'local', workspaceId: w.id, name, path: w.path, branch: w.branch == null ? null : w.branch });
  if (found.length > 1) {
    const same = found.every((w) => w.path === found[0].path && isLocalHost(w) === isLocalHost(found[0]) && (isLocalHost(w) || w.hostId === found[0].hostId));
    if (!same) {
      const seen = new Set();
      const candidates = found.filter((w) => isLocalHost(w) && typeof w.path === 'string' && path.isAbsolute(w.path) && !seen.has(w.path) && seen.add(w.path))
        .map((w) => ({ workspaceId: w.id, name, path: w.path, branch: w.branch == null ? null : w.branch }));
      const picked = typeof opts.prefer === 'string' ? found.find((w) => isLocalHost(w) && w.path === opts.prefer) : null;
      if (picked) return { ...local(picked), chosen: true, candidates };
      return { status: 'ambiguous', name, branch: typeof context.branch === 'string' ? context.branch : null, count: found.length, candidates };
    }
  }
  if (!found.length) return { status: 'unmatched', name, truncated: !!(list && list.truncated) };
  const w = found[0];
  if (!isLocalHost(w)) return { status: 'remote', workspaceId: w.id, name, hostId: String(w.hostId) };
  if (typeof w.path !== 'string' || !path.isAbsolute(w.path)) return { status: 'unmatched', name };
  return local(w);
}

/**
 * The context to resolve: the one the panel read in its frame when it carries what a context needs (it names the
 * workspace by id in the running app), else the worker's own `workspace.readContext`. `given` comes from a panel, so
 * only its plain fields are taken; the id is still looked up in Orca's own list before any folder is opened.
 */
async function contextOf(host, given) {
  if (given === null) return null;                      // the panel saw: nothing is focused
  if (given && typeof given === 'object' && typeof given.displayName === 'string') {
    const seen = { displayName: given.displayName, branch: typeof given.branch === 'string' ? given.branch : null,
      workspaceId: typeof given.workspaceId === 'string' && given.workspaceId ? given.workspaceId : null,
      terminals: terminalIds(given).map((id) => ({ id })) };
    if (seen.workspaceId) return seen;
    // Orca never tells a panel the id of a workspace that has no identity: that raw id embeds the folder's path and
    // "reaches workers only, never panels or editors" (Orca's plugin-host-api-workspace-context.ts). So the panel of
    // such a workspace reads a context without an id, and the worker's own reading of the same focus carries it
    // (reported 17 Nov 2026: six projects' `main`, the question asked at every move between them).
    try {
      const own = await host.call('workspace.readContext', {});
      const same = own && typeof own === 'object' && own.displayName === seen.displayName && (typeof own.branch === 'string' ? own.branch : null) === seen.branch;
      if (same && typeof own.workspaceId === 'string' && own.workspaceId) {
        return { ...seen, workspaceId: own.workspaceId, terminals: seen.terminals.length ? seen.terminals : terminalIds(own).map((id) => ({ id })) };
      }
    } catch (e) { /* refused: what the panel read stands */ }
    return seen;
  }
  return host.call('workspace.readContext', {});
}

const MAX_TERMINALS = 50;      // what `terminal.list` answers at most
/** The ids of the terminals a context lists (the focused workspace's own). */
export function terminalIds(context) {
  const list = context && Array.isArray(context.terminals) ? context.terminals : [];
  return list.map((x) => x && x.id).filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 200).slice(0, MAX_TERMINALS);
}

/**
 * Which of `candidates` (folders that fit the focused name) holds the focused terminals, or null. A context without a
 * workspace id still lists its terminals, and a terminal belongs to one workspace: first what was learned before
 * (`memo.get(id)` → folder), then Orca's own `terminal.list` of every candidate (host API 1.7; an Orca without it, or
 * a refusal, is no evidence). Only one candidate counts; two that fit decide nothing.
 */
export async function ownerByTerminals(host, context, candidates, memo) {
  const ids = terminalIds(context);
  if (!ids.length || !Array.isArray(candidates) || candidates.length < 2) return null;
  if (memo) {
    const folders = new Set(ids.map((id) => memo.get(id)).filter(Boolean));
    const known = candidates.filter((c) => folders.has(c.path));
    if (known.length === 1) return known[0];
    if (known.length > 1) return null;
  }
  if (!host || typeof host.call !== 'function' || (typeof host.has === 'function' && !host.has('terminal.list'))) return null;
  const want = new Set(ids), owners = [];
  for (const c of candidates) {
    try {
      const r = await host.call('terminal.list', { workspaceId: c.workspaceId });
      if (r && Array.isArray(r.terminals) && r.terminals.some((x) => x && want.has(x.id))) owners.push(c);
    } catch (e) { /* no such method in this Orca, or refused */ }
  }
  return owners.length === 1 ? owners[0] : null;
}

/**
 * The focused workspace as resolveWorkspace() describes it; Orca refusals become { status: 'error', code }.
 * `opts.choice(name, branch)` answers the folder remembered for an ambiguous name, if any.
 * `opts.terminals` ({ get(id), learn(ids, folder) }) remembers which folder a terminal was seen in.
 * When several folders fit the name and Orca named no id, the focused terminals decide (`byTerminals: true`). A
 * remembered choice is only a guess for that name: it is taken when no terminal is focused (nothing tells the folders
 * apart) and not when terminals are focused of which none is known to be in that folder. Those may be another
 * project's workspace of the same name, so the answer is `ambiguous` again: one question, and its answer files them.
 */
export async function focusedWorkspace(host, opts = {}) {
  try {
    const context = await contextOf(host, opts.context);
    if (!context) return { status: 'none' };
    const list = await host.call('workspace.list', {});
    const prefer = opts.choice && typeof context.displayName === 'string' ? opts.choice(context.displayName, context.branch) : null;
    let w = resolveWorkspace(context, list, { prefer });
    const memo = opts.terminals || null, ids = terminalIds(context);
    const several = Array.isArray(w.candidates) && w.candidates.length > 1 && (w.status === 'ambiguous' || w.chosen);
    if (several && ids.length) {
      const owner = await ownerByTerminals(host, context, w.candidates, memo);
      if (owner) {
        w = { status: 'local', workspaceId: owner.workspaceId, name: owner.name, path: owner.path, branch: owner.branch, byTerminals: true, candidates: w.candidates };
      } else if (w.chosen && memo && !ids.some((id) => memo.get(id) === w.path)) {
        w = { status: 'ambiguous', name: w.name, branch: typeof context.branch === 'string' ? context.branch : null, count: w.candidates.length, candidates: w.candidates };
      }
    }
    // what Orca itself said (an id, the only folder of that name, its terminal list) is remembered; a guess is not
    if (memo && ids.length && w.status === 'local' && !w.chosen) memo.learn(ids, w.path);
    return w;
  } catch (e) {
    return { status: 'error', code: (e && e.code) || 'action_failed', message: String((e && e.message) || e) };
  }
}

/**
 * Remembers `path` as the owner's answer for the ambiguous name that is focused right now. Only a folder Orca lists
 * for that name counts. `store`: { get(key), set(key, path) }. Returns the new resolution. The focused terminals are
 * filed under that folder too (`memo`, see focusedWorkspace): the next time they are focused nobody is asked, and
 * another project's workspace of the same name is told apart from this one.
 */
export async function chooseWorkspace(host, store, input, memo) {
  const want = input && typeof input.path === 'string' ? input.path : '';
  try {
    const context = await contextOf(host, input && input.context);
    if (!context) return { status: 'none' };
    const list = await host.call('workspace.list', {});
    const open = resolveWorkspace(context, list, {});
    const candidates = open.candidates || [];
    if (!candidates.some((c) => c.path === want)) return { status: 'error', code: 'invalid_params', message: 'not a folder of the focused workspace' };
    store.set(contextKey(context.displayName, context.branch), want);
    const ids = terminalIds(context);
    if (memo && ids.length) memo.learn(ids, want);
    return resolveWorkspace(context, list, { prefer: want });
  } catch (e) {
    return { status: 'error', code: (e && e.code) || 'action_failed', message: String((e && e.message) || e) };
  }
}

/** A repository-relative path (as the UI has it) inside `root`, refusing anything that leaves it. */
export function filePath(root, rel) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || typeof rel !== 'string' || !rel || rel.includes('\0')) return null;
  if (path.isAbsolute(rel) || rel.split('/').some((s) => s === '..')) return null;
  const abs = path.join(root, rel);
  const inside = path.relative(root, abs);
  return inside && !inside.startsWith('..') && !path.isAbsolute(inside) ? abs : null;
}

/**
 * Opens a file of the repository in Orca's editor (`editor.open`, capability workspace:write, desktop app only).
 * The workspace is looked up again by id: it must be local and hold the file. Returns { opened } or { error }.
 */
export async function openFile(host, input) {
  const { workspaceId, root, path: rel } = input || {};
  if (typeof workspaceId !== 'string' || !workspaceId) return { error: { code: 'invalid_params', message: 'no workspace' } };
  const abs = filePath(root, rel);
  if (!abs) return { error: { code: 'invalid_params', message: 'path outside the repository' } };
  let ws;
  try {
    const list = await host.call('workspace.list', {});
    ws = (list && list.workspaces || []).find((w) => w && w.id === workspaceId);
  } catch (e) {
    return { error: { code: (e && e.code) || 'action_failed', message: String((e && e.message) || e) } };
  }
  if (!ws) return { error: { code: 'not_found', message: 'workspace not found' } };
  if (!isLocalHost(ws)) return { error: { code: 'refused', message: 'remote workspace' } };
  const inWs = path.relative(ws.path, abs);
  if (!inWs || inWs.startsWith('..') || path.isAbsolute(inWs)) return { error: { code: 'refused', message: 'the file is not inside the workspace' } };
  try {
    // Measured in Orca 1.4.255: the path must be relative to the workspace (an absolute one is `invalid_params`).
    await host.call('editor.open', { workspaceId, path: inWs.split(path.sep).join('/') });
    return { opened: true };
  } catch (e) {
    return { error: { code: (e && e.code) || 'action_failed', message: String((e && e.message) || e) } };
  }
}
