/* Git Panel: the Blame view of a file's own tab in Orca (hosts/orca/README.md "Blame").
   Orca shows a custom editor of `priority: "option"` in the view toggle of a file's tab, beside Source. Ours
   (panels/blame.html) is the read-only file view with inline blame (ui/git/fileview.js, annotate-inline.js): a click on
   a line shows, after its text, who last changed it; "Annotate with Git Blame" in the gutter menu shows every line.
   Orca hands a custom editor the document, never its path, so the file is found by its text: the engine's
   `file.locate` gets the text's length and hash and answers the work tree files that hold exactly it. One file: it is
   shown. None (unsaved changes, a file outside the repository): a note saying so; the view looks again when Orca sends
   a newer document. Several: the owner picks.
   hosts/orca/panel.js loads this file in the frame (data-view="blame") before git/boot.js and starts the UI as the
   single view `tab`, as it does for the center tab (editor.js). */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = (...a) => Git.t(...a);
  Git.addTR({
    'Looking for this file in the repository…': 'Bu dosya depoda aranıyor…',
    'Blame is not available here': 'Blame burada kullanılamıyor',
    'Orca did not hand this file over as text.': 'Orca bu dosyayı metin olarak vermedi.',
    'The repository could not be searched ({0}).': 'Depoda arama yapılamadı ({0}).',
    'Save the file to see its blame': 'Blame\'i görmek için dosyayı kaydet',
    'No file of this repository has exactly this text. Orca gives a plugin the text of a tab, not its path, so the file is found by its content: unsaved changes hide it.':
      'Bu depoda içeriği birebir bu olan bir dosya yok. Orca eklentiye sekmenin yolunu değil metnini verir, dosya içeriğinden bulunur: kaydedilmemiş değişiklik varken bulunamaz.',
    'Several files have exactly this text': 'Birden çok dosyanın içeriği birebir aynı',
    'Pick the one this tab shows.': 'Bu sekmenin gösterdiği dosyayı seç.',
  });
  Git.views = Git.views || {};

  let body = null;          // the view's element (mount)
  let first = Git.orca && Git.orca.blameDocument;   // the document panel.js asked for at boot
  let run = 0;              // the newest search; an older one's answer is dropped
  let shownKey = null;      // root + text identity of what is shown now

  const documentApi = () => { try { return (window.orca && window.orca.document) || null; } catch (e) { return null; } };
  const textOf = (d) => (d && d.content && typeof d.content.text === 'string' ? d.content.text : null);

  function note(title, text, more) {
    if (!body) return;
    if (Git.pages) Git.pages.closeAll();
    Git.clear(body).appendChild(h('div.wb-tab-empty#wb-blame-note', { role: 'status' },
      h('div.wb-tab-empty-title', title), text ? h('div.wb-tab-empty-text', text) : null, more || null));
  }
  function open(path) {
    if (Git.pages) Git.pages.closeAll();
    // line 1 is the caret row at first, so the view opens with a blame to read
    try { Git.fileView.open(path, { line: 1 }); } catch (e) { console.error(e); }
  }

  /** Finds the file that holds `d`'s text and shows it. */
  async function show(d) {
    const mine = ++run;
    const root = Git.repo.root;
    const text = textOf(d);
    if (!root) return;
    if (text === null) { shownKey = null; note(t('Blame is not available here'), t('Orca did not hand this file over as text.')); return; }
    const id = Git.changesModel.expectOf(text);
    const key = root + '\u0000' + id.length + '\u0000' + id.hash;
    if (key === shownKey) return;
    shownKey = key;
    note(t('Looking for this file in the repository…'));
    const params = { repo: root, length: id.length, hash: id.hash, lines: (text.match(/\n/g) || []).length };
    try { params.bytes = new TextEncoder().encode(text).length; } catch (e) { /* the engine works without it */ }
    if (typeof d.fileType === 'string' && d.fileType && d.fileType.length <= 64 && d.fileType.indexOf('/') < 0) params.suffix = d.fileType;
    let res;
    try { res = await Git.backend.call('file.locate', params); } catch (e) {
      if (mine !== run) return;
      shownKey = null;
      note(t('Blame is not available here'), t('The repository could not be searched ({0}).', (e && (e.message || e.code)) || '?'));
      return;
    }
    if (mine !== run || Git.repo.root !== root) return;
    const paths = (res && res.paths) || [];
    if (paths.length === 1) { open(paths[0]); return; }
    if (!paths.length) {
      note(t('Save the file to see its blame'),
        t('No file of this repository has exactly this text. Orca gives a plugin the text of a tab, not its path, so the file is found by its content: unsaved changes hide it.'));
      return;
    }
    note(t('Several files have exactly this text'), t('Pick the one this tab shows.'),
      h('div.wb-blame-choices', paths.map((p) => h('button.g-link', { type: 'button', 'data-path': p, onclick: () => open(p) }, p))));
  }

  /** The document as it is now: the one asked for at boot the first time, a fresh read after that. */
  function current() {
    const wait = first;
    first = null;
    if (wait) return wait;
    const api = documentApi();
    return api && typeof api.get === 'function' ? Promise.resolve().then(() => api.get()).catch(() => null) : Promise.resolve(null);
  }

  Git.views.tab = {
    mount(el) {
      body = el;
      shownKey = null;
      current().then(show);
    },
  };

  // Orca sends the document again when the file changes (a save from Source, an agent's edit): look again.
  try {
    const api = documentApi();
    if (api && typeof api.onDidChange === 'function') api.onDidChange((d) => { if (body && Git.repo.root) show(d); });
  } catch (e) { /* an Orca without document events: the view shows what it found at boot */ }
})();
