#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PAUSE_TOKEN = '\n（沉默片刻）\n';

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

function findChunkTxtFiles(articleOutputDir) {
  if (!fs.existsSync(articleOutputDir)) return [];
  return fs.readdirSync(articleOutputDir)
    .filter(f => /^chunk-\d{3}\.txt$/i.test(f))
    .map(f => path.join(articleOutputDir, f))
    .sort();
}

function normalizeText(raw) {
  if (!raw) return raw;
  // common legacy pause markers seen in repo
  const legacy = [
    /（沉默良久）/g,
    /（沉思一段时间）/g,
    /\.{2,}（沉思一段时间）\.{2,}/g,
    /\.{2,}（沉默良久）\.{2,}/g,
    /（沉默片刻）/g
  ];
  let s = raw.replace(/\r\n/g,'\n');
  for (const r of legacy) s = s.replace(r, PAUSE_TOKEN.trim());
  // ensure pause token sits on its own line
  s = s.replace(new RegExp(`\\s*${PAUSE_TOKEN.trim()}\\s*`, 'g'), PAUSE_TOKEN);
  // collapse repeated tokens
  s = s.replace(new RegExp(`${PAUSE_TOKEN}{2,}`, 'g'), PAUSE_TOKEN);
  return s;
}

function usage() {
  console.log('Usage: node gen-tts-fix-transcripts.js "书/决定自由.md"');
}

async function run() {
  const targetSource = process.argv[2] || '书/决定自由.md';
  const docsRoot = path.resolve(__dirname, '..');
  const outputRoot = path.resolve(docsRoot, 'public/tts');
  const sourceRelative = targetSource.replace(/\\\\/g, '/').replace(/^\/+/,'');
  const articleOutputDir = path.join(outputRoot, sourceRelative.replace(/\.md$/i, ''));

  const files = findChunkTxtFiles(articleOutputDir);
  if (!files.length) {
    console.error('No chunk-*.txt files found in', articleOutputDir);
    process.exit(1);
  }

  let changed = 0;
  for (const f of files) {
    const raw = fs.readFileSync(f, 'utf8');
    const fixed = normalizeText(raw);
    const outPath = f.replace(/\.txt$/i, '.fixed.txt');
    fs.writeFileSync(outPath, fixed, 'utf8');
    console.log('Wrote', path.relative(process.cwd(), outPath));
    if (fixed !== raw) changed++;
  }
  console.log(`Processed ${files.length} files, changed ${changed}`);
}

if (import.meta.url === `file://${process.argv[1]}`) run().catch(e => { console.error(e); process.exit(1); });
