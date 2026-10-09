#!/usr/bin/env node
// 文案语料检索器。语料根：所属项目/writing-corpus/<源>/原文/。
// 用法：
//   node scripts/corpus-search.mjs q '<正则>' [条数]   检索女性台词（启发式过滤男性台词）
//   node scripts/corpus-search.mjs n '<正则>' [条数]   检索旁白段落
//   node scripts/corpus-search.mjs --selfcheck         自检：抽已知句检索自身并读回偏移核验
//   node scripts/corpus-search.mjs --project <所属项目ID> --corpus <源名> ... --out <回执文件>
// 每条命中输出：语料相对路径、UTF-8 字节偏移、±2 行上下文。
// 偏移语义与服务端 text-sources 核验一致：从文件头起的 UTF-8 字节偏移。
import { readdirSync, readFileSync, openSync, readSync, closeSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registeredProjectPath } from '../server/project-registry.mjs';
import { writingCorpusRoot } from '../server/writing-corpus.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let corpusRootDefault;
const output = [];
const print = (...values) => output.push(values.join(' '));

// 男性台词特征 / 女性语气特征（沿用原 /tmp/corpus.mjs 启发式）
const MALE = /给老子|老子|本大爷|你这(婊|骚|母|臭|贱)|肏死你|我踏马|操你|妈的|给爷|大爷我|给我(趴|撅|跪|舔)|臭婊子/;
const FEMALE = /♡|❤|人家|在下|咿|齁|嗯|啊|哦|唔|呜|哈|呼|请|~|～|…/;
const QUOTE_SPAN = /「([^」]*)」|"([^"]*)"|“([^”]*)”|『([^』]*)』/g;
const QUOTE_TEST = /「[^」]*」|"[^"]*"|“[^”]*”|『[^』]*』/;

function parseArgs(argv) {
  const args = [...argv];
  const option = name => { const index = args.indexOf(name); if(index < 0) return undefined; const value = args[index + 1]; if (!value || value.startsWith('--')) throw new Error(`${name} 缺少值`); args.splice(index, 2); return value; };
  const projectId = option('--project'), corpusName = option('--corpus'), out = option('--out');
  if (!projectId) throw new Error('必须用 --project 指定语料所属项目；不自动扫描其他项目');
  corpusRootDefault = writingCorpusRoot(registeredProjectPath(repoRoot, projectId));
  const sources = readdirSync(corpusRootDefault, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => entry.name);
  if (!corpusName && sources.length !== 1) throw new Error('请用 --corpus 指定语料源');
  return { corpusName: corpusName ?? sources[0], rest: args, out };
}

function corpusDirOf(corpusName) {
  const dir = path.resolve(corpusRootDefault, corpusName, '原文');
  if (!dir.startsWith(corpusRootDefault + path.sep)) {
    throw new Error(`非法语料源名：${corpusName}`);
  }
  return dir;
}

function listBooks(dir) {
  return readdirSync(dir).filter((f) => f.endsWith('.txt')).sort();
}

// 从一本书中提取候选条目：{ text, offset }，offset 为 UTF-8 字节偏移。
// kind = 'q' 取引号内台词；kind = 'n' 取整段（行）。
function extractEntries(buffer, kind) {
  const text = buffer.toString('utf8');
  const entries = [];
  if (kind === 'q') {
    for (const m of text.matchAll(QUOTE_SPAN)) {
      const span = m[1] ?? m[2] ?? m[3] ?? m[4];
      if (!span) continue;
      const charIndex = m.index + m[0].indexOf(span);
      const offset = Buffer.byteLength(text.slice(0, charIndex), 'utf8');
      entries.push({ text: span, offset });
    }
  } else {
    // 逐行扫描，显式处理 \r\n / \n / \r，保证字符索引精确
    let pos = 0;
    while (pos <= text.length) {
      let nl = text.indexOf('\n', pos);
      if (nl === -1) nl = text.length;
      let line = text.slice(pos, nl);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      const trimmed = line.trim();
      if (trimmed && !QUOTE_TEST.test(trimmed)) {
        const start = pos + (line.length - line.trimStart().length);
        entries.push({ text: trimmed, offset: Buffer.byteLength(text.slice(0, start), 'utf8') });
      }
      pos = nl + 1;
    }
  }
  return entries;
}

// 按字节偏移读回，核验该处文本以 sentence 开头（与服务端核验同一语义）。
export function verifyAtOffset(filePath, offset, sentence) {
  const fd = openSync(filePath, 'r');
  try {
    const len = Buffer.byteLength(sentence, 'utf8');
    const buf = Buffer.alloc(len);
    const got = readSync(fd, buf, 0, len, offset);
    return got === len && buf.toString('utf8') === sentence;
  } finally {
    closeSync(fd);
  }
}

function contextAround(buffer, offset, sentenceBytes, radius = 2) {
  const text = buffer.toString('utf8');
  const charIndex = buffer.slice(0, offset).toString('utf8').length;
  const lines = text.split(/\r?\n/);
  let acc = 0;
  let hitLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const end = acc + lines[i].length;
    if (charIndex <= end) { hitLine = i; break; }
    acc = end + 1;
  }
  const from = Math.max(0, hitLine - radius);
  const to = Math.min(lines.length - 1, hitLine + radius);
  return lines.slice(from, to + 1).map((l, i) => {
    const isHit = from + i === hitLine;
    const mark = isHit ? '>' : ' ';
    const cap = isHit ? 600 : 150;
    const s = l.length > cap ? l.slice(0, cap) + '…' : l;
    return `  ${mark} ${s}`;
  }).join('\n');
}

function passQuoteFilters(t) {
  if (MALE.test(t)) return false;
  if (!FEMALE.test(t)) return false;
  const len = [...t].length;
  return len >= 3 && len <= 90;
}

function search(corpusName, kind, pattern, limit) {
  const dir = corpusDirOf(corpusName);
  const re = new RegExp(pattern);
  const seen = new Set();
  const hits = [];
  for (const book of listBooks(dir)) {
    const buffer = readFileSync(path.join(dir, book));
    for (const e of extractEntries(buffer, kind)) {
      if (!re.test(e.text) || seen.has(e.text)) continue;
      if (kind === 'q' && !passQuoteFilters(e.text)) continue;
      seen.add(e.text);
      hits.push({ book, ...e, buffer });
    }
  }
  print(`命中 ${hits.length} 条（显示 ${Math.min(limit, hits.length)}）\n`);
  for (const h of hits.slice(0, limit)) {
    const rel = `${corpusName}/原文/${h.book}`;
    const shown = h.text.length > 220 ? h.text.slice(0, 220) + '…' : h.text;
    print(`[${rel}]`);
    print(`offset: ${h.offset}`);
    print(`句子: ${shown}`);
    print(contextAround(h.buffer, h.offset, Buffer.byteLength(h.text, 'utf8')));
    print('');
  }
}

function selfcheck(corpusName) {
  const dir = corpusDirOf(corpusName);
  const books = listBooks(dir);
  if (books.length === 0) {
    console.error('自检失败：语料目录为空');
    process.exit(1);
  }
  let checked = 0;
  for (const book of books.slice(0, 5)) {
    const filePath = path.join(dir, book);
    const buffer = readFileSync(filePath);
    for (const kind of ['q', 'n']) {
      const minLen = kind === 'q' ? 5 : 10;
      const entries = extractEntries(buffer, kind).filter((e) => [...e.text].length >= minLen);
      if (entries.length === 0) continue;
      const sample = entries[Math.floor(entries.length / 2)];
      // 用同一抽取路径找回去
      const found = extractEntries(buffer, kind).some((e) => e.text === sample.text && e.offset === sample.offset);
      // 按偏移读回核验
      const readBack = verifyAtOffset(filePath, sample.offset, sample.text);
      if (!found || !readBack) {
        console.error(`自检失败：${book} (${kind}) 抽样句无法找回或偏移读回不一致（found=${found} readBack=${readBack}）`);
        process.exit(1);
      }
      checked++;
    }
  }
  if (checked === 0) {
    console.error('自检失败：无可抽样条目');
    process.exit(1);
  }
  print(`自检通过：${checked} 本书抽样句均可按偏移读回。`);
}

const { corpusName, rest, out } = parseArgs(process.argv.slice(2));
if (rest[0] === '--selfcheck') {
  selfcheck(corpusName);
} else {
  const [kind, pattern, n] = rest;
  if (!['q', 'n'].includes(kind) || !pattern) {
    console.error('用法：corpus-search.mjs --project <所属项目ID> [--corpus <源名>] <q|n> \'<正则>\' [条数] | --selfcheck [--out <回执文件>]');
    process.exit(2);
  }
  search(corpusName, kind, pattern, Number(n) || 20);
}
if (out) { mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); writeFileSync(path.resolve(out), output.join('\n') + '\n'); console.log(`回执：${path.resolve(out)}`); }
else console.log(output.join('\n'));
