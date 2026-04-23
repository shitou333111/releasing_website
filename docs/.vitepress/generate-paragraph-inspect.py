#!/usr/bin/env python3
"""Generate a paragraph inspection JSON for an article's TTS outputs.

Writes a JSON array where each item contains:
 - paragraph_id: original md paragraph id
 - time: [start, end] in final audio (can be null)
 - original_md: original md paragraph text (rawText)
 - chunk_paragraph: the paragraph text as present inside the chunk file
 - textgrid_paragraph: the concatenated text extracted from the chunk's TextGrid intervals

Usage:
  python generate-paragraph-inspect.py <article_tts_dir>

This script expects `segments.json`, `cues.final.json`, and `cues.mfa.json`
to be present in the article directory, along with `mfa_output/*.TextGrid` and
`chunk-*.txt` files.
"""
from __future__ import annotations
import json
import sys
from pathlib import Path
import re
import difflib


def normalize_ws(s: str) -> str:
    return re.sub(r"\s+", " ", (s or '').strip())


def compact(s: str) -> str:
    return ''.join(normalize_ws(s).split())


def parse_textgrid_intervals(path: Path):
    # tolerant regex parser for intervals in the 'words' tier
    txt = path.read_text(encoding='utf8')
    item_re = re.compile(r'item \[\d+\]:([\s\S]*?)(?=\s*item \[\d+\]:|$)', re.IGNORECASE)
    words_block = None
    for m in item_re.finditer(txt):
        block = m.group(1)
        if re.search(r'name\s*=\s*"words"', block, re.IGNORECASE):
            words_block = block
            break
    if not words_block:
        # fallback: use first interval-like block
        words_block = txt
    interval_re = re.compile(r'intervals \[\d+\]:([\s\S]*?)(?=intervals \[\d+\]:|$)', re.IGNORECASE)
    field_re = re.compile(r'xmin\s*=\s*([0-9.eE+-]+)[\s\S]*?xmax\s*=\s*([0-9.eE+-]+)[\s\S]*?text\s*=\s*"([\s\S]*?)"', re.IGNORECASE)
    intervals = []
    for im in interval_re.finditer(words_block):
        block = im.group(1)
        f = field_re.search(block)
        if f:
            try:
                start = float(f.group(1)); end = float(f.group(2))
            except Exception:
                continue
            text = f.group(3).replace('\\"', '"').replace('\\n', '\n').strip()
            intervals.append({'start': start, 'end': end, 'text': text})
    return intervals


def find_textgrid_paragraph(intervals, paragraph_text, fuzzy=False, min_ratio=0.7):
    pnorm = compact(paragraph_text)
    if not pnorm:
        return ''
    concat = ''.join([i['text'].replace(' ', '') for i in intervals])
    # Exact search first
    idx = concat.find(pnorm)
    if idx != -1:
        # find intervals that overlap the char range
        pos = 0
        results = []
        for it in intervals:
            tok = it['text'].replace(' ', '')
            startc = pos; endc = pos + len(tok) - 1
            pos += len(tok)
            if not (endc < idx or startc > idx + len(pnorm) - 1):
                results.append(it['text'])
        return normalize_ws(''.join(results))

    if not fuzzy:
        return None

    # Fuzzy matching: slide a window over the concat string and compute best ratio
    if not concat:
        return None
    target_len = len(pnorm)
    # if concat shorter than target, compare whole concat
    if len(concat) <= target_len:
        ratio = difflib.SequenceMatcher(None, pnorm, concat).ratio()
        if ratio >= min_ratio:
            return normalize_ws(''.join([i['text'] for i in intervals]))
        return None

    step = max(1, target_len // 4)
    best = (0.0, None, None)  # (ratio, start, window_len)
    # try fixed window size equal to target_len
    for start in range(0, len(concat) - target_len + 1, step):
        window = concat[start:start + target_len]
        ratio = difflib.SequenceMatcher(None, pnorm, window).ratio()
        if ratio > best[0]:
            best = (ratio, start, target_len)
    # also try a couple of nearby sizes (+/-20%)
    for mult in (0.8, 0.9, 1.1, 1.2):
        wlen = max(1, int(target_len * mult))
        if wlen == target_len or wlen > len(concat):
            continue
        for start in range(0, len(concat) - wlen + 1, step):
            window = concat[start:start + wlen]
            ratio = difflib.SequenceMatcher(None, pnorm, window).ratio()
            if ratio > best[0]:
                best = (ratio, start, wlen)

    if best[0] < min_ratio:
        return None

    # Map best window back to intervals
    bstart = best[1]
    bend = bstart + best[2] - 1
    pos = 0
    results = []
    for it in intervals:
        tok = it['text'].replace(' ', '')
        startc = pos; endc = pos + len(tok) - 1
        pos += len(tok)
        if not (endc < bstart or startc > bend):
            results.append(it['text'])
    if results:
        return normalize_ws(''.join(results))
    return None


def main():
    if len(sys.argv) < 2:
        print('Usage: generate-paragraph-inspect.py <article_tts_dir>')
        sys.exit(2)
    article_dir = Path(sys.argv[1])
    if not article_dir.exists():
        print('Article dir not found:', article_dir); sys.exit(1)

    seg_path = article_dir / 'segments.json'
    final_cues_path = article_dir / 'cues.final.json'
    mfa_cues_path = article_dir / 'cues.mfa.json'
    if not seg_path.exists() or not final_cues_path.exists() or not mfa_cues_path.exists():
        print('Missing required files (segments.json, cues.final.json, cues.mfa.json) in', article_dir)
        sys.exit(1)

    segments = json.loads(seg_path.read_text(encoding='utf8'))['segments']
    final_cues = json.loads(final_cues_path.read_text(encoding='utf8'))['cues']
    mfa_cues = json.loads(mfa_cues_path.read_text(encoding='utf8'))['cues']

    # index mfa cues by whitespace-stripped text for quick lookup (matches pipeline)
    mfa_index = {}
    for e in mfa_cues:
        key = compact(e.get('text',''))
        mfa_index.setdefault(key, []).append(e)

    inspect_items = []
    # build map from segment id -> original md rawText
    seg_map = {s['id']: s for s in segments}

    for item in final_cues:
        pid = item.get('id')
        start = item.get('start')
        end = item.get('end')
        orig_md = seg_map.get(pid, {}).get('rawText') if pid else None
        final_text = item.get('text')

        # find a matching mfa cue using the pipeline's whitespace-only normalization
        match = None
        key = compact(final_text or '')
        candidates = mfa_index.get(key, [])
        if not candidates and key:
            # try substring match on compact keys
            for k, lst in mfa_index.items():
                if key and key in k:
                    candidates = lst
                    break
        if candidates:
            # prefer aligned ones
            aligned = [c for c in candidates if c.get('aligned')]
            match = (aligned[0] if aligned else candidates[0])

        chunk_paragraph = match.get('text') if match else None
        textgrid_paragraph = None
        if match and chunk_paragraph:
            chunk_name = match.get('chunk')
            tg_path = article_dir / 'mfa_output' / (chunk_name + '.TextGrid')
            if tg_path.exists():
                try:
                    intervals = parse_textgrid_intervals(tg_path)
                    # try to find a matching span in the TextGrid using stripped form
                    tg_par = find_textgrid_paragraph(intervals, chunk_paragraph)
                    # If find_textgrid_paragraph couldn't locate via exact chars,
                    # attempt a more permissive search by stripping punctuation
                    # Use pipeline's exact char-based paragraph extraction; if not found leave null
                    textgrid_paragraph = tg_par
                except Exception:
                    textgrid_paragraph = None

        inspect_items.append({
            'paragraph_id': pid,
            'time': [start, end],
            'original_md': orig_md,
            'chunk_paragraph': chunk_paragraph,
            'textgrid_paragraph': textgrid_paragraph,
        })

    out_path = article_dir / 'paragraph-inspect.json'
    out_path.write_text(json.dumps(inspect_items, ensure_ascii=False, indent=2), encoding='utf8')
    print('Wrote', out_path)


if __name__ == '__main__':
    main()
