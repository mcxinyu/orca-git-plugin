// The "Environment" of a problem report (hosts/orca/README.md "Report a Problem"): what every bug report needs and
// nothing about the person's work. The Orca app's version (the host API tells only its API level), and the system's
// part every host shares (core/report/environment.js): the operating system by its own name and version, git's
// version. Read once, kept for the worker's life.
//   createEnvironment({ cli, platform?, execPath?, run? }) -> { read() -> Promise<{ orca, os, arch, git, node }> }
// A value that cannot be read is 'unknown'; nothing here throws. Only version-like text leaves (sanitised).
import { version, firstLine, osName, bundleVersion, createSystem } from '../../core/report/environment.js';

export { osName, bundleVersion };

export function createEnvironment(o = {}) {
  const platform = o.platform || process.platform, run = o.run || firstLine;
  const system = createSystem({ platform, run });
  let kept = null;
  async function read() {
    if (kept) return kept;
    // the worker runs inside Orca.app: its bundle says the version; elsewhere Orca's own CLI does
    let orca = bundleVersion(o.execPath, platform);
    if (!orca) {
      let cli = null;
      try { cli = typeof o.cli === 'function' ? o.cli() : o.cli; } catch (e) { cli = null; }
      if (cli) orca = version(await run(cli, ['--version']));
    }
    kept = Object.assign({ orca: orca || 'unknown' }, await system.read());
    return kept;
  }
  return { read };
}
