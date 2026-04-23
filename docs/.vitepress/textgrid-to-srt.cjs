#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function usage() {
  console.log('Usage: node textgrid-to-srt.cjs [articleTtsDir]');
  console.log('Default: docs/public/tts/书/决定自由');
}

const arg = process.argv[2];
const repoRoot = path.resolve(__dirname, '..', '..');
const defaultDir = path.join(repoRoot, 'docs', 'public', 'tts', '书', '决定自由');
const articleDir = arg ? path.resolve(arg) : defaultDir;

if (!fs.existsSync(articleDir) || !fs.statSync(articleDir).isDirectory()) {
  console.error('Article TTS directory not found:', articleDir);
  usage();
  process.exit(1);
}

const mfaDir = path.join(articleDir, 'mfa_output');
if (!fs.existsSync(mfaDir) || !fs.statSync(mfaDir).isDirectory()) {
  console.error('mfa_output directory not found in', articleDir);
  process.exit(1);
}

function parseTextGrid(content) {
  // Find the IntervalTier named "words" and extract its intervals only.
  const items = [];

  // Split into item blocks and find the one with name = "words" and class = IntervalTier
  const itemRegex = /item \[\d+\]:([\s\S]*?)(?=item \[\d+\]:|$)/g;
  let itemMatch;
  let wordsBlock = null;
  while ((itemMatch = itemRegex.exec(content)) !== null) {
    const block = itemMatch[1];
    const isIntervalTier = /class\s*=\s*"IntervalTier"/i.test(block);
    const nameMatch = /name\s*=\s*"([^"]+)"/i.exec(block);
    const name = nameMatch ? nameMatch[1] : null;
    if (isIntervalTier && name && name.toLowerCase() === 'words') {
      wordsBlock = block;
      break;
    }
  }

  if (!wordsBlock) return items;

  // Now extract each 'intervals [N]:' block inside the wordsBlock
  const intervalBlockRegex = /intervals \[\d+\]:([\s\S]*?)(?=intervals \[\d+\]:|$)/g;
  let blockMatch;
  while ((blockMatch = intervalBlockRegex.exec(wordsBlock)) !== null) {
    const block = blockMatch[1];
    const fieldRegex = /xmin\s*=\s*([0-9.eE+-]+)[\s\S]*?xmax\s*=\s*([0-9.eE+-]+)[\s\S]*?text\s*=\s*"([\s\S]*?)"/i;
    const f = fieldRegex.exec(block);
    if (f) {
      const start = parseFloat(f[1]);
      const end = parseFloat(f[2]);
      let text = f[3] || '';
      text = text.replace(/\\"/g, '"').replace(/\\n/g, '\n').trim();
      // Only include non-empty word-level entries
      if (text) items.push({ start, end, text });
    }
  }

  return items;
}

function secToSrtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const ms = Math.round(s * 1000);
  const hh = Math.floor(ms / 3600000);
  const mm = Math.floor((ms % 3600000) / 60000);
  const ss = Math.floor((ms % 60000) / 1000);
  const mmm = ms % 1000;
  return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')},${String(mmm).padStart(3,'0')}`;
}

function findMatchingAudio(articleDir, baseName) {
  const exts = ['.orig.wav', '.wav', '.orig.mp3', '.mp3', '.m4a', '.ogg'];
  const files = fs.readdirSync(articleDir);
  for (const e of exts) {
    const candidate = baseName + e;
    if (files.includes(candidate)) return candidate;
  }
  // try any file that starts with baseName
  const any = files.find(f => f.startsWith(baseName + '.')) || files.find(f => f.startsWith(baseName));
  return any || null;
}

const tgFiles = fs.readdirSync(mfaDir).filter(f => f.endsWith('.TextGrid') || f.endsWith('.textgrid'));
if (!tgFiles.length) {
  console.log('No TextGrid files found in', mfaDir);
  process.exit(0);
}

for (const tg of tgFiles) {
  try {
    const tgPath = path.join(mfaDir, tg);
    const content = fs.readFileSync(tgPath, 'utf8');
    const items = parseTextGrid(content);

    const base = path.basename(tg, path.extname(tg));
    const audioMatch = findMatchingAudio(articleDir, base);
    const outName = base + '.orig.srt';
    const outPath = path.join(articleDir, outName);

    const lines = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const text = (it.text || '').trim();
      // Skip empty intervals
      if (!text) continue;
      const idx = lines.length + 1;
      lines.push(String(idx));
      lines.push(`${secToSrtTime(it.start)} --> ${secToSrtTime(it.end)}`);
      lines.push(text.replace(/\r?\n/g, '\n'));
      lines.push('');
    }

    const header = audioMatch ? `# Derived from ${tg} (matched audio: ${audioMatch})\n` : `# Derived from ${tg}\n`;
    fs.writeFileSync(outPath, header + lines.join('\n'), 'utf8');
    console.log('Wrote', outPath, 'entries:', lines.length ? (lines.length/4) : 0);
  } catch (e) {
    console.error('Failed processing', tg, e?.message || e);
  }
}

console.log('Done.');
