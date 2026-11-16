// "Show the Git panel" (`contributes.commands` `showGitPanel`, run by the status bar item and the command palette).
// Orca has no host call that shows a plugin's own panel; its CLI does: `orca plugin open <plugin-key> --panel <id>`
// "shows a panel to you in the right sidebar" and never brings the window forward (Orca's plugin-authoring.md). So the
// worker runs Orca's own CLI, the one bundled with the app it runs in, with an argument array (no shell), a short
// timeout, never awaited by the command. hosts/orca/README.md "Status bar" says what is and is not verified.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const COMMAND_ID = 'showGitPanel';
export const PANEL_ID = 'log';
export const CLI_TIMEOUT_MS = 8000;

/**
 * Orca's bundled CLI next to the app this worker runs in, or null. Orca's `getBundledLauncherPath` (src/main/cli/
 * packaged-assets/bundled-cli-launcher-path.ts): `<resources>/bin/orca` on macOS, `orca-ide` on Linux, `orca.exe` on
 * Windows. The worker is forked from the app (on macOS as `<App>.app/Contents/Frameworks/Orca Helper.app/…`), so the
 * resources folder is `process.resourcesPath` when Electron sets it, else found from `process.execPath`.
 */
export function cliPath(o = {}) {
  const platform = o.platform || process.platform;
  const execPath = o.execPath || process.execPath;
  const resourcesPath = 'resourcesPath' in o ? o.resourcesPath : process.resourcesPath;
  const exists = o.exists || ((p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } });
  const P = platform === 'win32' ? path.win32 : path.posix;
  const name = { darwin: 'orca', linux: 'orca-ide', win32: 'orca.exe' }[platform];
  if (!name || typeof execPath !== 'string') return null;
  const tries = [];
  if (typeof resourcesPath === 'string' && resourcesPath) tries.push(P.join(resourcesPath, 'bin', name));
  if (platform === 'darwin') {
    const i = execPath.indexOf('.app/Contents/');          // the outermost bundle: Orca.app, not Orca Helper.app
    if (i > 0) tries.push(P.join(execPath.slice(0, i + 4), 'Contents', 'Resources', 'bin', name));
  } else tries.push(P.join(P.dirname(execPath), 'resources', 'bin', name));
  return tries.find((p) => exists(p)) || null;
}

/**
 * The plugin's key as Orca names it (`<publisher>.<id>`). The worker's API does not carry it (Orca's init message has
 * `pluginId`, but `activate(orca)` gets no field with it), so it is read from where Orca keeps the plugin
 * (src/main/plugins/discovery/plugin-discovery.ts): an installed plugin runs from `<userData>/plugins/<key>/<content
 * hash>/` and Orca refuses one whose folder name is not its key; a development folder is `local.<id>`.
 */
export function pluginKey(root, id) {
  const parent = path.basename(path.dirname(root));
  const grand = path.basename(path.dirname(path.dirname(root)));
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (grand === 'plugins' && new RegExp('^[A-Za-z0-9][A-Za-z0-9_-]*\\.' + esc + '$').test(parent)) return parent;
  return 'local.' + id;
}

/**
 * The command's handler. `cli()` answers the CLI's path (or null), `key` the plugin key, `panelShowing()` whether a
 * Git panel of this plugin is connected right now. It returns at once; the CLI runs on its own.
 * Fallback when the CLI is missing, fails or hangs (killed after `timeoutMs`): one log line, nothing else. Orca's
 * other way, `commands.run` `sidebar.right.toggle`, would CLOSE the sidebar when it is open, and a worker cannot tell
 * open from closed (no host call reads it; a sidebar showing another tab and a closed one look the same), so it is
 * not used.
 */
export function createShowPanel({ cli, key, log = () => {}, panelShowing = () => false, spawnFn = spawn, timeoutMs = CLI_TIMEOUT_MS }) {
  let running = null;
  const fallback = (why) => {
    if (panelShowing()) log('show Git panel: ' + why + '; the Git panel is connected already');
    else log('show Git panel: ' + why + '; open it from the right sidebar');
  };
  function show() {
    if (running) return { started: false, reason: 'running' };
    const bin = cli();
    if (!bin) { fallback('no Orca CLI next to this app'); return { started: false, reason: 'no_cli' }; }
    let child;
    try {
      child = spawnFn(bin, ['plugin', 'open', key, '--panel', PANEL_ID], { shell: false, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: process.env });
    } catch (e) {
      fallback('the CLI did not start (' + String((e && e.code) || e) + ')');
      return { started: false, reason: 'spawn' };
    }
    const job = { child, err: '', done: false };
    running = job;
    const finish = (why) => {
      if (job.done) return;
      job.done = true;
      clearTimeout(timer);
      if (running === job) running = null;
      if (why) fallback(why);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (e) { /* gone */ }
      finish('the CLI did not answer within ' + timeoutMs + ' ms');
    }, timeoutMs);
    if (child.stderr) child.stderr.on('data', (d) => { if (job.err.length < 300) job.err += String(d); });
    child.on('error', (e) => finish('the CLI did not start (' + String((e && e.code) || e) + ')'));
    child.on('exit', (code, signal) => {
      if (code === 0) finish(null);
      else finish('the CLI failed (' + (signal || 'exit ' + code) + (job.err.trim() ? ': ' + job.err.trim().replace(/\s+/g, ' ').slice(0, 200) : '') + ')');
    });
    return { started: true };
  }
  return { show, busy: () => !!running };
}
