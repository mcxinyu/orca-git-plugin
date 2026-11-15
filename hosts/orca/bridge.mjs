// The worker half of the Orca transport (docs/ARCHITECTURE.md §6.2, hosts/orca/README.md "Transport").
//
// Orca's limits (read from Orca 1.4.255's own code, see README): a panel's host call, `plugin.request` included, is
// refused over 64 KiB and the plugin's panels share a budget of 120 calls per 10 s; a handler's answer is refused
// over 1 MiB, where Orca's size measure also counts objects (more than 10 000 is "too large"); `orca.panels.post`
// drops (silently) a payload over 256 KiB or more than 200 posts per 10 s. So:
//   - calls are batched: one `send` request starts many engine calls and answers at once;
//   - results and engine events wait in a per-client mailbox that one long `poll` request drains (held up to
//     25 s when empty); every item carries a sequence number, the next poll acknowledges what arrived, an answer
//     that got lost is sent again, the panel drops duplicates;
//   - every value travels as a JSON string (one string is one object for Orca's measure); an item larger than
//     one answer is kept here and the panel pulls it in parts (`part`); params larger than one request are sent
//     ahead in parts (`put`) and the call names the upload;
//   - a call id runs ONCE per client, however late or often its `send` is delivered. The panel numbers its calls
//     upwards and tells with every request the id below which all its calls are settled (`settled`): the worker never
//     runs an id below that watermark and remembers the ids at or above it that it has started. So the memory is the
//     calls in flight, not a bounded list a replay could fall out of. (A finished mutating id is also answered with
//     its recorded outcome while that is kept; the result itself always travels through the mailbox.)
// Clients: `hello` makes one per panel page. A client lives while it polls; a poll whose request is aborted (the
// panel went away) drops it after a short grace, a client that stops polling is dropped after the lease. Dropping
// ends its engine subscriptions (engine.dropClient) and cancels its running reads. A worker restart loses every
// client: the panel learns it from `unknown_client` (or another `instance`) and starts over (ui/host/orca.js).
import crypto from 'node:crypto';

export const LIMITS = Object.freeze({
  inputBudget: 40 * 1024,     // bytes of params / upload data the panel puts in one request (Orca refuses > 64 KiB)
  answerBudget: 896 * 1024,   // bytes of item JSON in one answer (Orca refuses > 1 MiB)
  partBytes: 768 * 1024,      // one part of an item that does not fit an answer
  maxItems: 1000,             // items per answer (Orca counts objects: at most 10 000)
  pollHoldMs: 25000,          // an empty poll is answered after this (Orca's request deadline is 120 s)
  coalesceMs: 12,             // a woken poll waits this long for more items
  leaseMs: 60000,             // a client that has not polled for this long is dropped
  graceMs: 3000,              // a poll aborted by Orca (panel closed) drops its client after this
  ttlMs: 120000,              // unfetched parts and unfinished uploads are dropped after this
  outboxBytes: 64 * 1024 * 1024,
  uploadBytes: 64 * 1024 * 1024,
});

const EVENTS = ['changed', 'console', 'progress', 'job'];
const DONE_CAP = 500; // recorded outcomes of finished mutating calls kept per client (a repeated `send` gets the outcome again)
const STARTED_CAP = 200000; // started ids remembered for a panel that sends no `settled` watermark; beyond it the worker raises its own
const rand = () => crypto.randomBytes(8).toString('hex');
const byteLength = (s) => Buffer.byteLength(s, 'utf8');

function wireError(err) {
  if (err && typeof err.toJSON === 'function') return err.toJSON();
  if (err && typeof err.code === 'string') return { code: err.code, message: String(err.message || err.code), data: err.data == null ? null : err.data };
  return { code: 'internal', message: String(err && err.message ? err.message : err), data: null };
}

/** Splits `text` into pieces of at most `max` UTF-8 bytes, never inside a surrogate pair. */
export function splitBytes(text, max) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    let n = Math.min(text.length - i, max);
    for (;;) {
      let end = i + n;
      const c = text.charCodeAt(end - 1);
      if (end < text.length && c >= 0xd800 && c <= 0xdbff) end -= 1;
      // a budget below one character (a pair is 4 bytes) still moves on: the whole pair goes as one piece
      if (end <= i) end = Math.min(text.length, i + 2);
      const piece = text.slice(i, end);
      if (byteLength(piece) <= max || n <= 1) { out.push(piece); i = end; break; }
      n = Math.max(1, Math.floor(n / 2));
    }
  }
  return out.length ? out : [''];
}

export function createBridge({ engine, limits, log = () => {} }) {
  const L = { ...LIMITS, ...(limits || {}) };
  const instance = 'w' + rand();
  const clients = new Map();
  let closed = false;
  const offs = EVENTS.map((event) => engine.on(event, (data) => route(event, data)));
  // Without a method list every call counts as mutating (recorded), which is the safe side.
  const listed = engine.methods ? engine.methods() : null;
  const mutatingMethods = { has: (name) => !listed || !listed.some((m) => m.name === name && !m.mutating) };
  const sweeper = setInterval(sweep, Math.max(50, Math.min(5000, Math.floor(L.leaseMs / 4))));
  if (sweeper.unref) sweeper.unref();

  // ------------------------------------------------------------------ clients
  function hello(input, ctx) {
    if (closed) return { instance, error: { code: 'unavailable', message: 'the worker is stopping' } };
    const c = {
      id: 'o' + rand(), view: input && typeof input.view === 'string' ? input.view.slice(0, 32) : '',
      panel: ctx && ctx.panel && ctx.panel.id ? String(ctx.panel.id) : null,
      seq: 0, outbox: [], bytes: 0, chunks: new Map(), uploads: new Map(), calls: new Map(), done: new Map(),
      started: new Set(), floor: 0,   // call ids that ran or run (at or above `floor`); ids below `floor` never run
      poll: null, lastSeen: Date.now(), dropTimer: null,
    };
    clients.set(c.id, c);
    const reads = engine.methods ? engine.methods().filter((m) => !m.mutating).map((m) => m.name) : [];
    return { instance, client: c.id, limits: { inputBudget: L.inputBudget }, reads };
  }
  const unknown = () => ({ instance, error: { code: 'unknown_client', message: 'this worker does not know the client (it was restarted or the client expired)' } });
  function find(input) {
    const c = input && typeof input.client === 'string' ? clients.get(input.client) : null;
    if (!c) return null;
    c.lastSeen = Date.now();
    return c;
  }
  function drop(c, reason) {
    if (clients.get(c.id) !== c) return;
    clients.delete(c.id);
    clearTimeout(c.dropTimer);
    try { engine.dropClient(c.id); } catch (e) { /* engine closed */ }
    for (const ctl of c.calls.values()) ctl.abort();
    c.calls.clear();
    if (c.poll) c.poll.finish(true);
    c.outbox = []; c.chunks.clear(); c.uploads.clear();
    log('client ' + c.id + ' dropped (' + reason + ')');
  }
  function sweep() {
    const now = Date.now();
    for (const c of Array.from(clients.values())) {
      if (!c.poll && now - c.lastSeen > L.leaseMs) { drop(c, 'lease'); continue; }
      for (const [k, ch] of c.chunks) if (now - ch.at > L.ttlMs) c.chunks.delete(k);
      for (const [k, up] of c.uploads) if (now - up.at > L.ttlMs) c.uploads.delete(k);
    }
  }

  // ------------------------------------------------------------------ the mailbox
  function push(c, item) {
    if (clients.get(c.id) !== c) return;
    item.seq = ++c.seq;
    item.bytes = byteLength(item.json);
    c.outbox.push(item);
    c.bytes += item.bytes;
    if (c.bytes > L.outboxBytes) { drop(c, 'outbox overflow'); return; }
    if (c.poll) c.poll.wake();
  }
  function route(event, data) {
    let json;
    try { json = JSON.stringify({ event, data: data === undefined ? null : data }); } catch (e) { return; }
    for (const c of clients.values()) push(c, { t: 'e', json });
  }
  function ack(c, seq) {
    if (!(seq > 0)) return;
    let n = 0;
    while (n < c.outbox.length && c.outbox[n].seq <= seq) { c.bytes -= c.outbox[n].bytes; n++; }
    if (n) c.outbox.splice(0, n);
  }
  /** The items of one answer: what is not acknowledged yet, up to the budget; big items become parts. */
  function answer(c) {
    const items = [];
    let used = 0;
    for (const it of c.outbox) {
      if (items.length >= L.maxItems) break;
      const inline = it.bytes <= L.answerBudget;
      const cost = inline ? it.bytes : 256;
      if (items.length && used + cost > L.answerBudget) break;
      used += cost;
      const out = { seq: it.seq, t: it.t };
      if (it.id !== undefined) out.id = it.id;
      if (it.ok !== undefined) out.ok = it.ok;
      if (inline) out.json = it.json;
      else {
        if (!it.key) {
          it.key = 'k' + it.seq;
          const parts = splitBytes(it.json, L.partBytes);
          c.chunks.set(it.key, { parts, fetched: new Set(), at: Date.now() });
          it.parts = parts.length;
        }
        out.chunk = { key: it.key, parts: it.parts, bytes: it.bytes };
      }
      items.push(out);
    }
    return { instance, items, more: items.length < c.outbox.length };
  }

  function poll(input, ctx) {
    const c = find(input);
    if (!c) return unknown();
    clearTimeout(c.dropTimer);
    ack(c, Number(input.ack) || 0);
    settle(c, Number(input.settled) || 0);
    if (c.poll) c.poll.finish(true);            // a newer poll takes over (the panel gave up on the old one)
    if (c.outbox.length || closed) return answer(c);
    return new Promise((resolve) => {
      let coalesce = null, done = false;
      const p = {
        wake() { if (!coalesce && !done) coalesce = setTimeout(() => p.finish(false), L.coalesceMs); },
        finish(empty) {
          if (done) return;
          done = true;
          clearTimeout(hold); clearTimeout(coalesce);
          if (c.poll === p) c.poll = null;
          c.lastSeen = Date.now();
          resolve(empty ? { instance, items: [], more: false } : answer(c));
        },
      };
      const hold = setTimeout(() => p.finish(false), L.pollHoldMs);
      c.poll = p;
      const signal = ctx && ctx.signal;
      if (signal) {
        const gone = () => {
          if (done) return;
          p.finish(true);
          // Orca aborts a request when its panel closes: give a reloading panel a moment, then drop.
          clearTimeout(c.dropTimer);
          c.dropTimer = setTimeout(() => { if (!c.poll) drop(c, 'panel gone'); }, L.graceMs);
          if (c.dropTimer.unref) c.dropTimer.unref();
        };
        if (signal.aborted) gone(); else signal.addEventListener('abort', gone, { once: true });
      }
    });
  }

  // ------------------------------------------------------------------ calls
  function result(c, id, ok, value) {
    let json;
    try { json = JSON.stringify(value === undefined ? null : value); } catch (e) { ok = false; json = JSON.stringify(wireError(e)); }
    push(c, { t: 'r', id, ok, json });
    return { ok, json };
  }
  /**
   * The panel's watermark: every call id below `mark` is settled on its side (it has the result or gave the call up),
   * so none of them is ever run (again) and what was remembered of them can go. It only moves up.
   */
  function settle(c, mark) {
    if (!(mark > c.floor)) return;
    c.floor = mark;
    for (const id of c.started) if (id < mark) c.started.delete(id);
    for (const id of c.done.keys()) if (id < mark) c.done.delete(id);
  }
  /**
   * A `send` that reaches the worker twice (a retried request, however late) must not run a call twice: an id that is
   * still running is ignored (its result comes once); an id that ran is not run again (a finished mutating call is
   * answered with its recorded outcome while that is kept); an id below the panel's watermark is never run.
   */
  function start(c, call) {
    if (!call || typeof call.id !== 'number' || typeof call.method !== 'string') return;
    if (c.calls.has(call.id)) return;
    const seen = c.done.get(call.id);
    if (seen) { push(c, { t: 'r', id: call.id, ok: seen.ok, json: seen.json }); return; }
    if (call.id < c.floor || c.started.has(call.id)) return;
    c.started.add(call.id);
    if (c.started.size > STARTED_CAP) {
      // a panel that never sends its watermark: the worker's own, half way up the ids it remembers (ids only grow)
      const ids = Array.from(c.started).sort((a, b) => a - b);
      settle(c, ids[ids.length >> 1]);
    }
    const mutating = mutatingMethods.has(call.method);
    let params;
    try {
      const json = call.upload !== undefined ? takeUpload(c, String(call.upload)) : call.params;
      params = json == null || json === '' ? {} : JSON.parse(json);
    } catch (e) {
      result(c, call.id, false, { code: e.code || 'invalid_params', message: String(e.message || e), data: null });
      return;
    }
    const ctl = new AbortController();
    c.calls.set(call.id, ctl);
    const record = (ok, value) => {
      const item = result(c, call.id, ok, value);
      if (!mutating || !item) return;
      c.done.set(call.id, { ok: item.ok, json: item.json });
      if (c.done.size > DONE_CAP) c.done.delete(c.done.keys().next().value);
    };
    Promise.resolve()
      .then(() => engine.call(call.method, params, { client: c.id, signal: ctl.signal }))
      .then((res) => record(true, res), (err) => record(false, wireError(err)))
      .finally(() => c.calls.delete(call.id));
  }
  function send(input) {
    const c = find(input);
    if (!c) return unknown();
    const calls = Array.isArray(input.calls) ? input.calls : [];
    // this request's calls first (they were unsettled when it was written), then its watermark
    calls.forEach((call) => start(c, call));
    settle(c, Number(input.settled) || 0);
    return { instance, ok: true, started: calls.length };
  }
  function put(input) {
    const c = find(input);
    if (!c) return unknown();
    const { key, index, total, data } = input;
    if (typeof key !== 'string' || typeof data !== 'string' || !(total >= 1 && total <= 4096) || !(index >= 0 && index < total)) {
      return { instance, error: { code: 'invalid_params', message: 'bad upload part' } };
    }
    let up = c.uploads.get(key);
    if (!up) { up = { parts: new Array(total).fill(null), have: 0, bytes: 0, at: Date.now() }; c.uploads.set(key, up); }
    if (up.parts.length !== total) return { instance, error: { code: 'invalid_params', message: 'upload part count changed' } };
    if (up.parts[index] === null) { up.have++; up.bytes += byteLength(data); }
    up.parts[index] = data;
    up.at = Date.now();
    if (up.bytes > L.uploadBytes) { c.uploads.delete(key); return { instance, error: { code: 'too_large', message: 'upload too large' } }; }
    return { instance, ok: true };
  }
  function takeUpload(c, key) {
    const up = c.uploads.get(key);
    c.uploads.delete(key);
    if (!up || up.have !== up.parts.length) throw Object.assign(new Error('incomplete upload ' + key), { code: 'invalid_params' });
    return up.parts.join('');
  }
  function part(input) {
    const c = find(input);
    if (!c) return unknown();
    const ch = c.chunks.get(String(input.key));
    const i = Number(input.index);
    if (!ch || !(i >= 0 && i < ch.parts.length)) return { instance, error: { code: 'not_found', message: 'no such part' } };
    ch.fetched.add(i);
    ch.at = Date.now();
    const data = ch.parts[i];
    if (ch.fetched.size === ch.parts.length) c.chunks.delete(String(input.key));
    return { instance, data };
  }
  function bye(input) {
    const c = find(input);
    if (c) drop(c, 'bye');
    return { instance, ok: true };
  }
  /** A message for the other panels of this plugin that show `view` (e.g. "show this commit in the Log"). */
  function relay(input) {
    const c = find(input);
    if (!c) return unknown();
    let json;
    try { json = JSON.stringify({ type: String(input.type || ''), data: input.data === undefined ? null : input.data }); } catch (e) { return { instance, error: { code: 'invalid_params', message: 'bad relay' } }; }
    let delivered = 0;
    for (const other of clients.values()) {
      if (other === c || other.view !== String(input.view || '')) continue;
      push(other, { t: 'h', json });
      delivered++;
    }
    return { instance, delivered };
  }

  /** A host message from the worker itself to every client that shows `view` (the center tab: a new spec). */
  function broadcast(view, type, data) {
    let json;
    try { json = JSON.stringify({ type: String(type), data: data === undefined ? null : data }); } catch (e) { return 0; }
    let delivered = 0;
    for (const c of clients.values()) if (c.view === view) { push(c, { t: 'h', json }); delivered++; }
    return delivered;
  }

  function close() {
    if (closed) return;
    closed = true;
    clearInterval(sweeper);
    offs.forEach((off) => { try { off(); } catch (e) { /* gone */ } });
    for (const c of Array.from(clients.values())) drop(c, 'worker stopping');
  }

  return {
    instance,
    limits: L,
    handlers: { hello, send, poll, part, put, bye, relay },
    broadcast,
    clients: () => Array.from(clients.values()).map((c) => ({ id: c.id, view: c.view, panel: c.panel, outbox: c.outbox.length, calls: c.calls.size, polling: !!c.poll, chunks: c.chunks.size, started: c.started.size, settled: c.floor })),
    close,
  };
}
