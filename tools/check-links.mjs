#!/usr/bin/env node
// Checks relative links in the repository's Markdown files (no dependencies).
//
//   node tools/check-links.mjs [--verbose]
//
// Scans every *.md (skips node_modules, .git, app/stable and hardware/, which is owned by the hardware
// work and reorganised separately) and fails (exit 1) when an inline link `[text](target)`, a reference
// definition `[id]: target` or an autolink-free `<img src>` points to a relative path that does not exist.
// A `#anchor` is stripped: only the existence of the target FILE is checked. Absolute URLs (http, https,
// mailto, ...) are ignored. Fenced code blocks and inline code spans are ignored.

import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git']);
const SKIP_PATHS = ['app/stable', 'hardware']; // relative to ROOT, forward slashes
const verbose = process.argv.includes('--verbose');

function toPosix(p) { return p.split(sep).join('/'); }

function isSkipped(rel) {
  return SKIP_PATHS.some((s) => rel === s || rel.startsWith(s + '/'));
}

function findMarkdown(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const rel = toPosix(relative(ROOT, full));
    if (isSkipped(rel)) continue;
    const st = statSync(full);
    if (st.isDirectory()) findMarkdown(full, out);
    else if (name.toLowerCase().endsWith('.md')) out.push(full);
  }
  return out;
}

function stripCode(text) {
  // fenced blocks (``` or ~~~), keeping line count so reported line numbers stay right
  const lines = text.split('\n');
  let fence = null;
  const kept = lines.map((line) => {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (m) {
      if (!fence) { fence = m[1][0]; return ''; }
      if (m[1][0] === fence) { fence = null; return ''; }
    }
    return fence ? '' : line.replace(/`[^`\n]*`/g, (s) => ' '.repeat(s.length));
  });
  return kept;
}

const LINK_PATTERNS = [
  /!?\[(?:[^\]\\]|\\.)*\]\(\s*(<[^>]*>|[^)\s]*)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g, // [t](url "title")
  /^\s{0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/g, // [id]: url
  /<img\b[^>]*\bsrc="([^"]+)"/g,
];

function isExternal(target) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) || target.startsWith('//');
}

const problems = [];
let checked = 0;
const files = findMarkdown(ROOT);

for (const file of files) {
  const lines = stripCode(readFileSync(file, 'utf8'));
  lines.forEach((line, i) => {
    for (const re of LINK_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line))) {
        let target = m[1];
        if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
        if (!target || target.startsWith('#') || isExternal(target)) continue;
        const pathPart = target.split('#')[0].split('?')[0];
        if (!pathPart) continue;
        let decoded = pathPart;
        try { decoded = decodeURIComponent(pathPart); } catch { /* keep raw */ }
        const abs = decoded.startsWith('/') ? join(ROOT, decoded) : resolve(dirname(file), decoded);
        checked += 1;
        if (!existsSync(abs)) {
          problems.push(`${toPosix(relative(ROOT, file))}:${i + 1}: broken link -> ${target}`);
        } else if (verbose) {
          console.log(`ok  ${toPosix(relative(ROOT, file))}:${i + 1} -> ${target}`);
        }
      }
    }
  });
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\ncheck-links: ${problems.length} broken link(s) in ${files.length} Markdown files (${checked} relative links checked)`);
  process.exit(1);
}
console.log(`check-links: ${files.length} Markdown files, ${checked} relative links, all targets exist`);
