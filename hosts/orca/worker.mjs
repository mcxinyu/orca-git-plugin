// Git Panel's Orca worker (`main` of orca-plugin.json; hosts/orca/README.md). Orca runs it out of process with Node and
// calls `activate(orca)` once per start; since the manifest has a status bar item, Orca starts it when the plugin is
// enabled and keeps it running (`deactivate` when it stops). It owns one engine (core/) and answers the panels' requests:
//   hello · send · poll · part · put · bye · relay   the transport (hosts/orca/bridge.mjs, ui/host/orca.js)
//   workspace · workspace.choose · workspace.raw     the focused workspace as a local folder (workspace.mjs)
//   openFile                                         a repository file in Orca's editor (editor.open)
//   note                                             a panel's diagnostics line for the plugin log (panel.js)
//   tab.open · tab.current                           a diff in Orca's center area (tab.mjs)
//   centre.beat · centre.state                       whether a diff shows there now (tab.mjs, ui/git/centre.js)
// The product is "HayBrains Git" here (product.mjs): the engine keeps its settings in ~/.config/git-panel (GIT_PANEL_HOME
// overrides it, tests pass `opts.home`) and its files in <git dir>/git-panel/; its log on disk in <home>/log/.
// The status bar item (statusbar.mjs) and its command `showGitPanel` (showpanel.mjs): Orca keeps a worker with status
// bar items running while the plugin is enabled; the item follows `workspace.changed` (contributes.events).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../../core/engine.js';
import { createHome } from '../../core/home.js';
import { createDiskLog, logDir } from '../../core/disklog.js';
import { createBridge } from './bridge.mjs';
import { focusedWorkspace, chooseWorkspace, contextKey, openFile } from './workspace.mjs';
import { PRODUCT, orcaHome } from './product.mjs';
import { createTabs } from './tab.mjs';
import { createStatusItem } from './statusbar.mjs';
import { createShowPanel, cliPath, pluginKey, COMMAND_ID } from './showpanel.mjs';

let current = null;
// A panel's context (it carries the workspace id) counts for the status bar until a focus change it did not see:
// an event without an id that arrives this long after the panel's report drops it.
const PANEL_CONTEXT_GRACE_MS = 2000;

const CHOICES = 'orca-workspaces.json';
const CHOICES_CAP = 200;
/** The folder the owner picked for an ambiguous workspace name: <home>/orca-workspaces.json, [[key, path], …]. */
function choiceStore(home) {
  const read = () => {
    const all = home.readJson(CHOICES, []);
    return Array.isArray(all) ? all.filter((e) => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string') : [];
  };
  return {
    get: (key) => { const hit = read().find((e) => e[0] === key); return hit ? hit[1] : null; },
    set: (key, folder) => { home.writeJson(CHOICES, [[key, folder]].concat(read().filter((e) => e[0] !== key)).slice(0, CHOICES_CAP)); },
  };
}

/** The plugin's manifest: orca-plugin.json next to this file (the repository) or at the plugin root (the packed plugin). */
function pluginManifest() {
  for (const rel of ['./orca-plugin.json', '../../orca-plugin.json']) {
    try { return JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), 'utf8')) || {}; } catch (e) { /* next */ }
  }
  return {};
}
const pluginVersion = () => pluginManifest().version || null;
/** The plugin folder Orca runs: the worker is <root>/hosts/orca/worker.mjs. */
const pluginRoot = () => fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]+$/, '');

/**
 * Starts the worker on `orca`; `opts` (tests): { home, limits, engine, status: { minIntervalMs }, show: { cli, key,
 * spawnFn, timeoutMs } }. Returns { engine, bridge, status, showPanel, stop() }.
 */
export function start(orca, opts = {}) {
  if (current) current.stop();
  const homeDir = orcaHome(opts.home);
  const orcaLog = (m) => { try { if (orca && typeof orca.log === 'function') orca.log(String(m)); } catch (e) { /* no log */ } };
  // The log on disk, <home>/log/YYYY-MM-DD.jsonl (docs/ARCHITECTURE.md §3.7): the engine's git commands and calls,
  // the panels' errors (diag.report) and the worker's own lines below. It goes off quietly when it cannot write.
  const diskLog = createDiskLog({ dir: logDir(homeDir), host: 'orca', onDisable: (e) => orcaLog('log on disk is off: ' + ((e && e.message) || e)) });
  const engine = opts.engine || createEngine({ home: homeDir, dataDir: PRODUCT.id, label: PRODUCT.name, log: diskLog });
  const log = (m) => { orcaLog(m); diskLog.write({ kind: 'host', text: String(m).slice(0, 500) }); };
  const bridge = createBridge({ engine, limits: opts.limits, log });
  const disposables = [];
  const handle = (name, fn) => {
    const d = orca.panels.handle(name, (input, ctx) => fn(input || {}, ctx || {}));
    if (d && typeof d.dispose === 'function') disposables.push(d);
  };
  for (const [name, fn] of Object.entries(bridge.handlers)) handle(name, fn);
  const home = createHome(homeDir);
  const choices = choiceStore(home);
  const tabs = createTabs({ host: orca.host, home, bridge, log });

  // ---- the status bar item and its command (statusbar.mjs, showpanel.mjs; README "Status bar")
  // Which folder: focusedWorkspace exactly as the panels resolve it. The context is the last `workspace.changed`
  // payload (Orca names the workspace id in it), else the worker's own `workspace.readContext` (no id: an ambiguous
  // name stays hidden until a panel reported its context, which carries the id, or the owner picked a folder).
  const choice = (name, branch) => choices.get(contextKey(name, branch));
  let eventContext;            // undefined: no event yet
  let panelContext = null;     // { context, at }: a panel's context with a workspace id
  const sameFocus = (a, b) => !!a && !!b && a.displayName === b.displayName && (a.branch || null) === (b.branch || null);
  function panelReported(context) {
    if (!context || typeof context !== 'object' || typeof context.workspaceId !== 'string' || !context.workspaceId || typeof context.displayName !== 'string') return;
    const prev = panelContext && panelContext.context;
    panelContext = { context: { displayName: context.displayName, branch: typeof context.branch === 'string' ? context.branch : null, workspaceId: context.workspaceId }, at: Date.now() };
    if (status && (!prev || prev.workspaceId !== context.workspaceId)) status.refocus();
  }
  async function statusFocus() {
    let ctx = eventContext;
    if (ctx === undefined) ctx = await orca.host.call('workspace.readContext', {});
    if (ctx && typeof ctx.workspaceId !== 'string' && panelContext && sameFocus(ctx, panelContext.context)) ctx = panelContext.context;
    return focusedWorkspace(orca.host, { context: ctx === undefined ? null : ctx, choice });
  }
  // Feature-detected: an Orca without `statusBar.update` (or a test's fake without it) gets no item and no command.
  const hasStatusBar = !!(orca.host && typeof orca.host.has === 'function' && orca.host.has('statusBar.update'));
  let status = null, showPanel = null;
  if (hasStatusBar) {
    status = createStatusItem({ host: orca.host, engine, resolve: statusFocus, log, ...(opts.status || {}) });
    const so = opts.show || {};
    const manifestId = pluginManifest().id || PRODUCT.id;
    const key = so.key || pluginKey(pluginRoot(), manifestId);
    showPanel = createShowPanel({
      cli: so.cli || (() => cliPath()), key, log, spawnFn: so.spawnFn, timeoutMs: so.timeoutMs,
      panelShowing: () => bridge.clients().some((c) => c.view === 'log' && c.polling),
    });
    if (orca.commands && typeof orca.commands.register === 'function') {
      const d = orca.commands.register(COMMAND_ID, () => showPanel.show());
      if (d && typeof d.dispose === 'function') disposables.push(d);
    }
    if (orca.events && typeof orca.events.on === 'function') {
      // Orca waits for an event handler before it delivers the next one: answer at once, resolve in the background.
      const d = orca.events.on('workspace.changed', (payload) => {
        const context = payload && typeof payload === 'object' ? payload.context : null;
        eventContext = context && typeof context === 'object' ? context : null;
        if (panelContext && !(eventContext && typeof eventContext.workspaceId === 'string') && Date.now() - panelContext.at > PANEL_CONTEXT_GRACE_MS) panelContext = null;
        status.refocus();
      });
      if (d && typeof d.dispose === 'function') disposables.push(d);
    }
    status.refocus();
  }
  handle('tab.open', (input) => tabs.open(input));
  handle('tab.current', (input) => tabs.current(input));
  handle('centre.beat', (input) => tabs.beat(input));
  handle('centre.state', (input) => tabs.state(input));
  // `input.context`: what the panel's own `workspace.readContext` answered (it carries the workspace id in the running app)
  handle('workspace', (input) => {
    if ('context' in input) panelReported(input.context);
    return focusedWorkspace(orca.host, { context: 'context' in input ? input.context : undefined, choice });
  });
  // The owner's answer when several workspaces carry the focused name (Orca calls every project's main worktree `main`).
  handle('workspace.choose', async (input) => {
    const out = await chooseWorkspace(orca.host, choices, input);
    if (status) status.refocus();
    return out;
  });
  // Troubleshooting (`orca plugin dev request local.git-panel workspace.raw`): what Orca itself says about the focus.
  handle('workspace.raw', async () => {
    const out = {};
    try { out.context = await orca.host.call('workspace.readContext', {}); } catch (e) { out.contextError = String((e && e.code) || e); }
    try { out.list = await orca.host.call('workspace.list', {}); } catch (e) { out.listError = String((e && e.code) || e); }
    return out;
  });
  handle('openFile', (input) => openFile(orca.host, input));
  // Diagnostics from the panels (hosts/orca/panel.js): one info line per (re)opened repository, so `orca plugin logs`
  // can explain a report. The panel sends the status and the folder name only; anything else is cut down here.
  const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, max);
  handle('note', (input) => {
    const view = /^[a-z]{1,20}$/.test(String(input.view)) ? input.view : 'panel';
    log('panel ' + view + ': ' + clean(input.from, 120) + ' → ' + clean(input.to, 120));
    return { ok: true };
  });
  const self = {
    engine,
    bridge,
    status,
    showPanel,
    stop() {
      if (current === self) current = null;
      if (self.stopped) return;
      self.stopped = true;
      disposables.splice(0).forEach((d) => { try { d.dispose(); } catch (e) { /* gone */ } });
      if (status) status.close();
      bridge.close();
      engine.close();
      diskLog.write({ kind: 'stop' });
      diskLog.close();
    },
    diskLog,
  };
  current = self;
  diskLog.write({ kind: 'start', version: pluginVersion(), instance: bridge.instance, node: process.versions.node, pid: process.pid });
  orcaLog(PRODUCT.name + ' worker started (' + bridge.instance + ')');
  return self;
}

export default function activate(orca) {
  start(orca);
}

export function deactivate() {
  if (current) current.stop();
}

/** The running worker (tests). */
export const running = () => current;
