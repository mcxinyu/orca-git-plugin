// What a problem report carries from the worker (hosts/orca/README.md "Report a Problem"): facts about how Orca
// describes the focused workspace to this plugin, as short lines a person can read before sending them. They explain
// why a panel shows the wrong repository or asks which one, without telling anything about the person's work:
// NO folder path, NO project, workspace, branch or terminal name, NO id value. Only kinds and counts.
//   describeFocus({ host, api, version, product, env, given, resolved, remembered, terminalsKnown })
//     -> { environment: [string], lines: [string], summary }
// `environment`: the report's Environment section (product and version, Orca and its host API, the system, git).
import os from 'node:os';

/** The kind of a workspace id, never the id: Orca's `identity:` and `folder:` ids, a raw one (it embeds a path). */
export function idKind(id) {
  if (typeof id !== 'string' || !id) return 'none';
  if (id.startsWith('identity:')) return 'identity';
  if (id.startsWith('folder:')) return 'folder';
  return id.includes('::') || id.includes('/') || id.includes('\\') ? 'raw' : 'other';
}
const count = (list, key) => {
  const n = {};
  for (const x of list) { const k = key(x); n[k] = (n[k] || 0) + 1; }
  return Object.keys(n).sort().map((k) => k + ' ' + n[k]).join(', ') || 'none';
};
const hostKind = (h) => (h === null || h === undefined || h === 'local' ? 'local' : String(h).split(':')[0] || 'other');
const terminalCount = (c) => (c && Array.isArray(c.terminals) ? c.terminals.length : 0);
const contextLine = (c) => (c === null ? 'nothing focused' : !c || typeof c !== 'object' ? 'not read' : 'id ' + idKind(c.workspaceId) + ', terminals ' + terminalCount(c));

/** How a resolution came about, in a few words (hosts/orca/workspace.mjs focusedWorkspace). */
export function resolutionText(w) {
  if (!w || typeof w !== 'object') return 'none';
  if (w.status === 'local') return 'local, ' + (w.exact ? 'by id' : w.byTerminals ? 'by terminals' : w.chosen ? 'remembered pick' : 'only one of that name');
  if (w.status === 'ambiguous') return 'ambiguous, ' + ((w.candidates && w.candidates.length) || 0) + ' local candidates of ' + (w.count || 0);
  if (w.status === 'error') return 'error ' + String(w.code || '').replace(/[^a-z_]/gi, '').slice(0, 40);
  return String(w.status).replace(/[^a-z]/gi, '').slice(0, 20);
}

/**
 * `given`: the context the panel read in its frame (undefined: none sent). `resolved`: what focusedWorkspace answered
 * for it. `remembered`: a pick is stored for this name. `terminalsKnown`: how many focused terminals are filed.
 */
export async function describeFocus(o) {
  const { host, api, version, given, resolved } = o;
  const lines = [];
  const has = (m) => (host && typeof host.has === 'function' ? (host.has(m) ? 'yes' : 'no') : 'unknown');
  // The Environment of the report, as any bug report states it: the product, the app, the system, git (`o.env`:
  // environment.mjs). The lines under it are the technical part.
  const env = o.env || {}, level = api && typeof api.major === 'number' ? api.major + '.' + api.minor : 'unknown';
  const environment = [
    (o.product || 'plugin') + ' ' + (version || 'unknown'),
    'Orca ' + (env.orca || 'unknown') + ' (host API ' + level + ')',
    (env.os || process.platform) + ' (' + (env.arch || process.arch) + ')',
    'Git ' + (env.git || 'unknown'),
  ];
  lines.push('runtime: node ' + process.versions.node + ', ' + process.platform + ' ' + os.release());
  let own, list;
  try { own = await host.call('workspace.readContext', {}); } catch (e) { own = undefined; lines.push('worker context: refused ' + String((e && e.code) || '').replace(/[^a-z_]/gi, '').slice(0, 40)); }
  try { list = await host.call('workspace.list', {}); } catch (e) { list = null; lines.push('workspace list: refused ' + String((e && e.code) || '').replace(/[^a-z_]/gi, '').slice(0, 40)); }
  lines.push('panel context: ' + ('given' in o ? contextLine(given) : 'not sent'));
  if (own !== undefined) lines.push('worker context: ' + contextLine(own));
  const p = given && typeof given === 'object' ? given : null, w = own && typeof own === 'object' ? own : null;
  if (p && w) lines.push('same focus in both: ' + (p.displayName === w.displayName && (p.branch || null) === (w.branch || null) ? 'yes' : 'no'));
  const all = list && Array.isArray(list.workspaces) ? list.workspaces.filter(Boolean) : [];
  if (list) {
    const focus = p || w;
    const named = focus && typeof focus.displayName === 'string' ? all.filter((x) => x.name === focus.displayName) : [];
    lines.push('workspaces: ' + all.length + (list.truncated ? ' (truncated)' : '') + '; ids ' + count(all, (x) => idKind(x.id)) + '; kinds ' + count(all, (x) => String(x.kind || 'unknown').replace(/[^a-z]/gi, '').slice(0, 12))
      + '; hosts ' + count(all, (x) => hostKind(x.hostId)));
    lines.push('named like the focused one: ' + named.length + (named.length ? '; ids ' + count(named, (x) => idKind(x.id)) + '; on the same branch ' + named.filter((x) => focus && x.branch === focus.branch).length : ''));
  }
  lines.push('methods: terminal.list ' + has('terminal.list') + ', editor.open ' + has('editor.open') + ', statusBar.update ' + has('statusBar.update'));
  lines.push('resolved: ' + resolutionText(resolved) + '; pick remembered ' + (o.remembered ? 'yes' : 'no') + '; focused terminals known ' + (o.terminalsKnown || 0));
  return { environment, lines, summary: 'panel ' + ('given' in o ? contextLine(given) : 'not sent') + '; worker ' + (own === undefined ? 'refused' : contextLine(own)) + '; ' + resolutionText(resolved) };
}
