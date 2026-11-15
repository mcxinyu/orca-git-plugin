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
  // The running app (1.4.255, API 1.6) puts the workspace's id into the context a PANEL reads; then nothing has to be
  // matched by name. (The context a worker reads on its own had no id there; older Orca has none at all.)
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
    return { displayName: given.displayName, branch: typeof given.branch === 'string' ? given.branch : null,
      workspaceId: typeof given.workspaceId === 'string' ? given.workspaceId : null, terminals: [] };
  }
  return host.call('workspace.readContext', {});
}

/**
 * The focused workspace as resolveWorkspace() describes it; Orca refusals become { status: 'error', code }.
 * `opts.choice(name, branch)` answers the folder remembered for an ambiguous name, if any.
 */
export async function focusedWorkspace(host, opts = {}) {
  try {
    const context = await contextOf(host, opts.context);
    if (!context) return { status: 'none' };
    const list = await host.call('workspace.list', {});
    const prefer = opts.choice && typeof context.displayName === 'string' ? opts.choice(context.displayName, context.branch) : null;
    return resolveWorkspace(context, list, { prefer });
  } catch (e) {
    return { status: 'error', code: (e && e.code) || 'action_failed', message: String((e && e.message) || e) };
  }
}

/**
 * Remembers `path` as the owner's answer for the ambiguous name that is focused right now. Only a folder Orca lists
 * for that name counts. `store`: { get(key), set(key, path) }. Returns the new resolution.
 */
export async function chooseWorkspace(host, store, input) {
  const want = input && typeof input.path === 'string' ? input.path : '';
  try {
    const context = await contextOf(host, input && input.context);
    if (!context) return { status: 'none' };
    const list = await host.call('workspace.list', {});
    const open = resolveWorkspace(context, list, {});
    const candidates = open.candidates || [];
    if (!candidates.some((c) => c.path === want)) return { status: 'error', code: 'invalid_params', message: 'not a folder of the focused workspace' };
    store.set(contextKey(context.displayName, context.branch), want);
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
