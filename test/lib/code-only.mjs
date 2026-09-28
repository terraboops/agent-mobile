/**
 * code-only — strip comments and collapse whitespace, so two versions of a file can be compared
 * on what they DO rather than on what they say.
 *
 * A mutation-table entry that edits a comment still "changes the file", still applies cleanly,
 * and still counts as covered — while testing nothing. Four of my own entries sat mistargeted
 * for hours with the count looking complete, and one of them literally appended `// ` to a
 * declaration and changed no behaviour at all. Comparing the code-only projection of before and
 * after is what tells those apart from a real edit.
 *
 * It is a small state machine rather than a regex because regexes get this wrong on the cases
 * that matter: `'http://example'` is a string containing a comment marker, and `"#hash"` is a
 * string containing a Python one. A naive strip mangles both and reports a difference where
 * there is none, or none where there is one.
 *
 * KNOWN LIMIT, recorded rather than hidden: a Python docstring is a string LITERAL, not a
 * comment, so a docstring-only edit reads as a code change here and would be accepted. That is
 * the conservative direction — it risks accepting a weak mutation, never rejecting a real one.
 */

export function codeOnly(text, lang) {
  const s = String(text || '');
  let out = '';
  let i = 0;
  const n = s.length;

  const isJs = lang === 'js';
  const isPy = lang === 'py';
  const isHtml = lang === 'html';

  while (i < n) {
    const c = s[i];
    const next = s[i + 1];

    /* ---- strings: copied through verbatim, never scanned for comment markers ---- */
    if (c === '"' || c === "'" || (isJs && c === '`')) {
      /* Python triple quotes: consume as one literal so an apostrophe inside cannot end it. */
      if (isPy && next === c && s[i + 2] === c) {
        const q = c.repeat(3);
        const end = s.indexOf(q, i + 3);
        const stop = end === -1 ? n : end + 3;
        out += s.slice(i, stop);
        i = stop;
        continue;
      }
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        if (s[i] === '\\') { out += s.slice(i, i + 2); i += 2; continue; }
        out += s[i];
        if (s[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }

    /* ---- comments: dropped ---- */
    if (isJs && c === '/' && next === '/') {
      while (i < n && s[i] !== '\n') i++;
      continue;
    }
    if (isJs && c === '/' && next === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (isPy && c === '#') {
      while (i < n && s[i] !== '\n') i++;
      continue;
    }
    if (isHtml && s.startsWith('<!--', i)) {
      const end = s.indexOf('-->', i + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    /* An HTML file carries JS and CSS too; honour their comment syntax inside it. */
    if (isHtml && c === '/' && next === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }

    /* Collapse runs of whitespace HERE, in code only. Doing it globally at the end squashed
     * spaces inside string literals too, where they are meaningful: a mutation that changed
     * `'[sidecar] '` to `'[sidecar]  '` compared equal and was wrongly reported cosmetic. */
    if (/\s/.test(c)) {
      if (!/\s$/.test(out) && out.length) out += ' ';
      i++;
      continue;
    }
    out += c;
    i++;
  }

  return out.trim();
}

/** Pick the comment syntax from a path. */
export function langOf(path) {
  if (/\.(mjs|js)$/.test(path)) return 'js';
  if (/\.py$/.test(path)) return 'py';
  if (/\.html?$/.test(path)) return 'html';
  return 'js';
}
