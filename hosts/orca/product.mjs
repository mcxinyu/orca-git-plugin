// The name the Orca plugin goes by (hosts/orca/README.md "Identity"). Renaming the product means changing this file,
// `id` / `name` / `author` in orca-plugin.json and PRODUCT at the top of panel.js; nothing else under Orca says it.
import os from 'node:os';
import path from 'node:path';

export const PRODUCT = Object.freeze({
  name: 'Git Panel',          // what a user reads (messages, the git messages the engine writes)
  id: 'git-panel',            // the engine's folder in every git dir (<git dir>/git-panel/) and the settings home
  homeEnv: 'GIT_PANEL_HOME',  // moves the settings home (tests pass `opts.home`)
  noteExt: '.gitpanel',       // the custom editor's file extension (orca-plugin.json `customEditors`)
});

/** The worker's settings folder: `explicit` (tests), else $GIT_PANEL_HOME, else ~/.config/git-panel. */
export function orcaHome(explicit) {
  return explicit || process.env[PRODUCT.homeEnv] || path.join(os.homedir(), '.config', PRODUCT.id);
}
