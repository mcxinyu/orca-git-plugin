/* File icons in the Seti theme (VS Code's default), from the approved prototype's shell (shell-files.js
   iconHTML). Data: ui/vendor/file-icons.js (window.FileIconMaps), font:
   ui/img/file-icons/seti.woff (MIT, SETI-LICENSE.txt), styles: ui/css/shell.css (.ficon).
   Git.fileIcons.html(name) -> HTML string ('' when the theme has no glyph for it). */
(function () {
  'use strict';
  const Git = window.Git;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const memo = new Map();

  /** FileIconRule.iconID: the file name, then every suffix ("a.test.js" -> "test.js", "js"), then the default. */
  function seti(name) {
    const map = window.FileIconMaps && window.FileIconMaps.seti;
    if (!map) return null;
    const lower = name.toLowerCase();
    let id = map.fileNames[lower];
    if (!id) {
      const parts = lower.split('.');
      const suffixes = [];
      for (let i = 1; i < parts.length; i++) suffixes.push(parts.slice(i).join('.'));
      id = suffixes.map((s) => map.fileExtensions[s]).find(Boolean) || suffixes.map((s) => map.languageExtensions[s]).find(Boolean) || map.file;
    }
    return map.glyphs[id] || map.glyphs[map.file] || null;
  }

  Git.fileIcons = {
    html(name) {
      if (memo.has(name)) return memo.get(name);
      const g = seti(name);
      const out = g ? '<span class="ficon ficon-seti" style="color:' + esc(g[1]) + '">' + esc(g[0]) + '</span>' : '';
      if (memo.size > 4000) memo.clear();
      memo.set(name, out);
      return out;
    },
  };
})();
