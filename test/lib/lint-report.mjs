/**
 * lint-report — read Android lint's XML into records.
 *
 * WHY IT IS A MODULE. It was inlined in android-lint.test.mjs, and the only assertion standing
 * over it was `issues.length >= 0 && xml.includes('<issues')` — a length is never negative, so
 * the whole condition reduced to "the file contains that string" and the regex could have
 * matched nothing at all. A lint gate that reports zero violations because it stopped parsing
 * is indistinguishable from a clean build, which is the worst shape a gate can take.
 *
 * Inlined, it could not be mutated either: an entry pointed at a suite's own file is refused,
 * correctly, because mutating an assertion cannot fail the suite that owns it. Out here it is
 * ordinary code with ordinary coverage, and the suite can feed it fixtures whose answers are
 * known — including a report with no issues at all, which is a legitimate outcome and must not
 * read the same as a broken parser.
 */

/** Every <issue> in the report, as {id, severity, message}. */
export function parseLintIssues(xml) {
  return [...String(xml || '').matchAll(/<issue\s+([^>]*?)>/gs)].map((m) => {
    const a = m[1];
    const g = (k) => (new RegExp(`${k}="([^"]*)"`).exec(a) || [])[1];
    return { id: g('id'), severity: g('severity'), message: g('message') };
  });
}

/** How many <issue> tags the document actually contains, counted independently of the parse. */
export function countIssueTags(xml) {
  return (String(xml || '').match(/<issue\s/g) || []).length;
}

/** Does this look like a lint report at all, rather than a truncated or unrelated file? */
export function looksLikeReport(xml) {
  return /<issues\b/.test(String(xml || ''));
}

/**
 * The file:line locations for one issue id, with the package prefix trimmed so a violation can
 * be pointed at in a sentence.
 */
export function locationsFor(xml, id) {
  return [...String(xml || '').matchAll(new RegExp(`<issue\\s+id="${id}"[\\s\\S]*?</issue>`, 'g'))]
    .flatMap((blk) => [...blk[0].matchAll(/file="([^"]*)"\s*(?:line="(\d+)")?/g)]
      .map((l) => `${l[1].replace(/.*\/com\/agentmobile\/agent\//, '')}${l[2] ? ':' + l[2] : ''}`));
}
