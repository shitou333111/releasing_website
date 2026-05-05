#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import MarkdownIt from 'markdown-it';
import implicitFigures from 'markdown-it-implicit-figures';
import { fileURLToPath } from 'url';
import { cleanTextForTTS } from './readAloudText.js';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Config
const MAX_CHARS_PER_CHUNK = Number(process.env.TTS_CHUNK_MAX_CHARS || 1000);
const PAUSE_TOKEN = '\n';
const MIN_PAUSE_SECONDS = 2.9; // allow small tolerance

const docsRoot = path.resolve(__dirname, '..');
const outputRoot = path.resolve(docsRoot, 'public/tts');
// Load .env-like files from repo root and cwd to populate process.env when needed.
function loadDotEnvFiles() {
  try {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const candidates = [
      path.join(repoRoot, '.env'),
      path.join(repoRoot, '.env.local'),
      path.join(process.cwd(), '.env'),
      path.join(process.cwd(), '.env.local')
    ];
    for (const envPath of candidates) {
      if (!fs.existsSync(envPath)) continue;
      try {
        const content = fs.readFileSync(envPath, 'utf8');
        for (const rawLine of content.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line || line.startsWith('#')) continue;
          const idx = line.indexOf('=');
          if (idx === -1) continue;
          const key = line.slice(0, idx).trim();
          let val = line.slice(idx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (!(key in process.env) || !process.env[key]) {
            process.env[key] = val;
            if (key === 'MIMO_API_KEY') console.log('Loaded MIMO_API_KEY from', envPath);
          }
        }
      } catch (e) {
        console.warn('Unable to read env file', envPath, e?.message || e);
      }
    }
  } catch (e) {
    console.warn('Error loading env files:', e?.message || e);
  }
}
loadDotEnvFiles();
// allow flags like --force; prefer an explicit .md arg if provided
const argMd = process.argv.slice(2).find(a => typeof a === 'string' && a.toLowerCase().endsWith('.md'));
const targetSource = argMd || process.argv[2] || '书/决定自由.md';
const routePath = `/${path.basename(targetSource, '.md')}`;

const md = new MarkdownIt({ html: true });
md.use(implicitFigures, { figcaption: 'Title', keepAlt: true });

const SKIP_MFA = process.argv.includes('--skip-mfa') || process.env.SKIP_MFA === '1';

function ensureDir(dirPath) { if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true }); }
function loadJson(filePath, fallback) { if (!fs.existsSync(filePath)) return fallback; try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; } }
function saveJson(filePath, data) { ensureDir(path.dirname(filePath)); fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8'); }

function isoLocalWithOffset(date) {
  const d = date || new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());
  const ms = String((d.getMilliseconds() || 0)).padStart(3, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const offH = pad(Math.floor(Math.abs(offsetMin) / 60));
  const offM = pad(Math.abs(offsetMin) % 60);
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${ms}${sign}${offH}:${offM}`;
}

function splitFrontmatter(markdown) {
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { frontmatter: {}, body: markdown, lineOffset: 0 };
  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i].trim() === '---') { endIndex = i; break; }
  if (endIndex === -1) return { frontmatter: {}, body: markdown, lineOffset: 0 };
  const frontmatterLines = lines.slice(1, endIndex);
  const frontmatter = {};
  for (const line of frontmatterLines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const colonIndex = line.indexOf(':'); if (colonIndex <= 0) continue;
    const key = line.slice(0, colonIndex).trim(); const rawValue = line.slice(colonIndex + 1);
    frontmatter[key] = rawValue.trim();
  }
  return { frontmatter, body: lines.slice(endIndex + 1).join('\n'), lineOffset: endIndex + 1 };
}

function extractInlineText(inlineToken) {
  const children = Array.isArray(inlineToken.children) ? inlineToken.children : [];
  let text = '';
  for (const child of children) {
    if (child.type === 'image') continue;
    if (child.type === 'text' || child.type === 'code_inline' || child.type === 'html_inline') text += child.content || '';
    if (child.type === 'softbreak' || child.type === 'hardbreak') text += '\n';
  }
  return text;
}

function buildSegments(markdownBody, lineOffset) {
  const tokens = md.parse(markdownBody, {});
  const segments = [];
  let blockquoteDepth = 0;
  let index = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === 'blockquote_open') { blockquoteDepth += 1; continue; }
    if (token.type === 'blockquote_close') { blockquoteDepth = Math.max(0, blockquoteDepth - 1); continue; }
    if (blockquoteDepth > 0) continue;
    const isHeading = token.type === 'heading_open' && /^h[2-6]$/.test(token.tag);
    const isParagraph = token.type === 'paragraph_open';
    if (!isHeading && !isParagraph) continue;
    const inlineToken = tokens[i + 1]; if (!inlineToken || inlineToken.type !== 'inline') continue;
    let rawText = extractInlineText(inlineToken);
    // remove <sup>...</sup> and its contents from extracted inline HTML
    try { rawText = rawText.replace(/<sup\b[^>]*>.*?<\/sup>/gis, ''); } catch (e) { /* ignore if regex unsupported */ }
    const cleanText = cleanTextForTTS(rawText);
    if (!cleanText) continue;
    const segment = {
      id: `p-${String(index + 1).padStart(5, '0')}`,
      index,
      type: isHeading ? 'heading' : 'paragraph',
      tag: isHeading ? token.tag : 'p',
      rawText,
      cleanText
    };
    segments.push(segment); index += 1;
  }
  return segments;
}

// Audio helpers (copied/adapted)
function toBuffer(base64) { return Buffer.from(base64, 'base64'); }

function parseWav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not WAV');
  let offset = 12; let fmt = null; const dataChunks = [];
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkDataStart = offset + 8; const chunkDataEnd = chunkDataStart + chunkSize;
    if (chunkDataEnd > buffer.length) break;
    if (chunkId === 'fmt ') {
      fmt = {
        audioFormat: buffer.readUInt16LE(chunkDataStart),
        channels: buffer.readUInt16LE(chunkDataStart + 2),
        sampleRate: buffer.readUInt32LE(chunkDataStart + 4),
        bitsPerSample: buffer.readUInt16LE(chunkDataStart + 14)
      };
    }
    if (chunkId === 'data') dataChunks.push(buffer.slice(chunkDataStart, chunkDataEnd));
    offset = chunkDataEnd + (chunkSize % 2);
  }
  if (!fmt) throw new Error('WAV missing fmt');
  if (!dataChunks.length) throw new Error('WAV missing data');
  const data = Buffer.concat(dataChunks);
  const blockAlign = fmt.channels * (fmt.bitsPerSample / 8);
  const byteRate = fmt.sampleRate * blockAlign;
  return { ...fmt, blockAlign, byteRate, data };
}

function buildWav(parsed) {
  const subchunk1Size = 16; const dataSize = parsed.data.length; const totalSize = 4 + (8 + subchunk1Size) + (8 + dataSize);
  const buffer = Buffer.alloc(8 + totalSize);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(totalSize, 4); buffer.write('WAVE', 8);
  buffer.write('fmt ', 12); buffer.writeUInt32LE(subchunk1Size, 16);
  buffer.writeUInt16LE(parsed.audioFormat, 20); buffer.writeUInt16LE(parsed.channels, 22);
  buffer.writeUInt32LE(parsed.sampleRate, 24); buffer.writeUInt32LE(parsed.byteRate, 28);
  buffer.writeUInt16LE(parsed.blockAlign, 32); buffer.writeUInt16LE(parsed.bitsPerSample, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(dataSize, 40); parsed.data.copy(buffer, 44);
  return buffer;
}

function concatParsedWavs(items) {
  if (!items.length) throw new Error('no items');
  const first = items[0]; for (let i = 1; i < items.length; i++) {
    const keys = ['audioFormat','channels','sampleRate','bitsPerSample'];
    for (const k of keys) if (first[k] !== items[i][k]) throw new Error('incompatible');
  }
  return { ...first, data: Buffer.concat(items.map(i=>i.data)) };
}

function getDurationSeconds(parsed) { if (!parsed.byteRate) return 0; return parsed.data.length / parsed.byteRate; }

async function synthesizeToBase64(text) {
  const MIMO_API_KEY = process.env.MIMO_API_KEY || process.env.MIMO_KEY || '';
  if (!MIMO_API_KEY) throw new Error('Missing MIMO_API_KEY');
  const MIMO_TTS_MODEL = process.env.MIMO_TTS_MODEL || 'mimo-v2-tts';
  const MIMO_TTS_VOICE = process.env.MIMO_TTS_VOICE || 'mimo_default';
  const MIMO_TTS_STYLE = process.env.MIMO_TTS_STYLE || '温暖 平和 宁静 沉稳';
  const MIMO_TTS_USER_PROMPT = process.env.MIMO_TTS_USER_PROMPT || '请以女性心理学导师的口吻朗读以下文本：语气温暖、平和、包容，给听者安全感和被理解感，避免夸张情绪与强烈戏剧化表达。语速稳定。';
  const MIMO_TTS_SYSTEM_PROMPT = process.env.MIMO_TTS_SYSTEM_PROMPT || '你是专业的中文有声朗读助手。你的声音呈现为女性心理学导师，温暖、平和、令人宁静，语速中等偏慢，停连自然。语速稳定。';
  const MIMO_TTS_TEMPERATURE = process.env.MIMO_TTS_TEMPERATURE ? Number(process.env.MIMO_TTS_TEMPERATURE) : 0.3;
  const MIMO_TTS_TOP_P = process.env.MIMO_TTS_TOP_P ? Number(process.env.MIMO_TTS_TOP_P) : 0.5;
  const MIMO_AUTH_MODE = (process.env.MIMO_AUTH_MODE || 'api-key').trim();
  const DEFAULT_BASE = 'https://api.xiaomimimo.com/v1';
  const TOKEN_PLAN_BASE = 'https://token-plan-cn.xiaomimimo.com/v1';
  let selectedBase = process.env.MIMO_API_URL?.trim() || DEFAULT_BASE;
  if (MIMO_API_KEY.startsWith('tp-')) selectedBase = TOKEN_PLAN_BASE;
  const MIMO_API_URL = `${selectedBase.replace(/\/+$/,'')}/chat/completions`;

  const assistantContent = (MIMO_TTS_STYLE ? `<style>${MIMO_TTS_STYLE}</style>` : '') + text;
  let messages;
  if (MIMO_TTS_MODEL && MIMO_TTS_MODEL.toLowerCase().includes('tts')) {
    messages = [ { role: 'user', content: MIMO_TTS_USER_PROMPT || '' }, { role: 'assistant', content: assistantContent } ];
  } else {
    messages = [ { role: 'system', content: MIMO_TTS_SYSTEM_PROMPT || '' }, { role: 'user', content: MIMO_TTS_USER_PROMPT || '' }, { role: 'assistant', content: assistantContent } ];
  }

  const payload = {
    model: MIMO_TTS_MODEL,
    messages,
    audio: { format: 'wav', voice: MIMO_TTS_VOICE },
    temperature: MIMO_TTS_TEMPERATURE,
    top_p: MIMO_TTS_TOP_P,
    stream: false
  };
  const headers = { 'Content-Type': 'application/json' };
  if (MIMO_AUTH_MODE === 'api-key' || MIMO_AUTH_MODE === 'both') headers['api-key'] = MIMO_API_KEY;
  if (MIMO_AUTH_MODE === 'bearer' || MIMO_AUTH_MODE === 'both') headers['Authorization'] = `Bearer ${MIMO_API_KEY}`;

  const res = await fetch(MIMO_API_URL, { method: 'POST', headers, body: JSON.stringify(payload) });
  if (!res.ok) {
    const body = await res.text(); throw new Error(`TTS request failed ${res.status}: ${body.slice(0,500)}`);
  }
  const json = await res.json();
  const base64 = json?.choices?.[0]?.message?.audio?.data;
  if (!base64) throw new Error('No audio returned');
  return base64;
}

async function synthesizeWithRetries(text, maxRetries = 3) {
  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  let attempt = 0;
  let lastErr = null;
  while (attempt < maxRetries) {
    try {
      if (attempt > 0) console.log(`TTS retry attempt ${attempt + 1}/${maxRetries}...`);
      const base64 = await synthesizeToBase64(text);
      return base64;
    } catch (e) {
      lastErr = e;
      console.warn('TTS request failed:', e?.message || e);
      attempt += 1;
      const backoff = 1000 * Math.pow(2, attempt); // 2s,4s,8s...
      await sleep(backoff);
    }
  }
  throw new Error(`TTS failed after ${maxRetries} attempts: ${lastErr?.message || lastErr}`);
}

function findSilenceRanges(parsed, minSeconds = MIN_PAUSE_SECONDS) {
  const { data, sampleRate, blockAlign } = parsed;
  const frameCount = Math.floor(data.length / blockAlign);
  const minFrames = Math.floor(sampleRate * minSeconds);
  const silentFrames = [];
  const threshold = parsed.bitsPerSample === 16 ? 200 : 3; // amplitude threshold
  // iterate frames
  for (let fi = 0; fi < frameCount; fi++) {
    let frameSilent = true;
    const frameOffset = fi * blockAlign;
    for (let ch = 0; ch < parsed.channels; ch++) {
      const sampleOffset = frameOffset + ch * (parsed.bitsPerSample / 8);
      let val = 0;
      if (parsed.bitsPerSample === 16) val = data.readInt16LE(sampleOffset);
      else if (parsed.bitsPerSample === 8) val = data.readUInt8(sampleOffset) - 128;
      if (Math.abs(val) > threshold) { frameSilent = false; break; }
    }
    silentFrames.push(frameSilent);
  }
  const ranges = [];
  let runStart = -1;
  for (let i = 0; i < silentFrames.length; i++) {
    if (silentFrames[i]) {
      if (runStart === -1) runStart = i;
    } else {
      if (runStart !== -1) {
        const runLen = i - runStart;
        if (runLen >= minFrames) ranges.push({ startFrame: runStart, endFrame: i - 1 });
        runStart = -1;
      }
    }
  }
  if (runStart !== -1) {
    const runLen = silentFrames.length - runStart;
    if (runLen >= minFrames) ranges.push({ startFrame: runStart, endFrame: silentFrames.length - 1 });
  }
  // convert to byte ranges
  return ranges.map(r => ({ start: r.startFrame * blockAlign, end: (r.endFrame + 1) * blockAlign }));
}

async function run() {
  const sourcePath = path.resolve(docsRoot, targetSource);
  if (!fs.existsSync(sourcePath)) throw new Error('source not found: ' + sourcePath);
  const raw = fs.readFileSync(sourcePath, 'utf8');
  const { frontmatter, body } = splitFrontmatter(raw);
  const segments = buildSegments(body, 0);
  if (!segments.length) throw new Error('no segments');

  // save segments early so external aligners can read them
  const sourceRelative = targetSource.replace(/\\/g, '/').replace(/^\/+/,'');
  const articleOutputDir = path.join(outputRoot, sourceRelative.replace(/\.md$/i, ''));
  ensureDir(articleOutputDir);
  saveJson(path.join(articleOutputDir, 'segments.chunked.json'), { source: targetSource, routePath, segments });

  const FORCE = process.argv.includes('--force') || process.env.FORCE_REGEN === '1' || false;
  const finalWavPath = path.join(articleOutputDir, 'final.wav');
  if (!FORCE && fs.existsSync(finalWavPath)) {
    // If final audio exists but there is an MFA output folder, we need to
    // check for missing TextGrids and possibly re-synthesize failed chunks.
    const mfaOutputDirEarly = path.join(articleOutputDir, 'mfa_output');
    if (!fs.existsSync(mfaOutputDirEarly)) {
      console.log('Final audio exists and --force not set. Skipping generation:', finalWavPath);
      process.exit(0);
    }
    console.log('Final audio exists but MFA output present; checking for failed chunks.');
    // continue into generation logic to detect and re-synthesize failed chunks
  }

  // chunking: combine short paragraphs without splitting
  const chunks = [];
  let current = { text: '', segments: [] };
  for (const seg of segments) {
    const segLen = (seg.cleanText || '').length;
    if (!current.segments.length) {
      current.segments.push(seg);
      current.text = seg.cleanText;
    } else {
      const attemptLen = current.text.length + PAUSE_TOKEN.length + segLen;
      if (attemptLen <= MAX_CHARS_PER_CHUNK) {
        current.text = current.text + PAUSE_TOKEN + seg.cleanText;
        current.segments.push(seg);
      } else {
        chunks.push(current);
        current = { text: seg.cleanText, segments: [seg] };
      }
    }
  }
  if (current.segments.length) chunks.push(current);

  // If MFA output exists, detect which chunk TextGrids were produced and
  // remove the corresponding failed chunk audio files so they will be
  // re-synthesized. We only remove the .orig.wav files (keep transcripts).
  try {
    const mfaOutputDir = path.join(articleOutputDir, 'mfa_output');
    if (fs.existsSync(mfaOutputDir)) {
      const tgFiles = fs.readdirSync(mfaOutputDir).filter(f => f.endsWith('.TextGrid'));
      const produced = new Set(tgFiles.map(f => path.basename(f, '.TextGrid')));
      for (let ci = 0; ci < chunks.length; ci++) {
        const chunkBase = `chunk-${String(ci+1).padStart(3,'0')}`;
        if (!produced.has(chunkBase)) {
          const rawChunkPath = path.join(articleOutputDir, `${chunkBase}.orig.wav`);
          if (fs.existsSync(rawChunkPath)) {
            try { fs.unlinkSync(rawChunkPath); console.log('Removed failed chunk audio:', rawChunkPath); } catch (e) { console.warn('Failed to remove', rawChunkPath, e?.message || e); }
          }
        }
      }
    }
  } catch (e) { console.warn('Warning checking mfa_output:', e?.message || e); }

  console.log('Chunks to synthesize:', chunks.length);
  const parsedParagraphAudios = new Array(chunks.length);
  const cuesPerChunk = new Array(chunks.length);
  const cues = [];
  const CONCURRENCY = Number(process.env.TTS_CONCURRENCY || 8);

  // process a single chunk (can be run in parallel)
  async function processChunk(ci) {
    const chunk = chunks[ci];
    console.log(`Processing chunk ${ci + 1}/${chunks.length} with ${chunk.segments.length} paragraphs`);
    const chunkBase = `chunk-${String(ci+1).padStart(3,'0')}`;
    try { fs.writeFileSync(path.join(articleOutputDir, `${chunkBase}.txt`), chunk.text, 'utf8'); } catch (e) { console.error('Warning: failed to write chunk text file', e?.message || e); }

    const rawChunkPath = path.join(articleOutputDir, `${chunkBase}.orig.wav`);
    let parsed = null;
    if (!FORCE && fs.existsSync(rawChunkPath)) {
      try {
        const stat = fs.statSync(rawChunkPath);
        if (stat.size < 1024) {
          console.warn('Cached wav too small, will re-synthesize:', rawChunkPath);
        } else {
          const buf = fs.readFileSync(rawChunkPath);
          try {
            parsed = parseWav(buf);
            if (parsed && parsed.data && parsed.data.length > 0) {
              console.log(`reusing ${chunkBase}`);
            } else {
              console.warn('Cached wav invalid (empty), will re-synthesize:', rawChunkPath);
              parsed = null;
            }
          } catch (pe) {
            // Move corrupt cached file aside to avoid repeated parse attempts
            try {
              const badPath = rawChunkPath + '.bad.wav';
              fs.renameSync(rawChunkPath, badPath);
              console.warn('Renamed corrupt cached wav to', badPath);
            } catch (re) {
              console.warn('Failed to rename corrupt cached wav', re.message || re);
            }
            parsed = null;
          }
        }
      } catch (e) {
        console.warn('Failed to stat/read cached wav, will re-synthesize:', e.message || e);
        parsed = null;
      }
    }
    if (!parsed) {
      const base64 = await synthesizeWithRetries(chunk.text, Number(process.env.TTS_RETRIES || 3));
      parsed = parseWav(toBuffer(base64));
      try { fs.writeFileSync(rawChunkPath, toBuffer(base64)); } catch (e) { console.error('Warning: failed to write raw chunk file', e?.message || e); }
    }

    // create unaligned cues placeholder for this chunk (MFA will fill timings)
    const paragraphTexts = chunk.text.split(PAUSE_TOKEN).map(s => s.trim()).filter(Boolean);
    const chunkCues = [];
    for (let pi = 0; pi < paragraphTexts.length; pi++) {
      chunkCues.push({ chunk: chunkBase, paragraph_index: pi, start: null, end: null, aligned: false, text: chunk.segments[pi].cleanText });
    }

    return { parsed, chunkCues };
  }

  // worker pool
  const results = new Array(chunks.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const ci = nextIndex++;
      if (ci >= chunks.length) break;
      try {
        results[ci] = await processChunk(ci);
      } catch (e) {
        console.error('Chunk', ci + 1, 'failed:', e?.message || e);
        throw e;
      }
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY, chunks.length); i++) workers.push(worker());
  await Promise.all(workers);

  // collect results in order and flatten cues
  for (let ci = 0; ci < chunks.length; ci++) {
    const res = results[ci];
    parsedParagraphAudios[ci] = res.parsed;
    cuesPerChunk[ci] = res.chunkCues;
  }
  for (const chunkCues of cuesPerChunk) {
    for (const c of chunkCues) cues.push(c);
  }

  // Merge all parsedParagraphAudios into final (concatenate compatible WAVs)
  let finalParsed = null;
  const presentParsed = parsedParagraphAudios.filter(Boolean);
  if (presentParsed.length) finalParsed = concatParsedWavs(presentParsed);
  else finalParsed = { audioFormat: 1, channels: 1, sampleRate: 16000, bitsPerSample: 16, blockAlign: 2, byteRate: 32000, data: Buffer.alloc(0) };
  fs.writeFileSync(finalWavPath, buildWav(finalParsed));
  saveJson(path.join(articleOutputDir, 'cues.chunked.json'), { source: targetSource, routePath, totalDuration: Number(getDurationSeconds(finalParsed).toFixed(3)), count: cues.length, generatedAt: new Date().toISOString(), cues });
  saveJson(path.join(articleOutputDir, 'segments.chunked.json'), { source: targetSource, routePath, segments });

  console.log('Done. Final file:', finalWavPath);

  // After TTS, optionally run MFA alignment (no cache) with --clean and jobs=4, then
  // postprocess and merge. Use local environment variables or defaults for
  // dictionary/acoustic model names.
  if (!SKIP_MFA) {
    try {
      const python = process.env.PYTHON || 'python';
      const dict = process.env.MFA_DICT || 'mandarin_china_mfa';
      const acoustic = process.env.MFA_ACOUSTIC || 'mandarin_mfa';
      const mfaScript = path.join(docsRoot, '.vitepress', 'script', 'gen-tts-align-mfa.py');
      const mfaCmd = `${python} "${mfaScript}" --dir "${articleOutputDir}" --dict ${dict} --acoustic ${acoustic} --conda-env mfa --mfa-opts "--clean --jobs 4"`;
      console.log('Running MFA align (clean, jobs=4):', mfaCmd);
      execSync(mfaCmd, { stdio: 'inherit' });

      // postprocess and merge
      const postproc = `node "${path.join(docsRoot, '.vitepress', 'script', 'postprocess-unaligned-cues.cjs')}" "${articleOutputDir}"`;
      console.log('Running postprocess:', postproc);
      execSync(postproc, { stdio: 'inherit' });
      const merge = `node "${path.join(docsRoot, '.vitepress', 'script', 'merge-segments-and-cues.cjs')}" "${articleOutputDir}"`;
      console.log('Running merge:', merge);
      execSync(merge, { stdio: 'inherit' });
    } catch (e) {
      console.error('MFA/postprocess/merge step failed:', e?.message || e);
    }
    // After successful merge, normalize filenames to what the frontend expects:
    try {
      const outFinalWav = path.join(articleOutputDir, 'final.wav');
      const outFinalMp3 = path.join(articleOutputDir, 'final.mp3');
      // We now write final.wav directly; no intermediate final.chunked.wav is kept.
      if (fs.existsSync(outFinalWav)) console.log('Final audio available:', outFinalWav);
      // merge script now writes public cues.json directly; no cues.final.json to copy.
      const cuesJson = path.join(articleOutputDir, 'cues.json');
      if (fs.existsSync(cuesJson)) console.log('Cues available:', cuesJson);
      // Also normalize segments file
      const segChunked = path.join(articleOutputDir, 'segments.chunked.json');
      const segJson = path.join(articleOutputDir, 'segments.json');
      if (fs.existsSync(segChunked)) {
        try { fs.copyFileSync(segChunked, segJson); console.log('Wrote', segJson); } catch (e) { console.warn('Failed to copy segments.chunked.json -> segments.json', e?.message || e); }
      }
      // Update manifest.json entry for this article (same behavior as gen-tts-assets.js)
      try {
        const manifestPath = path.join(outputRoot, 'manifest.json');
        const manifest = loadJson(manifestPath, { generatedAt: null, entries: {} });
        const relOut = path.relative(outputRoot, articleOutputDir).replace(/\\/g, '/');
        const publicBase = `/tts/${relOut}`;
        const cuesJsonPath = path.join(articleOutputDir, 'cues.json');
        const cuesData = loadJson(cuesJsonPath, loadJson(path.join(articleOutputDir, 'cues.chunked.json'), null)) || {};
        const segmentsData = loadJson(segJson, null) || loadJson(path.join(articleOutputDir, 'segments.chunked.json'), null) || {};
        const routeKey = '/' + sourceRelative.replace(/\.md$/i, '');
        // compute totalDuration: prefer explicit field, otherwise derive from last cue end
        let totalDuration = 0;
        if (typeof cuesData.totalDuration === 'number' && cuesData.totalDuration > 0) {
          totalDuration = cuesData.totalDuration;
        } else if (Array.isArray(cuesData.cues) && cuesData.cues.length) {
          const last = cuesData.cues[cuesData.cues.length - 1];
          totalDuration = Number(last.end || last.start || 0);
        }

        const entry = {
          routePath: routeKey,
          source: targetSource,
          audio: `${publicBase}/final.wav`,
          cues: `${publicBase}/cues.json`,
          segments: `${publicBase}/segments.json`,
          count: cuesData?.count || (Array.isArray(cues) ? cues.length : 0),
          totalDuration: Number((totalDuration || 0)),
          generatedAt: cuesData?.generatedAt ? cuesData.generatedAt : isoLocalWithOffset(new Date()),
          fingerprint: crypto.createHash('sha1').update((segments || []).map(s => s.fingerprint).join('|')).digest('hex')
        };
        manifest.entries[routeKey] = entry;
        manifest.generatedAt = new Date().toISOString();
        saveJson(manifestPath, manifest);
        console.log('Updated manifest entry at', manifestPath);
      } catch (e) {
        console.warn('Failed to update manifest:', e?.message || e);
      }
      // MP3 conversion disabled per request. To re-enable, restore ffmpeg conversion logic here.
    } catch (e) {
      console.warn('Post-merge normalization failed:', e?.message || e);
    }
  } else {
    console.log('SKIP_MFA set — skipping MFA/postprocess/merge steps.');
  }
}

if (import.meta.url === `file://${process.argv[1]}` || !process.env.JEST_WORKER_ID) {
  run().catch(e => { console.error(e); process.exit(1); });
}
