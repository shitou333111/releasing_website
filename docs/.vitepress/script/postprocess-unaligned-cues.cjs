const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
// Accept article path as first argument (e.g. "书/决定自由"), or an absolute
// path to the article folder. If an absolute path is provided, use it directly.
const articleArg = process.argv[2] || '书/决定自由';
let articleDir;
if (path.isAbsolute(articleArg)) {
  articleDir = path.resolve(articleArg);
} else {
  const articleParts = articleArg.split(/[\\/]+/).filter(Boolean);
  articleDir = path.join(root, 'docs', 'public', 'tts', ...articleParts);
}
const cuesPath = path.join(articleDir, 'cues.mfa.json');
const outPath = path.join(articleDir, 'cues.mfa.postproc.json');
const wavDir = articleDir;

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }

function getWavDuration(wavPath) {
  const buf = fs.readFileSync(wavPath);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a WAV: ' + wavPath);
  }
  const numChannels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);
  // find 'data' chunk
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'data') {
      const dataSize = size;
      const bytesPerSample = numChannels * (bitsPerSample / 8);
      return dataSize / (sampleRate * bytesPerSample);
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('data chunk not found in ' + wavPath);
}

function chunkNumber(name) {
  const m = name.match(/chunk-(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function main() {
  console.log('Postprocessing cues for article:', articleArg, 'at', articleDir);
  const cuesJson = readJson(cuesPath);
  const cues = cuesJson.cues;

  const groups = new Map();
  for (const c of cues) {
    if (!groups.has(c.chunk)) groups.set(c.chunk, []);
    groups.get(c.chunk).push(c);
  }

  const chunkNames = Array.from(groups.keys()).sort((a, b) => chunkNumber(a) - chunkNumber(b));
  const durations = {};
  for (const name of chunkNames) {
    const wavPath = path.join(wavDir, name + '.orig.wav');
    if (!fs.existsSync(wavPath)) {
      console.warn('Missing wav for', name, wavPath);
      durations[name] = 0;
      continue;
    }
    try {
      durations[name] = getWavDuration(wavPath);
    } catch (e) {
      console.warn('Could not read wav', wavPath, e.message);
      durations[name] = 0;
    }
  }

  const offsets = {};
  let acc = 0;
  for (const name of chunkNames) {
    offsets[name] = acc;
    acc += durations[name] || 0;
  }

  const outCues = [];

  for (const name of chunkNames) {
    const entries = groups.get(name);
    const chunkStart = offsets[name] || 0;
    const chunkEnd = chunkStart + (durations[name] || 0);

    let cursor = chunkStart;
    for (let i = 0; i < entries.length; ) {
      const e = entries[i];
          if (e.aligned && e.start != null && e.end != null) {
            // convert chunk-local times to absolute times by adding chunkStart
            const absStart = chunkStart + Number(e.start);
            const absEnd = chunkStart + Number(e.end);
            outCues.push(Object.assign({}, e, { start: Number(absStart.toFixed(2)), end: Number(absEnd.toFixed(2)), aligned: true }));
            cursor = Math.max(cursor, absEnd);
            i += 1;
            continue;
          }

      let j = i;
      let weight = 0;
      const run = [];
      while (j < entries.length && (!entries[j].aligned || entries[j].start == null)) {
        run.push(entries[j]);
        weight += (entries[j].text || '').length || 1;
        j += 1;
      }
      // nextAligned should be absolute time; if the next aligned entry has chunk-local time,
      // convert by adding chunkStart. Otherwise use chunkEnd.
      const nextAligned = (j < entries.length && entries[j].aligned && entries[j].start != null) ? (chunkStart + Number(entries[j].start)) : chunkEnd;
      const runDuration = Math.max(0, nextAligned - cursor);
      let cursorInner = cursor;
      for (const r of run) {
        const w = (r.text || '').length || 1;
        const dur = weight > 0 ? runDuration * (w / weight) : runDuration / run.length;
        const start = cursorInner;
        const end = cursorInner + dur;
        outCues.push(Object.assign({}, r, { start: Number(start.toFixed(2)), end: Number(end.toFixed(2)), aligned: true }));
        cursorInner = end;
      }
      cursor = cursorInner;
      i = j;
    }
  }

  const result = Object.assign({}, cuesJson, { postproc_source: 'postprocess-unaligned-cues.cjs', cues: outCues });
  writeJson(outPath, result);
  console.log('Wrote', outPath);
}

try { main(); } catch (e) { console.error(e); process.exit(2); }
