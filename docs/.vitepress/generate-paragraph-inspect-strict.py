#!/usr/bin/env python3
"""Strict paragraph inspector: only use TextGrid matches, no time-proportional fill.

Outputs a JSON with detailed per-chunk, per-paragraph matching steps for testing.

Usage:
  python generate-paragraph-inspect-strict.py <article_tts_dir>

This script reads `cues.mfa.json` and `mfa_output/*.TextGrid` under the
article dir and writes `paragraph-inspect-strict.json` with detailed traces.
"""
from __future__ import annotations
import json
import sys
from pathlib import Path
import re
import unicodedata
from typing import List, Dict, Any


def remove_punct_space(s: str) -> str:
    if not s:
        return ''
    out_chars = []
    for ch in s:
        # remove whitespace
        if ch.isspace():
            continue
        # remove unicode punctuation (categories starting with 'P')
        cat = unicodedata.category(ch)
        if cat and cat.startswith('P'):
            continue
        out_chars.append(ch)
    return ''.join(out_chars)


def parse_textgrid_intervals(path: Path):
    txt = path.read_text(encoding='utf8')
    # find words tier block similar to previous tolerant parser
    item_re = re.compile(r'item \[\d+\]:([\s\S]*?)(?=\s*item \[\d+\]:|$)', re.IGNORECASE)
    words_block = None
    for m in item_re.finditer(txt):
        block = m.group(1)
        if re.search(r'name\s*=\s*"words"', block, re.IGNORECASE):
            words_block = block
            break
    if not words_block:
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
            text = f.group(3).replace('\\"','"').replace('\\n','\n')
            intervals.append({'start': start, 'end': end, 'text': text})
    return intervals


def build_token_char_ranges(intervals: List[Dict[str,Any]]):
    """Return list of token ranges over the cleaned (punct+space removed) concat string.
    Each entry: {token_interval, startChar, endChar}
    """
    ranges = []
    pos = 0
    concat = []
    for it in intervals:
        tok = it.get('text','')
        tok_pure = remove_punct_space(tok)
        if not tok_pure:
            # token contains nothing after cleanup -> skip (no chars added)
            ranges.append({'token': it, 'startChar': None, 'endChar': None, 'pure': ''})
            continue
        start = pos
        end = pos + len(tok_pure) - 1
        ranges.append({'token': it, 'startChar': start, 'endChar': end, 'pure': tok_pure})
        concat.append(tok_pure)
        pos = end + 1
    concat_pure = ''.join(concat)
    return concat_pure, ranges


def edit_distance_bounded(a: str, b: str, limit: int) -> int:
    """Compute Levenshtein edit distance with early exit when > limit."""
    # ensure a is the shorter? we'll keep as-is
    la = len(a); lb = len(b)
    if abs(la - lb) > limit:
        return limit + 1
    # dp with two rows
    prev = list(range(lb + 1))
    for i in range(1, la + 1):
        cur = [i] + [0] * lb
        # early prune: track minimum in this row
        row_min = cur[0]
        ai = a[i - 1]
        for j in range(1, lb + 1):
            cost = 0 if ai == b[j - 1] else 1
            ins = cur[j - 1] + 1
            dele = prev[j] + 1
            sub = prev[j - 1] + cost
            v = ins if ins < dele else dele
            if sub < v:
                v = sub
            cur[j] = v
            if v < row_min:
                row_min = v
        if row_min > limit:
            return limit + 1
        prev = cur
    return prev[lb]


def main():
    if len(sys.argv) < 2:
        print('Usage: generate-paragraph-inspect-strict.py <article_tts_dir>')
        sys.exit(2)
    article_dir = Path(sys.argv[1])
    if not article_dir.exists():
        print('Article dir not found:', article_dir); sys.exit(1)

    mfa_cues_path = article_dir / 'cues.mfa.json'
    if not mfa_cues_path.exists():
        print('Missing cues.mfa.json in', article_dir); sys.exit(1)

    mfa_cues = json.loads(mfa_cues_path.read_text(encoding='utf8'))['cues']

    # group cues by chunk preserving order
    groups: Dict[str, List[Dict[str,Any]]] = {}
    for e in mfa_cues:
        groups.setdefault(e.get('chunk'), []).append(e)

    out_items = []

    for chunk_name, entries in groups.items():
        tg_path = article_dir / 'mfa_output' / (chunk_name + '.TextGrid')
        if not tg_path.exists():
            out_items.append({'chunk': chunk_name, 'error': 'missing TextGrid', 'entries': []})
            continue
        intervals = parse_textgrid_intervals(tg_path)
        concat_pure, token_ranges = build_token_char_ranges(intervals)

        # per-entry tracing list
        traces = []
        prev_end = None
        for idx, e in enumerate(entries):
            pid = e.get('paragraph_id') or e.get('id') or None
            paragraph_text = e.get('text','')
            paragraph_pure = remove_punct_space(paragraph_text)
            trace = {'paragraph_index': e.get('paragraph_index'), 'paragraph_id': pid, 'paragraph_pure': paragraph_pure, 'matched': "无法匹配", 'matched_text': None, 'matched_start': None, 'matched_end': None, 'assigned_start': None, 'assigned_end': None}

            if not paragraph_pure:
                traces.append(trace)
                continue

            idx_found = concat_pure.find(paragraph_pure)
            if idx_found == -1:
                # attempt fuzzy matching (allow up to 10 char edits)
                best = (11, None, None)  # (dist, start, wlen)
                lp = len(paragraph_pure)
                if lp > 0 and concat_pure:
                    min_w = max(1, lp - 10)
                    max_w = min(len(concat_pure), lp + 10)
                    # try window sizes from min_w..max_w
                    for wlen in range(min_w, max_w + 1):
                        # slide windows
                        limit = 10
                        for s in range(0, len(concat_pure) - wlen + 1):
                            window = concat_pure[s:s + wlen]
                            d = edit_distance_bounded(paragraph_pure, window, limit)
                            if d <= 10 and d < best[0]:
                                best = (d, s, wlen)
                                if d == 0:
                                    break
                        if best[0] == 0:
                            break
                if best[0] <= 10 and best[1] is not None:
                    # fuzzy matched
                    idx_found = best[1]
                    idx_is_fuzzy = True
                    used_wlen = best[2]
                else:
                    # no match
                    traces.append(trace)
                    continue
            else:
                idx_is_fuzzy = False

            pstart = idx_found
            pend = idx_found + len(paragraph_pure) - 1

            # find token ranges overlapping this char span
            used_tokens = [tr for tr in token_ranges if tr['startChar'] is not None and not (tr['endChar'] < pstart or tr['startChar'] > pend)]
            if not used_tokens:
                traces.append(trace)
                continue

            # use the first token's token.start and last token's token.end
            first_token = used_tokens[0]['token']
            last_token = used_tokens[-1]['token']
            matched_start = first_token.get('start')
            matched_end = last_token.get('end')

            # assigned start: for first matched paragraph in chunk set to chunk zero (0.0), otherwise use prev_end
            assigned_start = 0.0 if prev_end is None else prev_end
            assigned_end = matched_end

            # set matched flag: "精确匹配" exact, "模糊匹配" fuzzy
            if ('idx_is_fuzzy' in locals() and idx_is_fuzzy):
                matched_flag = "模糊匹配"
            else:
                matched_flag = "精确匹配"
            trace.update({'matched': matched_flag, 'matched_text': concat_pure[pstart:pend+1], 'matched_start': matched_start, 'matched_end': matched_end, 'assigned_start': assigned_start, 'assigned_end': assigned_end})
            prev_end = assigned_end
            traces.append(trace)

        out_items.append({'chunk': chunk_name, 'concat_pure': concat_pure, 'entries': traces})

    out_path = article_dir / 'paragraph-inspect-strict.json'
    out_path.write_text(json.dumps(out_items, ensure_ascii=False, indent=2), encoding='utf8')
    print('Wrote', out_path)


if __name__ == '__main__':
    main()
