#!/usr/bin/env python3
import sys
from pathlib import Path

if len(sys.argv) < 2:
    print('Usage: regenerate_labs.py <article_dir>')
    sys.exit(2)

article_dir = Path(sys.argv[1])
corpus_dir = article_dir / 'mfa_corpus'

if not corpus_dir.exists():
    print('Corpus dir not found:', corpus_dir)
    sys.exit(1)

wav_files = sorted(corpus_dir.glob('chunk-*.wav'))
if not wav_files:
    print('No chunk-*.wav files in', corpus_dir)
    sys.exit(0)

for wav in wav_files:
    base = wav.stem
    txt_fixed = article_dir / f"{base}.fixed.txt"
    txt = article_dir / f"{base}.txt"
    candidates = []
    if txt_fixed.exists():
        candidates.append(txt_fixed)
    if txt.exists():
        candidates.append(txt)
    if not candidates:
        print('No transcript found for', base)
        continue
    try:
        transcript = max(candidates, key=lambda p: p.stat().st_mtime)
    except Exception:
        transcript = txt_fixed if txt_fixed.exists() else txt
    try:
        text = transcript.read_text(encoding='utf8').strip()
    except Exception as e:
        print('Failed to read', transcript, e)
        continue
    lab_path = corpus_dir / f"{base}.lab"
    try:
        lab_path.write_text(text + '\n', encoding='utf8')
        print('Wrote', lab_path.name, 'from', transcript.name)
    except Exception as e:
        print('Failed to write', lab_path, e)

print('Done')
