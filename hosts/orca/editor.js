/* Git Panel: the view of Orca's center tab (hosts/orca/README.md "A center tab for everything a panel opens").
   hosts/orca/panel.js loads it in the custom editor frame (panels/editor.html) when the document is the marker, before
   git/boot.js, and starts the UI as the single view `tab`. The view asks the worker for the repository's current opener
   (`tab.current` → { name, args }, ui/git/openers.js) and runs it here: the first page of the tab, without Back
   (ui/git/pages.js, bare). An opener a panel forwards later (`tab`, relayed by the worker) replaces everything shown;
   what is opened from inside the tab runs here and stacks with Back. Without an opener: a quiet note. Orca re-creates
   this frame whenever the tab shows again, so every boot asks again. */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = (...a) => Git.t(...a);
  Git.addTR({
    'Nothing to show yet': 'Henüz gösterilecek bir şey yok',
    'Double-click a changed file in the Git Log or Commit panel, or open a history or a comparison there, to see it here.':
      'Burada görmek için Git Log ya da Commit panelinde değişen bir dosyaya çift tıkla ya da oradan bir geçmiş veya karşılaştırma aç.',
  });
  Git.views = Git.views || {};
  /** Shows `op` ({ name, args }): everything shown before goes, the opener runs here. */
  function show(op) {
    if (!op || typeof op.name !== 'string' || Git.openers.names().indexOf(op.name) < 0) return;
    if (Git.pages) Git.pages.closeAll();
    try { Git.openers.run(op.name, op.args || {}); } catch (e) { console.error(e); }
  }
  Git.views.tab = {
    mount(el) {
      Git.clear(el).appendChild(h('div.wb-tab-empty#wb-tab-empty', { role: 'status' },
        h('div.wb-tab-empty-title', t('Nothing to show yet')),
        h('div.wb-tab-empty-text', t('Double-click a changed file in the Git Log or Commit panel, or open a history or a comparison there, to see it here.'))));
      const root = Git.repo.root;
      Git.orca.request('tab.current', { root }).then((r) => { if (r && r.opener && Git.repo.root === root) show(r.opener); }, () => { /* the note stays */ });
    },
  };
  Git.orca.onMessage('tab', (d) => { if (d && d.opener && Git.repo.root && d.root === Git.repo.root && Git.workbench.view === 'tab') show(d.opener); });
})();
