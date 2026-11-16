// Git Panel's Orca worker (`main` of orca-plugin.json; hosts/orca/README.md). Orca runs it out of process with Node and
// calls `activate(orca)` once per start; an idle worker is stopped (`deactivate`) and started again on the next
// panel request. It owns one engine (core/) and answers the panels' requests:
//   hello · send · poll · part · put · bye · relay   the transport (hosts/orca/bridge.mjs, ui/host/orca.js)
//   workspace · workspace.choose · workspace.raw     the focused workspace as a local folder (workspace.mjs)
//   openFile                                         a repository file in Orca's editor (editor.open)
//   note                                             a panel's diagnostics line for the plugin log (panel.js)
//   tab.open · tab.current                           a diff in Orca's center area (tab.mjs)
//   centre.beat · centre.state                       whether a diff shows there now (tab.mjs, ui/git/centre.js)
// The product is "HayBrains Git" here (product.mjs): the engine keeps its settings in ~/.config/git-panel (GIT_PANEL_HOME
// overrides it, tests pass `opts.home`) and its files in <git dir>/git-panel/; its log on disk in <home>/log/.
import fs from 'node:fs';
import { createEngine } from '../../core/engine.js';
import { createHome } from '../../core/home.js';
import { createDiskLog, logDir } from '../../core/disklog.js';
import { createBridge } from './bridge.mjs';
import { focusedWorkspace, chooseWorkspace, contextKey, openFile } from './workspace.mjs';
import { PRODUCT, orcaHome } from './product.mjs';
import { createTabs } from './tab.mjs';

let current = null;

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

/** The plugin's version: orca-plugin.json next to this file (the repository) or at the plugin root (the packed plugin). */
function pluginVersion() {
  for (const rel of ['./orca-plugin.json', '../../orca-plugin.json']) {
    try { return JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), 'utf8')).version || null; } catch (e) { /* next */ }
  }
  return null;
}

/** Starts the worker on `orca`; `opts` (tests): { home, limits, engine }. Returns { engine, bridge, stop() }. */
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
  handle('tab.open', (input) => tabs.open(input));
  handle('tab.current', (input) => tabs.current(input));
  handle('centre.beat', (input) => tabs.beat(input));
  handle('centre.state', (input) => tabs.state(input));
  // `input.context`: what the panel's own `workspace.readContext` answered (it carries the workspace id in the running app)
  handle('workspace', (input) => focusedWorkspace(orca.host, { context: 'context' in input ? input.context : undefined, choice: (name, branch) => choices.get(contextKey(name, branch)) }));
  // The owner's answer when several workspaces carry the focused name (Orca calls every project's main worktree `main`).
  handle('workspace.choose', (input) => chooseWorkspace(orca.host, choices, input));
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
    stop() {
      if (current === self) current = null;
      disposables.splice(0).forEach((d) => { try { d.dispose(); } catch (e) { /* gone */ } });
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
