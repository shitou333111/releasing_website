#!/usr/bin/env python3
"""Parse MFA TextGrids in an article folder and emit `cues.mfa.json`.

Usage: python parse-mfa-output.py --dir <article_dir>
"""
from pathlib import Path
import json
import argparse
import sys

def parse_textgrid(textgrid_path: Path):
    try:
        from textgrid import TextGrid
    except Exception:
        print('Missing textgrid package; install with pip install textgrid', file=sys.stderr)
        raise
    tg = TextGrid.fromFile(str(textgrid_path))
    # pick first interval tier with content
    tier = None
    for t in tg.tiers:
        if hasattr(t, 'intervals') and getattr(t, 'intervals'):
            tier = t
            break
    if tier is None:
        return []
    intervals = []
    for interval in tier.intervals:
        text = interval.mark.strip()
        if not text:
            continue
        intervals.append({'start': interval.minTime, 'end': interval.maxTime, 'text': text})
    return intervals

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--dir', required=True)
    p.add_argument('--pause', default='\n')
    args = p.parse_args()
    article = Path(args.dir)
    mfa_output = article / 'mfa_output'
    if not mfa_output.exists():
        print('mfa_output not found in', article)
        return
    pairs = []
    for tg in sorted(mfa_output.glob('*.TextGrid')):
        base = tg.stem
        # find original transcript
        txt = article / f"{base}.fixed.txt"
        if not txt.exists(): txt = article / f"{base}.txt"
        pairs.append((base, tg, txt))
    cues = []
    for base, tgpath, txtpath in pairs:
        intervals = parse_textgrid(tgpath)
        # build concat
        concat = ''.join([i['text'].replace(' ', '') for i in intervals])
        token_ranges = []
        pos = 0
        for it in intervals:
            tok = it['text'].replace(' ', '')
            startc = pos; pos += len(tok); endc = pos - 1
            token_ranges.append({'token': it, 'startChar': startc, 'endChar': endc})
        with open(txtpath, 'r', encoding='utf8') as f:
            text = f.read()
        paragraphs = [p.strip() for p in text.split(args.pause) if p.strip()]
        for i, p in enumerate(paragraphs):
            pnorm = ''.join(p.split())
            idx = concat.find(pnorm)
            if idx == -1:
                cues.append({'chunk': base, 'paragraph_index': i, 'start': None, 'end': None, 'aligned': False, 'text': p})
                continue
            pstart = idx; pend = idx + len(pnorm) - 1
            matched = [t for t in token_ranges if not (t['endChar'] < pstart or t['startChar'] > pend)]
            timed = [m for m in matched if m['token'].get('start') is not None]
            if not timed:
                cues.append({'chunk': base, 'paragraph_index': i, 'start': None, 'end': None, 'aligned': False, 'text': p})
            else:
                start = timed[0]['token']['start']; end = timed[-1]['token']['end']
                cues.append({'chunk': base, 'paragraph_index': i, 'start': start, 'end': end, 'aligned': True, 'text': p})
    out = article / 'cues.mfa.json'
    with open(out, 'w', encoding='utf8') as f:
        json.dump({'source': str(article), 'count': len(cues), 'cues': cues}, f, ensure_ascii=False, indent=2)
    print('Wrote', out)

if __name__ == '__main__':
    main()
