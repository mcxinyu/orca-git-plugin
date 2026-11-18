// Updates under Orca: whether a newer release is out, and whether this one should still be used (hosts/orca/README.md
// "Updates"). The promise (the owner, 18 Nov 2026): once a release is out, the Options button (⋮) says so, and its
// Update Now brings the newest release without opening anything else.
// Which release is the newest comes from Orca's community catalog itself, not from a file written by hand: its
// `status.json` names, per repository, the release it lists (`"omerfarukgzr/orca-git-plugin": { "state": "listed",
// "ref": "refs/tags/omerfarukgzr/orca-git-plugin/0.1.12" }`), written in the same commit as the catalog Orca
// installs from. A release the catalog does not list yet shows nothing: Update Now (`orca plugin update`, which
// refreshes that catalog first) could not install it. Measured 18 Nov 2026: 0.1.12 was listed hours after its tag,
// 0.1.11 never (0.1.12 came first).
// For a fix nobody should work without, the plugin's public repository carries one small file, the channel, on a
// branch of its own (`updates`, so a change to it touches no release):
//   { "schema": 1, "latest": "0.1.12", "minimum": "0.1.11", "note": "one sentence a person reads" }
// Only its `minimum` and `note` count now (0.1.11 and 0.1.12 read `latest` too). Both files are read when the worker
// starts and every 6 hours with a plain GET. Nothing about the person, the machine or a repository goes out: no query,
// no identifier, a fixed User-Agent.
//   below the listed release            → 'available'  a dot on the Options button and a row in its menu (ui/git/update.js)
//   below the channel's `minimum` too   → 'required'   the same, and the update dialog opens by itself, at most once a day
// Nothing is ever locked (the owner, 17 Nov 2026): below the minimum the panels work as before and ask. What could not
// be read changes nothing: the last answer that did parse stays (none yet: 'unknown', nothing shows).
import https from 'node:https';
import { spawn } from 'node:child_process';

export const CHANNEL_URL = 'https://raw.githubusercontent.com/omerfarukgzr/orca-git-plugin/updates/versions.json';
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
export const RETRY_AFTER_MS = 10 * 60 * 1000;      // after a read that did not get through (offline, a timeout, 5xx)
export const NOTE_MAX = 200;
export const BODY_MAX = 16 * 1024;
export const REPOSITORY = 'omerfarukgzr/orca-git-plugin';
export const CATALOG_STATUS_URL = 'https://raw.githubusercontent.com/stablyai/orca-community-plugins/main/status.json';
export const CATALOG_MAX = 2 * 1024 * 1024;        // 94 KB on 18 Nov 2026, for every plugin of the catalog
export const UPDATE_TIMEOUT_MS = 240000;   // Orca downloads the catalog first (30–90 s measured)

/** "1.2.3" → [1, 2, 3]; anything else (a range, a pre-release, a `v`) → null. */
export function parseVersion(v) {
  const m = typeof v === 'string' ? /^(\d{1,5})\.(\d{1,5})\.(\d{1,5})$/.exec(v.trim()) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1, 0 or 1 for two parsed versions. */
export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/**
 * The channel file's text → { latest, minimum, note }, or null when it is not one. `minimum` may be left out (nothing
 * is required); a `minimum` above `latest` would ask everyone for a release that does not exist, so such a file
 * counts as unreadable. `note` is plain text for the page: one line, control characters out, at most NOTE_MAX characters.
 */
export function parseChannel(text) {
  let v = null;
  try { v = JSON.parse(String(text)); } catch (e) { return null; }
  if (!v || typeof v !== 'object' || Array.isArray(v) || !Number.isInteger(v.schema) || v.schema < 1) return null;
  const latest = parseVersion(v.latest);
  const minimum = v.minimum === undefined || v.minimum === null ? [0, 0, 0] : parseVersion(v.minimum);
  if (!latest || !minimum || compareVersions(minimum, latest) > 0) return null;
  const note = typeof v.note === 'string' ? v.note.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX) : '';
  return { latest: latest.join('.'), minimum: minimum.join('.'), note };
}

/**
 * The catalog's `status.json` text → the version it lists for `repo` ('0.1.12'), null when it lists none (not listed,
 * held back, an entry of another shape), or undefined when the text is not such a file.
 */
export function parseListed(text, repo = REPOSITORY) {
  let v = null;
  try { v = JSON.parse(String(text)); } catch (e) { return undefined; }
  if (!v || typeof v !== 'object' || !v.repos || typeof v.repos !== 'object') return undefined;
  const e = v.repos[repo];
  if (!e || e.state !== 'listed' || typeof e.ref !== 'string') return null;
  const prefix = 'refs/tags/' + repo + '/';
  const ver = e.ref.startsWith(prefix) ? e.ref.slice(prefix.length).replace(/^v/, '') : '';
  return parseVersion(ver) ? parseVersion(ver).join('.') : null;
}

/**
 * 'unknown' | 'current' | 'available' | 'required' for the running version. With `listed` (the catalog's release,
 * or null when it could not be read yet) that release is the newest; without it (undefined) the channel's `latest`.
 */
export function stateOf(current, channel, listed) {
  const cur = parseVersion(current);
  if (listed !== undefined) {
    const top = parseVersion(listed);
    if (!cur || !top) return 'unknown';
    if (compareVersions(cur, top) >= 0) return 'current';
    if (channel && compareVersions(cur, parseVersion(channel.minimum)) < 0) return 'required';
    return 'available';
  }
  if (!cur || !channel) return 'unknown';
  if (compareVersions(cur, parseVersion(channel.minimum)) < 0) return 'required';
  if (compareVersions(cur, parseVersion(channel.latest)) < 0) return 'available';
  return 'current';
}

/**
 * One GET of `url` → { ok: true, text } or { ok: false, why }: 'not_found' (no channel published), 'http_<status>',
 * 'too_large', 'timeout', 'offline'. No redirect is followed and at most `maxBytes` are read. It never rejects.
 */
export function fetchText(url, { timeoutMs = 8000, maxBytes = BODY_MAX, get = https.get } = {}) {
  return new Promise((resolve) => {
    let done = false, req = null;
    const end = (r) => { if (!done) { done = true; resolve(r); } };
    try {
      req = get(url, { headers: { 'User-Agent': 'git-panel-update-check', Accept: 'application/json' }, timeout: timeoutMs }, (res) => {
        if (res.statusCode !== 200) { res.resume(); end({ ok: false, why: res.statusCode === 404 ? 'not_found' : 'http_' + res.statusCode }); return; }
        const parts = [];
        let size = 0;
        res.on('data', (d) => {
          size += d.length;
          if (size > maxBytes) { end({ ok: false, why: 'too_large' }); req.destroy(); } else parts.push(d);
        });
        res.on('end', () => end({ ok: true, text: Buffer.concat(parts).toString('utf8') }));
        res.on('error', () => end({ ok: false, why: 'offline' }));
      });
    } catch (e) { end({ ok: false, why: 'offline' }); return; }
    req.on('timeout', () => { end({ ok: false, why: 'timeout' }); req.destroy(); });
    req.on('error', () => end({ ok: false, why: 'offline' }));
  });
}

/**
 * The reader of the catalog and the channel. `version`: the running plugin's; `fetch(url, opts)`: fetchText, a test's
 * stand-in, or null (never reads: the tests' default, worker.mjs); `catalog`: the catalog's status url, or null to go
 * by the channel's `latest` alone. `view()` answers
 *   { state, current, latest, minimum, note, checked, channel }
 * with `checked` how the last read of the catalog went (of the channel without a catalog) and `channel` how the
 * channel's went: 'never' | 'off' | 'ok' | 'invalid' | 'not_found' | 'offline' | 'timeout' | …
 */
export function createUpdate({ version, url = CHANNEL_URL, catalog = CATALOG_STATUS_URL, fetch = fetchText, log = () => {}, everyMs = CHECK_EVERY_MS, retryMs = RETRY_AFTER_MS, now = Date.now }) {
  let channel = null;                       // the last answers that parsed; a failed read never takes them away
  let listed = null;
  let checked = fetch ? 'never' : 'off', channelChecked = checked, catalogChecked = checked;
  let at = 0, inflight = null, timer = null, stopped = false, said = '';
  const view = () => {
    const latest = catalog ? listed : channel ? channel.latest : null;
    const minimum = channel ? channel.minimum : latest ? '0.0.0' : null;
    return {
      state: stateOf(version, channel, catalog ? listed : undefined), current: parseVersion(version) ? version : null,
      latest, minimum, note: channel && channel.latest === latest ? channel.note : '', checked, channel: channelChecked,
    };
  };
  const outcome = (r) => (r && typeof r.why === 'string' && /^[a-z0-9_]{1,24}$/.test(r.why) ? r.why : 'offline');
  function check() {
    if (!fetch || stopped) return Promise.resolve(view());
    if (inflight) return inflight;
    const readChannel = Promise.resolve().then(() => fetch(url)).then((r) => {
      if (r && r.ok === true) {
        const c = parseChannel(r.text);
        if (c) { channel = c; channelChecked = 'ok'; } else channelChecked = 'invalid';
      } else channelChecked = outcome(r);
    }, () => { channelChecked = 'offline'; });
    const readCatalog = !catalog ? null : Promise.resolve().then(() => fetch(catalog, { maxBytes: CATALOG_MAX, timeoutMs: 15000 })).then((r) => {
      if (r && r.ok === true) {
        const l = parseListed(r.text);
        if (l === undefined) catalogChecked = 'invalid'; else { listed = l; catalogChecked = 'ok'; }
      } else catalogChecked = outcome(r);
    }, () => { catalogChecked = 'offline'; });
    inflight = Promise.all([readChannel, readCatalog]).then(() => {
      checked = catalog ? catalogChecked : channelChecked;
      at = now();
      inflight = null;
      const v = view();
      // one line whenever the outcome changes; versions and a state only
      const line = 'update check: ' + (v.current || 'unknown version') + ' is ' + v.state
        + (catalog ? ' (catalog ' + catalogChecked + (listed ? ', lists ' + listed : '') + '; channel ' : ' (channel ') + channelChecked
        + (channel ? ', latest ' + channel.latest + ', minimum ' + channel.minimum : '') + ')';
      if (line !== said) { said = line; log(line); }
      return v;
    });
    return inflight;
  }
  // The next read: the long interval after an answer (a 404 is one: no channel is published), sooner after a read that
  // did not get through.
  const gotThrough = () => checked === 'ok' || checked === 'invalid' || checked === 'not_found';
  function schedule() {
    if (stopped || !fetch) return;
    clearTimeout(timer);
    timer = setTimeout(() => { check().then(schedule, schedule); }, gotThrough() ? everyMs : retryMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
  return {
    view,
    check,
    start() { if (fetch && !stopped) check().then(schedule, schedule); },
    /**
     * What a page is told: the answer so far. A first read that is on its way is waited for (at most `waitMs`), so a
     * page that opens with the app learns the answer with its first question; a read that is long overdue (a machine
     * that slept through the timer) is started again without being waited for.
     */
    async read(waitMs = 1500) {
      if (fetch && !stopped && !inflight && at && now() - at > everyMs) check().then(schedule, schedule);
      if (inflight && checked === 'never') {
        let t = null;
        await Promise.race([inflight, new Promise((r) => { t = setTimeout(r, waitMs); if (t && typeof t.unref === 'function') t.unref(); })]);
        clearTimeout(t);
      }
      return view();
    },
    stop() { stopped = true; clearTimeout(timer); },
  };
}

/**
 * "Update Now" runs Orca's own `orca plugin update <key>`: it refreshes the plugin's catalog first and moves the
 * plugin to the release listed there, keeping the approval when the release asks for no new access. Measured on
 * 18 Nov 2026 (Orca 1.4.259): ~30 s, an older measurement ~84 s for the catalog download, hence the long timeout.
 * Installing the release's tag straight from this repository was tried and refused: the catalog installs from
 * `stablyai/orca-community-mirror`, so Orca counts our repository as a move and asks for approval
 * (`approval_required`, `repositoryMoved`), and the mirror's own tag installs under the key `stablyai.git-panel`,
 * which Orca blocks as an official name. So a release reaches Update Now once the catalog lists it (hours, measured).
 */
export function updateArgs(key) {
  return ['plugin', 'update', key];
}

/**
 * Runs the CLI bundled with the app the worker runs in (showpanel.mjs cliPath), with an argument array, no shell.
 * `run()` → { result }: 'done' (Orca answered 0: it moved the plugin, or its catalog offers nothing newer yet; once it
 * swapped the plugin, Orca stops this worker and the answer may never arrive), 'approval' (exit 3: the release asks
 * for new access and waits for the person's approval in Orca), 'failed', 'timeout', 'no_cli', 'development' (a folder
 * loaded for development has no release to move to; never run), 'running'.
 */
export function createUpdater({ cli, key, log = () => {}, spawnFn = spawn, timeoutMs = UPDATE_TIMEOUT_MS }) {
  let running = null;
  function run() {
    if (typeof key !== 'string' || !key || /^local\./.test(key)) return Promise.resolve({ result: 'development' });
    if (running) return running;
    const bin = cli();
    if (!bin) { log('update: no Orca CLI next to this app'); return Promise.resolve({ result: 'no_cli' }); }
    const args = updateArgs(key);
    running = new Promise((resolve) => {
      let child = null, done = false, err = '', timer = null;
      const end = (result, why) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        running = null;
        log('update: ' + result + (why ? ' (' + why + ')' : ''));
        resolve({ result });
      };
      try {
        child = spawnFn(bin, args, { shell: false, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: process.env });
      } catch (e) { end('failed', 'the CLI did not start: ' + String((e && e.code) || 'error')); return; }
      timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } end('timeout', timeoutMs + ' ms'); }, timeoutMs);
      if (child.stderr) child.stderr.on('data', (d) => { if (err.length < 300) err += String(d); });
      child.on('error', (e) => end('failed', 'the CLI did not start: ' + String((e && e.code) || 'error')));
      // Orca's own words on stderr name its codes (approval_required, plugin_not_found…), not the person's folders
      child.on('exit', (code, signal) => {
        if (code === 0) end('done');
        else if (code === 3) end('approval');
        else end('failed', (signal || 'exit ' + code) + (/\b[a-z]+(_[a-z]+)+\b/.test(err) ? ': ' + /\b[a-z]+(_[a-z]+)+\b/.exec(err)[0] : ''));
      });
    });
    return running;
  }
  return { run, busy: () => !!running };
}
