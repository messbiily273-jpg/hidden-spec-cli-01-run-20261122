// mend — the CLI SPEC.md specifies. Written in-session for make.fun's
// hidden-spec-cli-01 bounty (agent/v1). Node 22, standard library alone.
// Run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below): the hand-over
// and runner.ts stay as the kit has them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** Patch lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its line break, its lines, whether it ends with a break. */
type LineFile = { br: string; lines: string[]; final: boolean };

function parseLines(text: string): LineFile {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const body = final ? text.slice(0, -br.length) : text;
  return { br, lines: body === '' ? [''] : body.split(br), final };
}

function serialize(f: LineFile): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted). */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  final(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** One line of an old/new pair: text, and whether it is a context line. */
type Item = { text: string; ctx: boolean };

/** Matching key of a line at a tier: 0 exact, 1 trailing ws off, 2 both ends off. */
function keyAt(tier: number, line: string): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O occurs in lines at a tier (overlaps allowed). */
function occurrences(O: string[], lines: string[], tier: number): number[] {
  const res: number[] = [];
  if (O.length === 0 || O.length > lines.length) return res;
  for (let i = 0; i + O.length <= lines.length; i++) {
    let good = true;
    for (let j = 0; j < O.length; j++) {
      if (keyAt(tier, lines[i + j]!) !== keyAt(tier, O[j]!)) { good = false; break; }
    }
    if (good) res.push(i);
  }
  return res;
}

/** The first tier at which O occurs at least once (strict: tier 0 only). */
function findTier(O: string[], lines: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(O, lines, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/**
 * Build the replacement lines for a match at pos. Context lines of N are the
 * file's own matched lines; at tier 2 every other line of N is re-indented
 * from the patch's first-line indent P to the file's first-line indent F.
 */
function buildNew(lines: string[], pos: number, oItems: Item[], nItems: Item[], tier: number): string[] {
  const ctxTexts: string[] = [];
  for (let k = 0; k < oItems.length; k++) if (oItems[k]!.ctx) ctxTexts.push(lines[pos + k]!);
  let ci = 0;
  const raw: string[] = [];
  for (const it of nItems) raw.push(it.ctx ? ctxTexts[ci++]! : it.text);
  if (tier === 2 && oItems.length > 0) {
    const F = /^[ \t]*/.exec(lines[pos]!)![0];
    const P = /^[ \t]*/.exec(oItems[0]!.text)![0];
    return raw.map((t, idx) => {
      if (nItems[idx]!.ctx) return t;
      if (t !== '' && t.trim() !== '' && t.startsWith(P)) return F + t.slice(P.length);
      return t;
    });
  }
  return raw;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = parseLines(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, serialize(f));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

type BodyItem = { kind: ' ' | '-' | '+' | '\\'; text: string };
type Hunk = { a: number; body: BodyItem[]; slashAfterLastCtxAdd: boolean };

function hunkItems(h: Hunk): { oItems: Item[]; nItems: Item[] } {
  const oItems: Item[] = [];
  const nItems: Item[] = [];
  for (const b of h.body) {
    if (b.kind === ' ') { oItems.push({ text: b.text, ctx: true }); nItems.push({ text: b.text, ctx: true }); }
    else if (b.kind === '-') oItems.push({ text: b.text, ctx: false });
    else if (b.kind === '+') nItems.push({ text: b.text, ctx: false });
  }
  return { oItems, nItems };
}

type UniSection = {
  oldPath: string | null;
  newPath: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
};

/** Path after `--- `/`+++ `: text after 4 chars, up to first tab, trimmed, a/ or b/ removed. */
function headerPath(l: string): string {
  const t = l.slice(4).split('\t')[0]!.trim();
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
  return t;
}

function parseHunkHeader(l: string, no: number): number {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
  if (m === null) throw new Exit2(`error: parse ${no}`);
  return Number(m[1]);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let i = 0;
  const n = lines.length;
  const isSectionStart = (j: number): boolean =>
    lines[j]!.startsWith('diff --git ') ||
    (lines[j]!.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ '));
  while (i < n) {
    const l = lines[i]!;
    let sec: UniSection | null = null;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = { oldPath: m[1]!, newPath: m[2]!, creation: false, deletion: false, hunks: [] };
      i += 1;
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      sec = { oldPath: headerPath(l), newPath: headerPath(lines[i + 1]!), creation: false, deletion: false, hunks: [] };
      i += 2;
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
      continue;
    }
    // Header: lines before the first hunk.
    let hOld: string | null = null;
    let hNew: string | null = null;
    let rOld: string | null = null;
    let rNew: string | null = null;
    let sawPair = sec.oldPath !== null && sec.newPath !== null && !l.startsWith('diff --git ');
    while (i < n) {
      const h = lines[i]!;
      if (h.startsWith('@@')) break;
      if (h.startsWith('diff --git ')) break;
      if (h.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (sawPair) break;
          hOld = headerPath(h);
          hNew = headerPath(lines[i + 1]!);
          sawPair = true;
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (h.startsWith('rename from ')) { rOld = h.slice('rename from '.length).trim(); i += 1; continue; }
      if (h.startsWith('rename to ')) { rNew = h.slice('rename to '.length).trim(); i += 1; continue; }
      if (h.startsWith('new file mode')) { sec.creation = true; i += 1; continue; }
      if (h.startsWith('deleted file mode')) { sec.deletion = true; i += 1; continue; }
      i += 1;
    }
    if (hOld !== null) sec.oldPath = hOld;
    if (hNew !== null) sec.newPath = hNew;
    if (sec.oldPath === null) sec.oldPath = rOld;
    if (sec.newPath === null) sec.newPath = rNew;
    // Hunks.
    while (i < n) {
      const h = lines[i]!;
      if (isSectionStart(i)) break;
      if (!h.startsWith('@@')) { i += 1; continue; }
      const a = parseHunkHeader(h, i + 1);
      i += 1;
      const body: BodyItem[] = [];
      while (i < n) {
        const b = lines[i]!;
        if (isSectionStart(i)) break;
        if (b === '') { body.push({ kind: ' ', text: '' }); i += 1; continue; }
        const c = b[0]!;
        if (c === ' ' || c === '-' || c === '+' || c === '\\') { body.push({ kind: c, text: b.slice(1) }); i += 1; continue; }
        break;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === ' ' && body[body.length - 1]!.text === '') body.pop();
      let slashAfter = false;
      for (let k = body.length - 1; k >= 0; k--) {
        if (body[k]!.kind === ' ' || body[k]!.kind === '+') {
          slashAfter = body[k + 1] !== undefined && body[k + 1]!.kind === '\\';
          break;
        }
      }
      sec.hunks.push({ a, body, slashAfterLastCtxAdd: slashAfter });
    }
    sections.push(sec);
  }
  return sections.map((sec) => unifiedEdit(sec, strict));
}

function unifiedEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    const isCreation = oldP === '/dev/null' || sec.creation;
    const isDeletion = newP === '/dev/null' || sec.deletion;
    if (isCreation) {
      const p = newP ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let slashAfterLast = false;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.body.length; k++) {
          if (h.body[k]!.kind === '+') {
            plus.push(h.body[k]!.text);
            slashAfterLast = h.body[k + 1] !== undefined && h.body[k + 1]!.kind === '\\';
          }
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (slashAfterLast ? '' : '\n'));
      return;
    }
    if (isDeletion) {
      const p = oldP ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const isMove = oldP !== null && newP !== null && oldP !== newP;
    const src = oldP ?? '';
    const dst = isMove ? newP! : src;
    if (!safe(src)) throw new Fail('unsafe', src);
    if (isMove && !safe(dst)) throw new Fail('unsafe', dst);
    const cur = tree.get(src);
    if (cur === null) throw new Fail('missing', src);
    if (isMove && tree.get(dst) !== null) throw new Fail('exists', dst);
    const f = parseLines(cur);
    let d = 0;
    for (const h of sec.hunks) {
      const { oItems, nItems } = hunkItems(h);
      if (oItems.length === 0) {
        const at = Math.min(h.a + d, f.lines.length);
        const atEnd = at === f.lines.length;
        f.lines.splice(at, 0, ...nItems.map((x) => x.text));
        if (atEnd) f.final = !h.slashAfterLastCtxAdd;
        d += nItems.length;
        continue;
      }
      const oTexts = oItems.map((x) => x.text);
      const found = findTier(oTexts, f.lines, strict);
      if (found === null) throw new Fail('no-match', src);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) { best = p; bestDist = dist; }
      }
      const oldLen = f.lines.length;
      const ranToEnd = best + oItems.length === oldLen;
      const repl = buildNew(f.lines, best, oItems, nItems, found.tier);
      f.lines.splice(best, oItems.length, ...repl);
      if (ranToEnd) f.final = !h.slashAfterLastCtxAdd;
      d += nItems.length - oItems.length;
    }
    const out = serialize(f);
    if (isMove) {
      tree.now.set(src, null);
      tree.now.set(dst, out);
      tree.moves.push([src, dst]);
    } else {
      tree.now.set(src, out);
    }
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevPath: string | null = null;
  let prevReplaceEnd = -1;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i += 1; continue; }
    const searchNo = i + 1;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') { eq = j; break; }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchNo}`);
    let path: string | null = null;
    for (let j = i - 1; j > prevReplaceEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchNo}`);
      path = prevPath;
    }
    prevPath = path;
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const f = parseLines(cur);
    const found = findTier(oldLines, f.lines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const pos = found.pos[0]!;
    const repl = buildNew(
      f.lines, pos,
      oldLines.map((t) => ({ text: t, ctx: false })),
      newLines.map((t) => ({ text: t, ctx: false })),
      found.tier,
    );
    f.lines.splice(pos, oldLines.length, ...repl);
    tree.now.set(path, serialize(f));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

type V4aChunk = { anchor: string | null; eof: boolean; body: BodyItem[] };

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) { last = k; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) { i += 1; continue; }
    if (l.startsWith('*** Add File:')) {
      const p = l.slice('*** Add File:'.length).trim();
      i += 1;
      const secLines: string[] = [];
      while (i < last) {
        const l2 = lines[i]!;
        if (isSectionStart(l2) || l2.trim() === '*** End Patch') break;
        if (l2.startsWith('+')) { secLines.push(l2.slice(1)); i += 1; continue; }
        if (blank(l2)) { secLines.push(''); i += 1; continue; }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (secLines.length > 0 && secLines[secLines.length - 1] === '') secLines.pop();
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, secLines.length === 0 ? '' : secLines.join('\n') + '\n');
      });
      continue;
    }
    if (l.startsWith('*** Delete File:')) {
      const p = l.slice('*** Delete File:'.length).trim();
      i += 1;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    if (l.startsWith('*** Update File:')) {
      const p = l.slice('*** Update File:'.length).trim();
      const updateNo = i + 1;
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to:')) {
        moveTo = lines[i]!.slice('*** Move to:'.length).trim();
        i += 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      const closeChunk = (): void => {
        if (cur !== null) { chunks.push(cur); cur = null; }
      };
      while (i < last) {
        const l2 = lines[i]!;
        if (isSectionStart(l2) || l2.trim() === '*** End Patch') break;
        if (l2.startsWith('@@')) {
          closeChunk();
          cur = { anchor: l2.slice(2).trim(), eof: false, body: [] };
          i += 1;
          continue;
        }
        if (l2.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          closeChunk();
          i += 1;
          continue;
        }
        if (l2.startsWith(' ') || l2.startsWith('-') || l2.startsWith('+') || l2 === '') {
          if (cur === null) cur = { anchor: null, eof: false, body: [] };
          cur.body.push({ kind: l2 === '' ? ' ' : (l2[0] as ' ' | '-' | '+'), text: l2 === '' ? '' : l2.slice(1) });
          i += 1;
          continue;
        }
        if (blank(l2)) {
          if (cur !== null) { cur.body.push({ kind: ' ', text: '' }); i += 1; continue; }
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      closeChunk();
      if (chunks.length > 0) {
        const lc = chunks[chunks.length - 1]!;
        while (lc.body.length > 0 && lc.body[lc.body.length - 1]!.kind === ' ' && lc.body[lc.body.length - 1]!.text === '') lc.body.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateNo}`);
      edits.push(v4aUpdateEdit(p, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = parseLines(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        let foundAt: number | null = null;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          for (let k = cursor; k < f.lines.length; k++) {
            if (keyAt(t, f.lines[k]!) === keyAt(t, ch.anchor)) { foundAt = k; break; }
          }
          if (foundAt !== null) break;
        }
        if (foundAt === null) throw new Fail('no-match', path);
        cursor = foundAt + 1;
      }
      const oItems: Item[] = [];
      const nItems: Item[] = [];
      for (const b of ch.body) {
        if (b.kind === ' ') { oItems.push({ text: b.text, ctx: true }); nItems.push({ text: b.text, ctx: true }); }
        else if (b.kind === '-') oItems.push({ text: b.text, ctx: false });
        else if (b.kind === '+') nItems.push({ text: b.text, ctx: false });
      }
      if (oItems.length === 0) {
        const at = ch.eof ? f.lines.length : cursor;
        f.lines.splice(at, 0, ...nItems.map((x) => x.text));
        cursor = at + nItems.length;
        continue;
      }
      const oTexts = oItems.map((x) => x.text);
      let found: { tier: number; pos: number } | null = null;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const t of tiers) {
        const pos = occurrences(oTexts, f.lines, t).filter((p) => p >= cursor && (!ch.eof || p + oTexts.length === f.lines.length));
        if (pos.length > 0) { found = { tier: t, pos: pos[0]! }; break; }
      }
      if (found === null) throw new Fail('no-match', path);
      const repl = buildNew(f.lines, found.pos, oItems, nItems, found.tier);
      f.lines.splice(found.pos, oItems.length, ...repl);
      cursor = found.pos + repl.length;
    }
    const out = serialize(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

// ---------------------------------------------------------------------------
// Invocation, output and exit codes (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  type Row = { key: string; line: string };
  const rows: Row[] = [];
  const consumedOld = new Set<string>();
  const consumedNew = new Set<string>();
  for (const [o, n] of tree.moves) {
    const wasO = tree.original(o);
    const nowO = tree.final(o);
    const wasN = tree.original(n);
    const nowN = tree.final(n);
    if (wasO !== null && nowO === null && wasN === null && nowN !== null) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      consumedOld.add(o);
      consumedNew.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    if (consumedOld.has(p) || consumedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const outLines = rows.map((r) => r.line);
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
