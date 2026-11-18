// Git Panel's Orca worker (`main` of orca-plugin.json; hosts/orca/README.md). Orca runs it out of process with Node and
// calls `activate(orca)` once per start; since the manifest has a status bar item, Orca starts it when the plugin is
// enabled and keeps it running (`deactivate` when it stops). It owns one engine (core/) and answers the panels' requests:
//   hello · send · poll · part · put · bye · relay   the transport (hosts/orca/bridge.mjs, ui/host/orca.js)
//   workspace · workspace.choose · workspace.raw     the focused workspace as a local folder (workspace.mjs)
//   diagnostics                                      what a problem report carries: kinds and counts (diagnostics.mjs)
//   report.picture.put · .clear · .copy              a report's screenshot, on its way to the clipboard (picture.mjs)
//   update.state · update.check · update.run         is a newer release out (kept / read now); take it (update.mjs)
//   openFile                                         a repository file in Orca's editor (editor.open)
//   note                                             a panel's diagnostics line for the plugin log (panel.js)
//   tab.open · tab.current                           a diff in Orca's center area (tab.mjs)
//   centre.beat · centre.state                       whether a diff shows there now (tab.mjs, ui/git/centre.js)
// The product is "Hay Git" here (product.mjs): the engine keeps its settings in ~/.config/git-panel (GIT_PANEL_HOME
// overrides it, tests pass `opts.home`) and its files in <git dir>/git-panel/; its log on disk in <home>/log/.
// The status bar item (statusbar.mjs) and its command `showGitPanel` (showpanel.mjs): Orca keeps a worker with status
// bar items running while the plugin is enabled; the item follows `workspace.changed` (contributes.events).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../../core/engine.js';
import { createHome } from '../../core/home.js';
import { createDiskLog, logDir } from '../../core/disklog.js';
import { createBridge } from './bridge.mjs';
import { focusedWorkspace, chooseWorkspace, contextKey, openFile, terminalIds } from './workspace.mjs';
import { describeFocus, idKind, resolutionText } from './diagnostics.mjs';
import { createPicture } from './picture.mjs';
import { createEnvironment } from './environment.mjs';
import { createActivity, runtimeLine } from './activity.mjs';
import { createJournal } from './journal.mjs';
import { PRODUCT, orcaHome } from './product.mjs';
import { createTabs } from './tab.mjs';
import { createStatusItem } from './statusbar.mjs';
import { createShowPanel, cliPath, pluginKey, COMMAND_ID } from './showpanel.mjs';
import { createUpdate, createUpdater } from './update.mjs';

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

const TERMINALS = 'orca-terminals.json';
const TERMINALS_CAP = 300;
/**
 * The folder each terminal was last seen in: <home>/orca-terminals.json, [[terminalId, path], …], oldest first. It
 * tells workspaces of one name apart when Orca names no workspace id (hosts/orca/workspace.mjs focusedWorkspace).
 * Kept in memory (this worker is its only writer) and written only when something new was learned.
 */
function terminalStore(home) {
  let seen = null;
  const all = () => {
    if (!seen) {
      const rows = home.readJson(TERMINALS, []);
      seen = new Map((Array.isArray(rows) ? rows : []).filter((e) => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string'));
    }
    return seen;
  };
  return {
    get: (id) => all().get(id) || null,
    learn(ids, folder) {
      const m = all();
      let changed = false;
      for (const id of ids) if (m.get(id) !== folder) { m.delete(id); m.set(id, folder); changed = true; }
      if (!changed) return;
      while (m.size > TERMINALS_CAP) m.delete(m.keys().next().value);
      try { home.writeJson(TERMINALS, Array.from(m)); } catch (e) { /* memory keeps it */ }
    },
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
 * spawnFn, timeoutMs }, picture: { platform, run } (a test never touches the real clipboard), update: { fetch, url,
 * everyMs, retryMs, version, cli, key, spawnFn, timeoutMs } }. Without `opts.update` the update channel is never read
 * (no test goes to the network); `activate`, the way Orca starts the worker, turns it on.
 * Returns { engine, bridge, status, showPanel, picture, update, stop() }.
 */
export function start(orca, opts = {}) {
  if (current) current.stop();
  const homeDir = orcaHome(opts.home);
  const orcaLog = (m) => { try { if (orca && typeof orca.log === 'function') orca.log(String(m)); } catch (e) { /* no log */ } };
  // The log on disk, <home>/log/YYYY-MM-DD.jsonl (docs/ARCHITECTURE.md §3.7): the engine's git commands and calls,
  // the panels' errors (diag.report) and the worker's own lines below. It goes off quietly when it cannot write.
  const diskLog = createDiskLog({ dir: logDir(homeDir), host: 'orca', onDisable: (e) => orcaLog('log on disk is off: ' + ((e && e.message) || e)) });
  // What the engine writes to the log also feeds a short memory of the last calls, git commands and errors, for a
  // problem report (activity.mjs keeps names, durations and codes only).
  const activity = createActivity();
  const startedAt = Date.now();
  const tapped = Object.assign(Object.create(diskLog), { write(entry) { activity.take(entry); return diskLog.write(entry); } });
  const engine = opts.engine || createEngine({ home: homeDir, dataDir: PRODUCT.id, label: PRODUCT.name, log: tapped });
  const log = (m) => { orcaLog(m); diskLog.write({ kind: 'host', text: String(m).slice(0, 500) }); };
  // a problem report's screenshot (picture.mjs): kept here, put on the clipboard when the tracker's page opens
  const picture = createPicture({ home: homeDir, log, ...(opts.picture || {}) });
  // and its Environment (environment.mjs): the app's and git's version, the system; read at the first report
  const environment = createEnvironment({ cli: () => cliPath(), ...(opts.environment || {}) });
  const bridge = createBridge({ engine, limits: opts.limits, log, about: { version: pluginVersion(), pictures: picture.can } });
  const disposables = [];
  const handle = (name, fn) => {
    const d = orca.panels.handle(name, (input, ctx) => fn(input || {}, ctx || {}));
    if (d && typeof d.dispose === 'function') disposables.push(d);
  };
  for (const [name, fn] of Object.entries(bridge.handlers)) handle(name, fn);
  const home = createHome(homeDir);
  const choices = choiceStore(home);
  const terminals = terminalStore(home);
  const tabs = createTabs({ host: orca.host, home, bridge, log });
  const journal = createJournal({ activity, bridge, engine, startedAt });
  // Updates (update.mjs): the channel says which release is the newest and which is the oldest that should still be
  // used; the panels ask (nothing is locked). "Update Now" asks Orca's own CLI to move the plugin. A folder loaded for
  // development is never moved.
  const uo = opts.update || { fetch: null };
  const ownKey = () => uo.key || pluginKey(pluginRoot(), pluginManifest().id || PRODUCT.id);
  const update = createUpdate({ version: uo.version || pluginVersion(), log,
    ...('fetch' in uo ? { fetch: uo.fetch } : {}), ...(uo.url ? { url: uo.url } : {}),
    ...(uo.everyMs ? { everyMs: uo.everyMs } : {}), ...(uo.retryMs ? { retryMs: uo.retryMs } : {}) });
  const updater = createUpdater({ cli: uo.cli || (() => cliPath()), key: ownKey(), log, spawnFn: uo.spawnFn, timeoutMs: uo.timeoutMs });
  handle('update.state', () => update.read());
  // "Check for Updates…" (the Options menu): the channel read now, not the answer kept from the last read
  handle('update.check', () => update.check());
  // "Update Now": Orca's own `plugin update` (update.mjs updateArgs); a channel read now that says this is the newest
  // runs nothing
  handle('update.run', async () => {
    const v = await update.check();
    if (v.state === 'current') return { result: 'current' };
    return updater.run();
  });
  update.start();

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
    return focusedWorkspace(orca.host, { context: ctx === undefined ? null : ctx, choice, terminals });
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
  let focusLine = '';
  handle('workspace', async (input) => {
    if ('context' in input) panelReported(input.context);
    const given = 'context' in input ? input.context : undefined;
    const w = await focusedWorkspace(orca.host, { context: given, choice, terminals });
    // One line in the log whenever the way the focus is found changes (kinds only, diagnostics.mjs): a report that
    // comes without the dialog's text can still be explained from the log.
    const line = 'focus: panel id ' + (given === undefined ? 'not sent' : idKind(given && given.workspaceId)) + '; ' + resolutionText(w);
    if (line !== focusLine) { focusLine = line; log(line); activity.note('focus', line.slice(7)); }
    return w;
  });
  // What a problem report carries from the worker (ui/git/report.js through hosts/orca/panel.js): kinds and counts of
  // what Orca says about the focus, never a path, a name or an id. `input.context`: the panel's own reading.
  // A report's screenshot (picture.mjs): the dialog hands it over in pieces, takes it back, or asks for it to be put on
  // the clipboard as the tracker's page opens.
  handle('report.picture.put', (input) => picture.put(input));
  handle('report.picture.clear', () => picture.clear());
  handle('report.picture.copy', () => picture.copy());
  handle('diagnostics', async (input) => {
    const given = 'context' in input ? input.context : undefined;
    const resolved = await focusedWorkspace(orca.host, { context: given, choice, terminals });
    const named = given && typeof given === 'object' && typeof given.displayName === 'string' ? given : null;
    const facts = await describeFocus({ host: orca.host, api: orca.api, version: pluginVersion(), product: PRODUCT.name, env: await environment.read(), resolved,
      remembered: !!(named && choice(named.displayName, typeof named.branch === 'string' ? named.branch : null)),
      terminalsKnown: named ? terminalIds(named).filter((id) => terminals.get(id)).length : 0,
      ...('context' in input ? { given } : {}) });
    // then the worker's own state and what it did lately (activity.mjs): errors and timings the person may not have seen
    let more = [];
    try { more = [runtimeLine({ startedAt, clients: bridge.clients(), engine })].concat(activity.lines()); } catch (e) { more = []; }
    const u = update.view();
    more.push('update: ' + u.state + ', catalog ' + u.checked + ', channel ' + u.channel);
    // and the detailed log (journal.mjs): the worker over time, the engine, the panels, tables and the timeline
    let detail = { head: [], tail: [] };
    try { detail = journal.detail(); } catch (e) { detail = { head: ['[worker] not readable'], tail: [] }; }
    return { environment: facts.environment, lines: facts.lines.concat(more), detail };
  });
  // The owner's answer when several workspaces carry the focused name (Orca calls every project's main worktree `main`).
  handle('workspace.choose', async (input) => {
    const out = await chooseWorkspace(orca.host, choices, input, terminals);
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
    picture,
    update,
    stop() {
      if (current === self) current = null;
      if (self.stopped) return;
      self.stopped = true;
      picture.clear();
      journal.stop();
      update.stop();
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
  start(orca, { update: {} });      // the real worker reads the update channel (update.mjs); a test's `start` does not
}

export function deactivate() {
  if (current) current.stop();
}

/** The running worker (tests). */
export const running = () => current;
