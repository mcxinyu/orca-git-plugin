// Updates under Orca: whether a newer release is out, and whether this one should still be used (hosts/orca/README.md
// "Updates"). Orca knows no "minimum plugin version": it installs a listed release by itself 12 hours after the
// listing, unless the person turned that off or the release asks for new access. For a fix nobody should work without,
// the plugin's public repository carries one small file, the channel, on a branch of its own (`updates`, so a change to
// it touches no release), written by hand once a release is listed in the catalog:
//   { "schema": 1, "latest": "0.1.12", "minimum": "0.1.11", "note": "one sentence a person reads" }
// The worker reads it when it starts and every 6 hours with a plain GET. Nothing about the person, the machine or a
// repository goes out: no query, no identifier, a fixed User-Agent.
//   below `latest`   → 'available'  a dot on the Options button and a row in its menu (ui/git/update.js)
//   below `minimum`  → 'required'   the same, and the update dialog opens by itself, at most once a day
// Nothing is ever locked (the owner, 17 Nov 2026): below the minimum the panels work as before and ask. What could not
// be read changes nothing: no network, no file, a file that does not parse, a `minimum` above `latest` → the last
// answer that did parse stays (none yet: 'unknown', nothing shows).
import https from 'node:https';
import { spawn } from 'node:child_process';

export const CHANNEL_URL = 'https://raw.githubusercontent.com/omerfarukgzr/orca-git-plugin/updates/versions.json';
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
export const RETRY_AFTER_MS = 10 * 60 * 1000;      // after a read that did not get through (offline, a timeout, 5xx)
export const NOTE_MAX = 200;
export const BODY_MAX = 16 * 1024;
export const UPDATE_TIMEOUT_MS = 90000;

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

/** 'unknown' | 'current' | 'available' | 'required' for the running version against a parsed channel. */
export function stateOf(current, channel) {
  const cur = parseVersion(current);
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
 * The channel's reader. `version`: the running plugin's; `fetch(url)`: fetchText, a test's stand-in, or null (never
 * reads: the tests' default, worker.mjs). `view()` answers
 *   { state, current, latest, minimum, note, checked }
 * with `checked` how the last read went: 'never' | 'off' | 'ok' | 'invalid' | 'not_found' | 'offline' | 'timeout' | …
 */
export function createUpdate({ version, url = CHANNEL_URL, fetch = fetchText, log = () => {}, everyMs = CHECK_EVERY_MS, retryMs = RETRY_AFTER_MS, now = Date.now }) {
  let channel = null;                       // the last answer that parsed; a failed read never takes it away
  let checked = fetch ? 'never' : 'off';
  let at = 0, inflight = null, timer = null, stopped = false, said = '';
  const view = () => ({
    state: stateOf(version, channel), current: parseVersion(version) ? version : null,
    latest: channel ? channel.latest : null, minimum: channel ? channel.minimum : null, note: channel ? channel.note : '', checked,
  });
  function check() {
    if (!fetch || stopped) return Promise.resolve(view());
    if (inflight) return inflight;
    inflight = Promise.resolve().then(() => fetch(url)).then((r) => {
      if (r && r.ok === true) {
        const c = parseChannel(r.text);
        if (c) { channel = c; checked = 'ok'; } else checked = 'invalid';
      } else checked = r && typeof r.why === 'string' && /^[a-z0-9_]{1,24}$/.test(r.why) ? r.why : 'offline';
    }, () => { checked = 'offline'; }).then(() => {
      at = now();
      inflight = null;
      const v = view();
      // one line whenever the outcome changes; versions and a state only
      const line = 'update check: ' + (v.current || 'unknown version') + ' is ' + v.state + ' (channel ' + checked
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
 * "Update Now": Orca's own CLI moves an installed plugin to the release its catalog offers (`orca plugin update
 * <plugin-key>`; exit 0 done, 3 the update asks for new access and waits for the person's approval). The worker runs
 * the CLI bundled with the app it runs in (showpanel.mjs cliPath), with an argument array, no shell.
 * `run()` → { result }: 'done' (Orca answered 0: it moved the plugin, or its catalog offers nothing newer yet; when it
 * moved it, Orca stops this worker and the answer may never arrive), 'approval', 'failed', 'timeout', 'no_cli',
 * 'development' (a folder loaded for development has no release to move to; never run), 'running'.
 */
export function createUpdater({ cli, key, log = () => {}, spawnFn = spawn, timeoutMs = UPDATE_TIMEOUT_MS }) {
  let running = null;
  function run() {
    if (typeof key !== 'string' || !key || /^local\./.test(key)) return Promise.resolve({ result: 'development' });
    if (running) return running;
    const bin = cli();
    if (!bin) { log('update: no Orca CLI next to this app'); return Promise.resolve({ result: 'no_cli' }); }
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
        child = spawnFn(bin, ['plugin', 'update', key], { shell: false, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: process.env });
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
