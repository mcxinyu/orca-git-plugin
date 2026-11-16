// The repository of the focused workspace in Orca's status bar (hosts/orca/README.md "Status bar").
// Orca draws the item (`contributes.statusBarItems`): a short text, one icon of its list, a tone and a tooltip; the
// worker changes it with `statusBar.update` and pressing it runs `contributes.commands` `showGitPanel` (showpanel.mjs).
//
//   describe(snapshot, job) -> { text, tone, tooltip }      what one snapshot (and the running job, if any) shows
//   createStatusItem({ host, engine, resolve, log })        follows the focus: one engine client, one watched repository
//
// Cost when idle: the item subscribes ONE repository (the focused one) under its own engine client, so the engine
// watches it as it watches a panel's; a focus change unsubscribes the old one first. Engine `changed`, `job` and
// `progress` events of that repository drive it (no polling); renders are coalesced to one per `minIntervalMs` and
// nothing is sent when text, tone, tooltip and visibility are what Orca already has.
import { PRODUCT } from './product.mjs';

export const ITEM_ID = 'repository';
export const ENGINE_CLIENT = 'orca-status-bar';
export const ICON = 'branch';
// Orca's limits (plugin-status-bar-item-contribution.ts, 1.4.259): text 64, tooltip 256 characters, one line each
export const TEXT_MAX = 64;
export const TOOLTIP_MAX = 256;
const BRANCH_MAX = 36;
const HIDDEN = Object.freeze({ visible: false });

const OP_RUNNING = { merge: 'Merging', rebase: 'Rebasing', 'cherry-pick': 'Cherry-picking', revert: 'Reverting', am: 'Applying patches' };
const OP_NOUN = { merge: 'Merge', rebase: 'Rebase', 'cherry-pick': 'Cherry-pick', revert: 'Revert', am: 'Patch series' };

const LINE_BREAKS = new RegExp('[\\u0000-\\u001f\\u007f\\u0085\\u2028\\u2029]+', 'g');
const oneLine = (s) => String(s == null ? '' : s).replace(LINE_BREAKS, ' ');
const cut = (s, n) => (s.length <= n ? s : s.slice(0, n - 1) + '…');
const count = (n, one, many) => n + ' ' + (n === 1 ? one : many);
const short = (id) => (typeof id === 'string' ? id.slice(0, 8) : '');
const own = (map, k) => !!map && Object.prototype.hasOwnProperty.call(map, k);

/** "Pushing… 42%": the job's title as the engine names it, an ellipsis, a percentage only when the engine has one. */
export function jobText(job) {
  const title = oneLine(job.title || 'Working').trim() || 'Working';
  const base = /[….]$/.test(title) ? title : title + '…';
  return typeof job.fraction === 'number' ? base + ' ' + Math.round(job.fraction * 100) + '%' : base;
}

/**
 * What the item shows for one engine snapshot (`repo.state`) and the job that runs in it now (or null):
 *   idle        `feature/x *5 ↑2 ↓1`   branch (or `HEAD 1a2b3c4d` detached), `*n` local changes (the Commit view's
 *                                       count: changes, unversioned files and conflicts), ↑ to push, ↓ to pull
 *   in progress `main · Merging · 3 conflicts`, `feature/x · Rebasing 2/5`  tone warning
 *   unmerged    `main · 2 conflicts`    tone warning (no operation, e.g. an unstash that conflicted)
 *   interrupted `main · Merge interrupted`  tone danger: git stopped while it set the operation up and the local
 *                                       changes wait in an autostash nobody applies (core/op-state.js `incomplete`)
 *   a job       `main · Pushing… 42%`   the tone of the state underneath
 * The tooltip says it in words, one line.
 */
export function describe(snap, job) {
  const head = (snap && snap.head) || {};
  const op = snap && snap.op ? snap.op : null;
  const rebasing = op && op.type === 'rebase' && op.rebase && op.rebase.branch ? op.rebase.branch : null;
  const branch = head.branch || rebasing || null;
  const label = branch ? cut(oneLine(branch), BRANCH_MAX) : 'HEAD ' + short(head.detached || snap.headId);
  const tips = [];
  if (head.branch) tips.push('Branch ' + oneLine(head.branch) + (head.unborn ? ', no commits yet' : ''));
  else if (rebasing) tips.push('Branch ' + oneLine(rebasing) + ', HEAD detached at ' + short(snap.headId) + ' during the rebase');
  else tips.push('HEAD detached at ' + short(head.detached || snap.headId));

  const conflicts = Array.isArray(snap.conflicts) ? snap.conflicts.length : 0;
  const changes = (Array.isArray(snap.local) ? snap.local.length : 0) + conflicts;
  const words = [];
  let tone = 'neutral';
  if (op) {
    const noun = OP_NOUN[op.type] || 'Operation';
    if (op.incomplete) {
      tone = 'danger';
      words.push(noun + ' interrupted');
      tips.push(noun + ' interrupted: git stopped while setting it up, your local changes wait in an autostash; abort it in the Git panel to get them back');
    } else {
      let w = OP_RUNNING[op.type] || 'Operation in progress';
      if (op.type === 'rebase' && op.rebase && op.rebase.step > 0 && op.rebase.total > 0) w += ' ' + op.rebase.step + '/' + op.rebase.total;
      tone = 'warning';
      words.push(w);
      tips.push(w + ' in progress');
    }
  }
  if (conflicts) {
    if (tone !== 'danger') tone = 'warning';
    words.push(count(conflicts, 'conflict', 'conflicts'));
    tips.push(count(conflicts, 'unmerged file', 'unmerged files'));
  }
  const plus = snap.localTruncated ? '+' : '';
  tips.push(changes ? count(changes, 'changed file', 'changed files').replace(/^(\d+)/, '$1' + plus) : 'no local changes');

  const symbols = [];
  const b = head.branch && own(snap.branches, head.branch) ? snap.branches[head.branch] : null;
  if (b && b.upstream) {
    if (b.gone) tips.push('upstream ' + oneLine(b.upstream) + ' is gone');
    else {
      if (b.ahead) symbols.push('↑' + b.ahead);
      if (b.behind) symbols.push('↓' + b.behind);
      const todo = [b.ahead ? b.ahead + ' to push' : null, b.behind ? b.behind + ' to pull' : null].filter(Boolean).join(', ');
      tips.push('upstream ' + oneLine(b.upstream) + (todo ? ': ' + todo : ', up to date'));
    }
  } else if (head.branch && !head.unborn) tips.push('no upstream');

  let text;
  if (job) {
    const j = jobText(job);
    text = label + ' · ' + j;
    tips.unshift(j);
  } else if (words.length) text = [label].concat(words).join(' · ');
  else text = [label, changes ? '*' + changes + plus : null].concat(symbols).filter(Boolean).join(' ');
  const tooltip = PRODUCT.name + ': ' + tips.join('. ') + '. Click to show the Git panel.';
  return { text: cut(text, TEXT_MAX), tone, tooltip: cut(oneLine(tooltip), TOOLTIP_MAX) };
}

/**
 * The live item. `resolve()` answers the focused workspace as workspace.mjs `focusedWorkspace` does; `refocus()` asks
 * it again (the worker calls it on `workspace.changed`, on a panel's context and on the owner's pick). Only
 * `{ status: 'local', path }` shows something; every other answer (none, remote, unmatched, ambiguous, error) and a
 * folder that is no repository hide the item.
 */
export function createStatusItem({ host, engine, resolve, log = () => {}, minIntervalMs = 250 }) {
  let watching = null;     // the folder subscribed under ENGINE_CLIENT
  let root = null;         // its repository root, as the engine's events name it
  let snap = null, dirty = true;
  const jobs = new Map();  // running jobs of `root`: id -> { title, text, fraction }
  let timer = null, lastAt = 0, busy = false, again = false, closed = false;
  let lastKey = null, sent = 0, failedOnce = false;
  let chain = Promise.resolve(), queued = false;

  const offs = [
    engine.on('changed', (e) => { if (e && root && e.repo === root) { dirty = true; schedule(); } }),
    engine.on('job', (e) => {
      if (!e || !root || e.repo !== root) return;
      if (e.state === 'running') jobs.set(e.job, { ...(jobs.get(e.job) || { text: null, fraction: null }), title: e.title });
      else jobs.delete(e.job);
      schedule();
    }),
    engine.on('progress', (e) => {
      if (!e || !root || e.repo !== root || !jobs.has(e.job)) return;
      const j = jobs.get(e.job);
      j.text = e.text; j.fraction = typeof e.fraction === 'number' ? e.fraction : null;
      schedule();
    }),
  ];

  function schedule() {
    if (closed) return;
    if (busy) { again = true; return; }
    if (timer) return;
    timer = setTimeout(flush, Math.max(0, lastAt + minIntervalMs - Date.now()));
    if (timer.unref) timer.unref();
  }

  async function send(value) {
    const key = JSON.stringify(value);
    if (key === lastKey) return;
    lastKey = key;
    try {
      await host.call('statusBar.update', { id: ITEM_ID, ...value });
      sent++;
    } catch (e) {
      lastKey = null;  // try again on the next change
      if (!failedOnce) { failedOnce = true; log('status bar: ' + ((e && e.code) || 'error') + ' ' + String((e && e.message) || e).slice(0, 200)); }
    }
  }

  async function flush() {
    timer = null;
    if (closed) return;
    busy = true;
    lastAt = Date.now();
    try {
      const r = root;
      if (!r) { await send(HIDDEN); return; }
      if (dirty || !snap) {
        dirty = false;
        try { snap = await engine.call('repo.state', { repo: r }, { client: ENGINE_CLIENT }); } catch (e) { snap = null; }
      }
      if (r !== root || closed) return;
      const running = Array.from(jobs.values());
      await send(snap ? { visible: true, icon: ICON, ...describe(snap, running.length ? running[running.length - 1] : null) } : HIDDEN);
    } finally {
      busy = false;
      lastAt = Date.now();   // the next render waits a full interval after this one has been sent
      if (again) { again = false; schedule(); }
    }
  }

  async function unwatch() {
    const was = watching;
    watching = null; root = null; snap = null; jobs.clear();
    if (was) { try { await engine.call('repo.unsubscribe', { repo: was }, { client: ENGINE_CLIENT }); } catch (e) { /* gone */ } }
  }

  async function run() {
    let res;
    try { res = await resolve(); } catch (e) { res = { status: 'error' }; }
    if (closed) return;
    const folder = res && res.status === 'local' && typeof res.path === 'string' ? res.path : null;
    if (folder && folder === watching) { schedule(); return; }
    await unwatch();
    if (folder) {
      try {
        const out = await engine.call('repo.subscribe', { repo: folder }, { client: ENGINE_CLIENT });
        if (closed) return;
        watching = folder; root = out.root; dirty = true;
      } catch (e) {
        // not a repository (or gone): hidden; the next focus event tries again
      }
    }
    schedule();
  }

  /** Asks the focus again; calls made while one waits to start share it. Resolves when it has been applied. */
  function refocus() {
    if (closed) return chain;
    if (queued) return chain;
    queued = true;
    chain = chain.then(() => { queued = false; return run(); }).catch((e) => log('status bar: ' + String((e && e.message) || e).slice(0, 200)));
    return chain;
  }

  return {
    refocus,
    /** Tests: what the item watches and how often it talked to Orca. */
    stats: () => ({ watching, root, jobs: jobs.size, sent, pending: !!timer || busy }),
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer); timer = null;
      offs.forEach((off) => { try { off(); } catch (e) { /* gone */ } });
      try { engine.dropClient(ENGINE_CLIENT); } catch (e) { /* engine closed */ }
      watching = null; root = null; jobs.clear();
    },
  };
}
