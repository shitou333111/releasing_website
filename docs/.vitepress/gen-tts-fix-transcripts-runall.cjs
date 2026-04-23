const fs = require('fs');
const path = require('path');
const glob = require('glob');

function normalizeText(s) {
  let out = s;
  out = out.replace(/\(\s*停顿\s*\)/g, '（沉默片刻）');
  out = out.replace(/（[^）]{0,20}(沉默|沉思)[^）]{0,20}）/g, '（沉默片刻）');
  out = out.replace(/(（沉默片刻）\s*)+/g, '\n（沉默片刻）\n');
  out = out.replace(/\n{3,}/g, '\n\n');
  out = out.trim();
  return out;
}

function run() {
  const pattern = 'docs/public/tts/**/chunk-*.txt';
  const files = glob.sync(pattern, { nodir: true });
  if (!files.length) {
    console.error('No chunk-*.txt files found');
    process.exit(0);
  }
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const fixed = normalizeText(src);
    const outPath = f.replace(/\.txt$/, '.fixed.txt');
    fs.writeFileSync(outPath, fixed, 'utf8');
    console.log('Wrote', outPath);
  }
}

run();
