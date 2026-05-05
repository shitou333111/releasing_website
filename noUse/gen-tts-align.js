#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PAUSE_TOKEN = '\n';

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

function readJsonSafe(p) { try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch { return null; } }

function listChunks(articleOutputDir) {
  if (!fs.existsSync(articleOutputDir)) return [];
  const files = fs.readdirSync(articleOutputDir);
  const chunks = files
    .filter(f => /^chunk-\d{3}\.orig\.wav$/i.test(f))
    .map(f => ({ wav: path.join(articleOutputDir, f), base: f.replace('.orig.wav','') }))
    .sort((a,b) => a.base.localeCompare(b.base));
  return chunks;
}

async function postToGentle(gentleUrl, audioBuffer, transcript) {
  const url = gentleUrl.replace(/\/$/,'') + '/transcriptions?async=false';
  const form = new FormData();
  const blob = new Blob([audioBuffer], { type: 'audio/wav' });
  form.append('audio', blob, 'chunk.wav');
  form.append('transcript', transcript);
  const res = await fetch(url, { method: 'POST', body: form });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Gentle failed: ${res.status} ${txt.slice(0,200)}`);
  }
  return res.json();
}

function wordsToCues(words, paragraphWordCounts, chunkStartOffsetSec, chunkDurationSec) {
  const cues = [];
  let wi = 0;
  for (let p = 0; p < paragraphWordCounts.length; p++) {
    const target = paragraphWordCounts[p];
    const assigned = [];
    let assignedCount = 0;
    while (wi < words.length && assignedCount < target) {
      const w = words[wi++];
      if (w.start == null || w.end == null) continue;
      assigned.push(w);
      assignedCount++;
    }
    if (assigned.length) {
      cues.push({ start: assigned[0].start, end: assigned[assigned.length-1].end });
    } else {
      cues.push(null);
    }
  }
  // fallback: fill nulls by proportional splitting across chunkDurationSec
  const aligned = cues.map(c => c && { start: c.start, end: c.end });
  const totalWords = paragraphWordCounts.reduce((s,n)=>s+n,0);
  let cursor = 0;
  for (let i = 0; i < aligned.length; i++) {
    if (!aligned[i]) {
      const proportion = paragraphWordCounts[i] / Math.max(1, totalWords);
      const start = chunkStartOffsetSec + cursor * chunkDurationSec;
      const dur = Math.max(0.01, proportion * chunkDurationSec);
      aligned[i] = { start: Number(start.toFixed(3)), end: Number((start + dur).toFixed(3)) };
      cursor += proportion;
    }
  }
  return aligned;
}

function splitParagraphsByToken(text) {
  return text.split(PAUSE_TOKEN).map(s => s.trim()).filter(Boolean);
}

async function run() {
  const targetSource = process.argv[2] || '书/决定自由.md';
  const docsRoot = path.resolve(__dirname, '..');
  const outputRoot = path.resolve(docsRoot, 'public/tts');
  const sourceRelative = targetSource.replace(/\\\\/g, '/').replace(/^\/+/,'');
  const articleOutputDir = path.join(outputRoot, sourceRelative.replace(/\.md$/i, ''));
  if (!fs.existsSync(articleOutputDir)) throw new Error('Article output dir not found: ' + articleOutputDir);

  const gentleUrl = process.env.GENTLE_URL || process.env.GENTLE_HOST;
  if (!gentleUrl) {
    console.error('GENTLE_URL env is required (e.g. http://localhost:8765)');
    process.exit(1);
  }

  const segmentsFile = path.join(articleOutputDir, 'segments.chunked.json');
  const segmentsJson = readJsonSafe(segmentsFile);
  const segments = Array.isArray(segmentsJson?.segments) ? segmentsJson.segments : (segmentsJson || []).segments || [];

  const chunks = listChunks(articleOutputDir);
  if (!chunks.length) { console.error('No chunk-*.orig.wav files found'); process.exit(1); }

  const allCues = [];
  let segPointer = 0;

  for (const c of chunks) {
    const base = c.base; // 'chunk-001'
    const wavPath = c.wav;
    const txtFixed = path.join(articleOutputDir, base + '.fixed.txt');
    const txtRaw = path.join(articleOutputDir, base + '.txt');
    const transcript = fs.existsSync(txtFixed) ? fs.readFileSync(txtFixed,'utf8') : (fs.existsSync(txtRaw) ? fs.readFileSync(txtRaw,'utf8') : '');
    if (!transcript) { console.warn('No transcript for', base); continue; }

    const paragraphs = splitParagraphsByToken(transcript);
    const paragraphWordCounts = paragraphs.map(p => (p.trim().split(/\s+/).filter(Boolean)).length || 1);

    console.log('Posting', base, 'to Gentle with', paragraphs.length, 'paragraphs');
    const audioBuffer = fs.readFileSync(wavPath);
    let json;
    try {
      json = await postToGentle(gentleUrl, audioBuffer, transcript);
    } catch (e) {
      console.error('Gentle request failed for', base, e.message);
      // fallback: proportional split across chunk duration
      const parsedDuration = 0; // unknown locally; we'll approximate using file size heuristics not implemented here
      // assign proportional cues with zero offsets -> will be corrected when concatenating
      for (let i = 0; i < paragraphs.length; i++) {
        const seg = segments[segPointer++] || { id: `p-unknown-${segPointer}`, cleanText: paragraphs[i] };
        allCues.push({ id: seg.id, start: 0, end: 0, duration: 0, text: seg.cleanText });
      }
      continue;
    }

    const words = Array.isArray(json.words) ? json.words : (json?.words || []);
    // filter aligned words
    const alignedWords = words.filter(w => w.start != null && w.end != null).map(w => ({ start: w.start, end: w.end, word: w.word }));

    // compute approximate chunk duration
    const chunkDuration = alignedWords.length ? (alignedWords[alignedWords.length-1].end - alignedWords[0].start) : 0;

    const mapped = wordsToCues(alignedWords, paragraphWordCounts, 0, chunkDuration);

    // attach ids from segments
    for (let i = 0; i < mapped.length; i++) {
      const seg = segments[segPointer++] || { id: `p-unknown-${segPointer}`, cleanText: paragraphs[i] };
      const m = mapped[i] || { start: 0, end: 0 };
      const dur = Math.max(0, (m.end || 0) - (m.start || 0));
      allCues.push({ id: seg.id, start: Number((m.start||0).toFixed(3)), end: Number((m.end||0).toFixed(3)), duration: Number(dur.toFixed(3)), text: seg.cleanText || paragraphs[i] });
    }
  }

  const outPath = path.join(articleOutputDir, 'cues.chunked.aligned.json');
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, JSON.stringify({ source: targetSource, generatedAt: new Date().toISOString(), cues: allCues }, null, 2) + '\n', 'utf8');
  console.log('Wrote aligned cues to', outPath);
}

if (import.meta.url === `file://${process.argv[1]}`) run().catch(e => { console.error(e); process.exit(1); });
