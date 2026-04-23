const fs = require('fs');
const path = require('path');

// Reimplemented minimal cleanTextForTTS + fingerprint to match shared/readAloudText.js
const CIRCLED_FOOTNOTE_REGEX = /[①②③④⑤⑥⑦⑧⑨⑩]/g;
const HTML_TAG_REGEX = /<[^>]+>/g;
const BR_TAG_REGEX = /<br\s*\/?>>/gi; // not heavily used here

function removeCircledFootnotes(input) {
  return String(input || '').replace(CIRCLED_FOOTNOTE_REGEX, '');
}
function normalizeWhitespace(input) {
  return String(input || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function stripInlineHtml(input) {
  return String(input || '').replace(/<br\s*\/?\s*>/gi, '\n').replace(HTML_TAG_REGEX, ' ');
}
function cleanTextForTTS(input) {
  const text = stripInlineHtml(input);
  const withoutFootnotes = removeCircledFootnotes(text);
  let normalized = String(withoutFootnotes || '').replace(/(?:\u2026+|\.{3,})/g, '，');
  return normalizeWhitespace(normalized);
}
function createStableFingerprint(input) {
  const text = normalizeWhitespace(input);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

// Load cues.json
const cuesPath = path.resolve(__dirname, '../docs/public/tts/书/我和莱斯特/cues.json');
const mdPath = path.resolve(__dirname, '../docs/书/我和莱斯特.md');

if (!fs.existsSync(cuesPath)) {
  console.error('cues.json not found at', cuesPath);
  process.exit(1);
}
if (!fs.existsSync(mdPath)) {
  console.error('markdown not found at', mdPath);
  process.exit(1);
}

const cues = JSON.parse(fs.readFileSync(cuesPath, 'utf8')).cues || [];
const md = fs.readFileSync(mdPath, 'utf8');

// Simple markdown -> runtime node extraction
const blocks = md.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
const runtimeEntries = [];

for (const block of blocks) {
  // image only line
  const imgMatch = block.match(/^!\[[^\]]*\]\(([^)]+)\)\s*$/);
  if (imgMatch) {
    const src = imgMatch[1];
    const text = `![]（${src}）`;
    const clean = cleanTextForTTS(text);
    if (clean) runtimeEntries.push({type:'p', text, clean, fingerprint:createStableFingerprint(clean), altFingerprint:createStableFingerprint(clean.replace(/\s+/g, ''))});
    continue;
  }
  // heading
  const headingMatch = block.match(/^(#{1,6})\s*(.+)$/m);
  if (headingMatch) {
    const hashes = headingMatch[1];
    const text = headingMatch[2].replace(/\n/g, ' ').trim();
    const clean = cleanTextForTTS(text);
    if (clean) runtimeEntries.push({type:`h${hashes.length}`, text, clean, fingerprint:createStableFingerprint(clean)});
    continue;
  }
  // blockquote: strip leading >
  const blockNoQuote = block.replace(/^>\s?/gm, '');
  // paragraph
  const text = blockNoQuote.replace(/\n/g, ' ').trim();
  const clean = cleanTextForTTS(text);
  if (clean) runtimeEntries.push({type:'p', text, clean, fingerprint:createStableFingerprint(clean), altFingerprint:createStableFingerprint(clean.replace(/\s+/g, ''))});
}

// Compare: find matches by fingerprint
const runtimeByFp = new Map();
runtimeEntries.forEach((r, idx) => {
  if (!runtimeByFp.has(r.fingerprint)) runtimeByFp.set(r.fingerprint, []);
  runtimeByFp.get(r.fingerprint).push({r, idx});
  if (r.altFingerprint) {
    if (!runtimeByFp.has(r.altFingerprint)) runtimeByFp.set(r.altFingerprint, []);
    runtimeByFp.get(r.altFingerprint).push({r, idx});
  }
});

let matched = 0;
const unmatchedCues = [];
const matchedRuntimeIdx = new Set();

for (const cue of cues) {
  const fp = cue.fingerprint;
  const candidates = runtimeByFp.get(fp) || [];
  if (candidates.length > 0) {
    matched += 1;
    matchedRuntimeIdx.add(candidates[0].idx);
  } else {
    unmatchedCues.push({id:cue.id, fp, text:cue.text});
  }
}

const runtimeNoCue = runtimeEntries.filter((_,i)=>!matchedRuntimeIdx.has(i));

console.log('[HEADLESS DIAG] cues=', cues.length, 'runtimeEntries=', runtimeEntries.length, 'matched=', matched, 'unmatchedCues=', unmatchedCues.length, 'runtimeNoCue=', runtimeNoCue.length);
console.log('\n[UNMATCHED CUES] sample 20');
for (let i=0;i<Math.min(20, unmatchedCues.length);i++) {
  const u = unmatchedCues[i];
  console.log(u.id, u.fp, u.text.slice(0,140));
}

console.log('\n[RUNTIME NO CUE] sample 20');
for (let i=0;i<Math.min(20, runtimeNoCue.length);i++) {
  const r = runtimeNoCue[i];
  console.log(i, r.fingerprint, r.text.slice(0,140));
}

// For unmatched cues, provide nearest runtime text candidates by Levenshtein distance
function levenshtein(a, b) {
  if (!a) return b ? b.length : 0;
  if (!b) return a.length;
  const m = a.length, n = b.length;
  const dp = Array.from({length: m+1}, () => new Array(n+1).fill(0));
  for (let i=0;i<=m;i++) dp[i][0]=i;
  for (let j=0;j<=n;j++) dp[0][j]=j;
  for (let i=1;i<=m;i++) {
    for (let j=1;j<=n;j++) {
      const cost = a[i-1] === b[j-1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+cost);
    }
  }
  return dp[m][n];
}

console.log('\n[NEAREST RUNTIME CANDIDATES FOR FIRST 20 UNMATCHED CUES]');
const candidateSamples = [];
for (let i=0;i<Math.min(20, unmatchedCues.length); i++) {
  const u = unmatchedCues[i];
  const cueClean = cleanTextForTTS(u.text || '');
  const scores = runtimeEntries.map((re, idx) => {
    const d = levenshtein(cueClean, re.clean);
    const norm = d / Math.max(1, Math.max(cueClean.length, re.clean.length));
    return {idx, fingerprint: re.fingerprint, text: re.text.slice(0,200), dist: d, norm};
  });
  scores.sort((a,b)=>a.dist - b.dist);
  const top = scores.slice(0,6);
  console.log('\n', u.id, u.fp, 'cueClean=', cueClean.slice(0,120));
  top.forEach(t => console.log('  cand idx', t.idx, 'fp', t.fingerprint, 'dist', t.dist, 'norm', t.norm.toFixed(3), t.text));
  candidateSamples.push({cueId: u.id, cueClean, candidates: top});
}

// write diagnostic JSON
const out = {
  cuesCount: cues.length,
  runtimeCount: runtimeEntries.length,
  matched,
  unmatchedCues,
  runtimeNoCue: runtimeNoCue.map(r=>({fingerprint:r.fingerprint,text:r.text}))
};
out.candidateSamples = candidateSamples;
fs.writeFileSync(path.resolve(__dirname,'headless_tts_diag.json'), JSON.stringify(out,null,2), 'utf8');
console.log('\nWrote headless_tts_diag.json');
