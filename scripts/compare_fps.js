const fs = require('fs');
const segPath = 'docs/public/tts/书/我和莱斯特/segments.chunked.json';
const cuesPath = 'docs/public/tts/书/我和莱斯特/cues.json';
const seg = JSON.parse(fs.readFileSync(segPath,'utf8')).segments;
const cues = JSON.parse(fs.readFileSync(cuesPath,'utf8')).cues;
const segMap = new Map(seg.map(s=>[s.id,s]));
const mismatches = [];
for (const c of cues) {
  const s = segMap.get(c.id);
  if (!s) { mismatches.push({ id: c.id, reason: 'missing-segment' }); continue; }
  const clean = s.cleanText || '';
  const textNorm = clean.replace(/\s+/g,' ').trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < textNorm.length; i++) {
    h ^= textNorm.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const fp = 'fnv1a-' + (h >>> 0).toString(16).padStart(8,'0');
  if (fp !== c.fingerprint) mismatches.push({ id: c.id, segFp: fp, cueFp: c.fingerprint });
}
console.log('checked', cues.length, 'cues; mismatches:', mismatches.length);
if (mismatches.length > 0) console.table(mismatches.slice(0, 120));
else console.log('all fingerprints match between segments and cues');
