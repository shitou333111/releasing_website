const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
// Accept article path as first argument (e.g. "书/决定自由").
// Support either a relative article key (joined onto root/docs/public/tts)
// or an absolute path to the article directory.
const articleArg = process.argv[2] || '书/决定自由';
let articleDir;
if (path.isAbsolute(articleArg)) {
  articleDir = path.resolve(articleArg);
} else {
  const articleParts = articleArg.split(/[\\/]+/).filter(Boolean);
  articleDir = path.join(root, 'docs', 'public', 'tts', ...articleParts);
}
const segmentsPath = path.join(articleDir, 'segments.chunked.json');
const cuesPath = path.join(articleDir, 'cues.mfa.postproc.json');
const publicOutPath = path.join(articleDir, 'cues.json');
console.log('Merging segments and cues for article:', articleArg, 'at', articleDir);

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }

const segments = readJson(segmentsPath).segments || [];
const cues = (readJson(cuesPath).cues) || [];

// Build an index of cue texts -> cues (some may be duplicated)
function normalize(s) {
  return (s || '').replace(/[\s\u00A0]+/g, ' ').trim();
}
function normForCompare(s) {
  return (s || '').replace(/[^\p{L}\p{N}]+/gu, ' ').toLowerCase().replace(/\s+/g, ' ').trim();
}

const cueIndex = cues.map(c => ({ raw: c.text || '', text: normalize(c.text), cmp: normForCompare(c.text), start: c.start, end: c.end, chunk: c.chunk, pidx: c.paragraph_index }));

function wordsOf(s) { return s ? s.split(/\s+/).filter(Boolean) : []; }

const result = [];

// Reconstruct chunk boundaries from segments using the same chunking heuristic
// as the generator so we can map cues with `chunk`+`paragraph_index` directly.
function reconstructChunkStarts(segments, maxChars = Number(process.env.TTS_CHUNK_MAX_CHARS || 2000)) {
  const starts = [];
  let curLen = 0;
  let curStart = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segLen = (seg.cleanText || '').length;
    if (curLen === 0) {
      starts.push(i);
      curLen = segLen;
    } else {
      const attempt = curLen + 1 + segLen; // +1 for PAUSE_TOKEN length
      if (attempt <= maxChars) {
        curLen = attempt;
      } else {
        // new chunk
        starts.push(i);
        curLen = segLen;
      }
    }
  }
  return starts;
}

const chunkStarts = reconstructChunkStarts(segments);

for (const seg of segments) {
  if (seg.type !== 'paragraph' && seg.type !== 'heading') {
    result.push({ id: seg.id, index: seg.index, type: seg.type, tag: seg.tag || null, text: seg.cleanText, start: null, end: null, duration: null, fingerprint: null });
    continue;
  }
  const sRaw = seg.cleanText || '';
  const s = normalize(sRaw);
  const sCmp = normForCompare(sRaw);
  // try exact match first
  let match = null;
  // Try direct mapping via cue.chunk + paragraph_index if available.
  try {
    // find which reconstructed chunk this segment belongs to
    let chunkIdx = -1;
    for (let ci = 0; ci < chunkStarts.length; ci++) {
      const startIdx = chunkStarts[ci];
      const endIdx = (ci + 1 < chunkStarts.length) ? chunkStarts[ci + 1] - 1 : segments.length - 1;
      if (seg.index >= startIdx && seg.index <= endIdx) {
        chunkIdx = ci;
        break;
      }
    }
    if (chunkIdx >= 0) {
      const chunkBase = `chunk-${String(chunkIdx + 1).padStart(3, '0')}`;
      const paragraphIndexInChunk = seg.index - chunkStarts[chunkIdx];
      match = cueIndex.find(c => c.chunk === chunkBase && Number(c.pidx) === paragraphIndexInChunk && c.start != null);
      if (match) {
        // direct mapping found
      }
    }
  } catch (e) {
    // ignore and fall back to text heuristics
  }
  // prefer direct mapping when cue carries chunk and paragraph_index
  // (no-op) fall through to text-based heuristics if direct mapping didn't find a match

  // If the cue object has chunk and paragraph_index, try direct index mapping
  // (cues from MFA often include these fields)
  if (!match && typeof cues !== 'undefined') {
    // will be handled below per-segment when we iterate cues; nothing here
  }

  // Primary exact text match
  match = cueIndex.find(c => c.text === s && c.start != null);
  if (!match) {
    // try exact cmp
    match = cueIndex.find(c => c.cmp === sCmp && c.start != null);
  }
  if (!match) {
    // try substring or contains (cue inside segment or vice versa)
    match = cueIndex.find(c => (c.text && s.includes(c.text)) || (s && c.text && c.text.includes(s)));
  }
  if (!match) {
    // try prefix
    const prefix = s.slice(0, 40);
    match = cueIndex.find(c => c.text && c.text.startsWith(prefix));
  }

  // fallback: token overlap
  if (!match) {
    const segWords = wordsOf(sCmp);
    const segSet = new Set(segWords);
    let best = null;
    for (const c of cueIndex) {
      if (!c.cmp) continue;
      const cueWords = wordsOf(c.cmp);
      if (cueWords.length === 0) continue;
      let common = 0;
      for (const w of cueWords) if (segSet.has(w)) common += 1;
      const score = common / Math.max(1, Math.min(segWords.length, cueWords.length));
      if ((best === null || score > best.score) && c.start != null) best = { c, score };
    }
    if (best && best.score >= 0.45) match = best.c;
  }

  // compute duration and fingerprint (FNV-1a 32-bit) for frontend matching
  function createStableFingerprint(input) {
    const text = (input || '').replace(/\s+/g, ' ').trim();
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
  }

  const startVal = match ? match.start : null;
  const endVal = match ? match.end : null;
  const duration = (startVal != null && endVal != null) ? (endVal - startVal) : null;
  const fingerprint = createStableFingerprint(seg.cleanText || '');

  result.push({ id: seg.id, index: seg.index, type: seg.type, tag: seg.tag || null, text: seg.cleanText, start: startVal, end: endVal, duration, fingerprint });
}

// Write only the public-facing cues.json (remove intermediate cues.final.json)
writeJson(publicOutPath, { source_segments: segmentsPath, source_cues: cuesPath, count: result.length, cues: result });
console.log('Wrote', publicOutPath);
