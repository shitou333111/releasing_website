#!/usr/bin/env python3
"""Prepare corpus and run Montreal Forced Aligner (MFA) to align chunked TTS audio.

Usage:
  python gen-tts-align-mfa.py --dir <article_tts_dir> --dict <dict_path_or_name> --acoustic <acoustic_model>

Requirements:
  - Montreal Forced Aligner CLI installed and available as `mfa` in PATH.
    Install via conda or pipx per https://montreal-forced-aligner.readthedocs.io/
  - Python packages: textgrid (pip install textgrid)

The script will create a `mfa_corpus` directory under the article dir, copy chunk-*.orig.wav
and create matching .lab transcript files (prefer chunk-*.fixed.txt). It runs `mfa align`
and converts resulting TextGrids into `cues.mfa.json` with per-paragraph timings.
"""
from __future__ import annotations
import argparse
import os
import sys
import shutil
import subprocess
import tempfile
from pathlib import Path
import json
import uuid
import platform
import re


# Ensure this script runs inside the desired conda environment (default 'mfa').
# If not already running there, re-exec the script using `conda run -n <env> python ...`
def ensure_running_in_conda(env_name: str = None):
    if env_name is None:
        env_name = os.environ.get('MFA_CONDA_ENV', 'mfa')

    # Guard to avoid re-exec loops
    guard = 'GEN_TTS_IN_MFA'
    if os.environ.get(guard) == '1':
        return

    # Heuristics: CONDA_DEFAULT_ENV or CONDA_PREFIX may indicate active env
    cur_env = os.environ.get('CONDA_DEFAULT_ENV') or os.environ.get('CONDA_PREFIX')
    if cur_env:
        # If CONDA_DEFAULT_ENV equals desired name, we're good.
        if os.environ.get('CONDA_DEFAULT_ENV') == env_name:
            return
        # If CONDA_PREFIX ends with the env name, treat as running in env
        prefix = os.environ.get('CONDA_PREFIX') or ''
        if prefix.endswith(os.sep + env_name) or prefix.endswith(os.sep + 'envs' + os.sep + env_name):
            return

    # Otherwise attempt to re-run under conda run -n <env>
    try:
        new_env = os.environ.copy()
        new_env[guard] = '1'
        cmd = ['conda', 'run', '-n', env_name, sys.executable] + sys.argv
        print(f"Re-execing under conda env '{env_name}': {' '.join(cmd)}")
        # Use subprocess.call so the child runs visibly; pass through environment
        rc = subprocess.call(cmd, env=new_env)
        # Exit with same code as child
        sys.exit(rc)
    except FileNotFoundError:
        # `conda` not found; continue without re-exec
        print('Warning: conda executable not found; running in current environment')
    except Exception as e:
        print('Warning: failed to re-exec under conda:', e)


# By default, ensure we are running inside MFA conda env unless explicitly disabled
if os.environ.get('DISABLE_MFA_CONDA_REEXEC') != '1':
    ensure_running_in_conda()


def die(msg: str):
    print(msg, file=sys.stderr)
    sys.exit(1)


def check_mfa():
    try:
        subprocess.run(['mfa', '--version'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return True
    except Exception:
        return False



def find_chunks(article_dir: Path):
    files = sorted(article_dir.glob('chunk-*.orig.wav'))
    pairs = []
    for wav in files:
        base = wav.stem.replace('.orig', '')
        txt_fixed = article_dir / f"{base}.fixed.txt"
        txt = article_dir / f"{base}.txt"
        # Prefer the most recently-updated transcript file so freshly-written
        # `chunk-*.txt` (from the chunk generator) is used instead of an older
        # `{base}.fixed.txt` that may contain stale text (e.g., old ellipses).
        candidates = []
        if txt_fixed.exists():
            candidates.append(txt_fixed)
        if txt.exists():
            candidates.append(txt)
        if not candidates:
            continue
        # pick the newest file by modification time
        try:
            transcript = max(candidates, key=lambda p: p.stat().st_mtime)
        except Exception:
            # fallback: prefer explicit fixed, then txt
            transcript = txt_fixed if txt_fixed.exists() else txt
        pairs.append((wav, transcript, base))
    return pairs


def prepare_corpus(pairs, corpus_dir: Path):
    corpus_dir.mkdir(parents=True, exist_ok=True)
    for wav, transcript, base in pairs:
        target_wav = corpus_dir / f"{base}.wav"
        shutil.copy2(wav, target_wav)
        # write lab file with raw transcript (no frontmatter)
        with open(transcript, 'r', encoding='utf8') as f:
            text = f.read().strip()
        # Temporarily disable Traditional->Simplified conversion for debugging
        # Convert Traditional Chinese to Simplified for MFA input if possible
        # try:
        #     text = convert_traditional_to_simplified(text)
        # except Exception:
        #     # if conversion fails, continue with original text
        #     pass
        # Normalize ellipsis variants (unicode '…' or ASCII '...') to a Chinese comma
        try:
            text = re.sub(r'(?:\u2026+|\.{3,})', '，', text)
        except Exception:
            pass
        lab_path = corpus_dir / f"{base}.lab"
        with open(lab_path, 'w', encoding='utf8') as f:
            f.write(text + '\n')


def write_article_labs(article_dir: Path, pairs):
    """Ensure article-level `mfa_corpus` contains up-to-date .lab files
    derived from the newest available transcript files (preferring
    `chunk-*.txt` over older `chunk-*.fixed.txt`). This helps debugging
    and ensures persistent lab files are available even when MFA runs in
    a temporary working directory.
    """
    article_corpus = article_dir / 'mfa_corpus'
    article_corpus.mkdir(parents=True, exist_ok=True)
    for wav, transcript, base in pairs:
        # prefer most recently modified transcript file in article_dir
        txt_fixed = article_dir / f"{base}.fixed.txt"
        txt = article_dir / f"{base}.txt"
        candidates = []
        if txt_fixed.exists():
            candidates.append(txt_fixed)
        if txt.exists():
            candidates.append(txt)
        if not candidates:
            continue
        try:
            chosen = max(candidates, key=lambda p: p.stat().st_mtime)
        except Exception:
            chosen = txt if txt.exists() else txt_fixed
        try:
            text = chosen.read_text(encoding='utf8').strip()
        except Exception:
            continue
        # Temporarily disable Traditional->Simplified conversion for debugging
        # try:
        #     text = convert_traditional_to_simplified(text)
        # except Exception:
        #     pass
        # Normalize ellipsis variants to Chinese comma for consistency
        try:
            text = re.sub(r'(?:\u2026+|\.{3,})', '，', text)
        except Exception:
            pass
        lab_path = article_corpus / f"{base}.lab"
        try:
            lab_path.write_text(text + '\n', encoding='utf8')
        except Exception:
            pass


def convert_traditional_to_simplified(text: str) -> str:
    """Attempt to convert Traditional Chinese to Simplified.
    Tries Python `opencc` module first, then falls back to system `opencc` CLI if present.
    If neither is available, returns the original text unchanged.
    """
    # Try python opencc
    converted = None
    try:
        from opencc import OpenCC
        conv = OpenCC('t2s')
        converted = conv.convert(text)
    except Exception:
        pass

    # Try system `opencc` command if python module not available
    if converted is None:
        try:
            import subprocess, shlex
            p = subprocess.Popen(['opencc', '-i', '/dev/stdin', '-c', 't2s.json'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            out, _ = p.communicate(text.encode('utf8'))
            if p.returncode == 0:
                converted = out.decode('utf8')
        except Exception:
            pass

    # If no converter available, fall back to original text
    if converted is None:
        converted = text

    # Apply explicit small mappings that MFA may need (ensure 瞭 -> 了)
    # try:
    #     converted = converted.replace('瞭', '了')
    # except Exception:
    #     pass

    return converted


def convert_textgrids_in_dir(dirpath: Path):
    """Load each TextGrid in dirpath and convert all interval marks from
    Traditional Chinese to Simplified in-place.
    """
    try:
        from textgrid import TextGrid
    except Exception:
        print('textgrid package not available; skipping TextGrid conversion')
        return

    tg_files = list(dirpath.glob('*.TextGrid'))
    if not tg_files:
        return

    # Remove any existing backup files left from prior runs (we prefer
    # direct in-place overwrite without creating .bak copies).
    try:
        bak_files = list(dirpath.glob('*.TextGrid.bak'))
        for bf in bak_files:
            try:
                bf.unlink()
            except Exception:
                pass
        if bak_files:
            print(f'Removed {len(bak_files)} existing .TextGrid.bak files')
    except Exception:
        pass

    for tg in tg_files:
        try:
            tgobj = TextGrid.fromFile(str(tg))
            changed = False
            for tier in tgobj.tiers:
                if not hasattr(tier, 'intervals'):
                    continue
                for iv in tier.intervals:
                    if hasattr(iv, 'mark') and iv.mark and iv.mark.strip():
                        new = convert_traditional_to_simplified(iv.mark)
                        if new != iv.mark:
                            iv.mark = new
                            changed = True
            if changed:
                # write back (TextGrid.write handles ascii-safe format)
                tgobj.write(str(tg))
                print('Converted TextGrid:', tg)
        except Exception as e:
            print('Failed converting', tg, e)


def strip_phones_tier(dirpath: Path):
    """Remove item blocks whose name is 'phones' from TextGrid files to reduce size.
    This edits files in-place: it filters out the matching item blocks, reindexes
    remaining items, and updates the `size = N` header accordingly.
    """
    import re

    tg_files = list(dirpath.glob('*.TextGrid'))
    if not tg_files:
        return

    # Match item blocks including possible leading whitespace
    item_block_re = re.compile(r'(\s*item \[\d+\]:[\s\S]*?)(?=\s*item \[\d+\]:|$)', re.IGNORECASE)
    name_phones_re = re.compile(r'name\s*=\s*"phones"', re.IGNORECASE)
    size_re = re.compile(r'size\s*=\s*\d+', re.IGNORECASE)

    for tg in tg_files:
        try:
            txt = tg.read_text(encoding='utf8')
            # find header / items split
            m = re.search(r'item \[', txt)
            if not m:
                continue
            header = txt[:m.start()]
            items_part = txt[m.start():]
            blocks = item_block_re.findall(items_part)
            if not blocks:
                continue
            # filter out phones blocks
            filtered = [b for b in blocks if not name_phones_re.search(b)]
            if len(filtered) == len(blocks):
                # nothing removed
                continue

            # reindex items and join, preserving indentation
            new_items = []
            for i, b in enumerate(filtered, start=1):
                def repl(m):
                    indent = m.group(1) or ''
                    return f"{indent}item [{i}]:"
                new_block = re.sub(r'^(\s*)item \[\d+\]:', repl, b, count=1, flags=re.MULTILINE)
                new_items.append(new_block)

            # ensure there is a trailing newline between items as in original
            new_items_part = '\n'.join(new_items) + '\n'
            # update size in header
            new_header = size_re.sub(f'size = {len(filtered)}', header, count=1)
            new_txt = new_header + new_items_part
            tg.write_text(new_txt, encoding='utf8')
            print('Stripped phones tier from', tg)
        except Exception as e:
            print('Failed stripping phones from', tg, e)


def _fallback_parse_textgrid(path: Path):
    """Fallback parser that extracts intervals from the 'words' IntervalTier
    using a regex-based scan. Returns list of {start,end,text} intervals.
    This is tolerant of minor formatting issues that the `textgrid` module
    may reject.
    """
    import re
    txt = path.read_text(encoding='utf8')
    # find the item block for words (case-insensitive)
    item_re = re.compile(r'item \[\d+\]:([\s\S]*?)(?=\s*item \[\d+\]:|$)', re.IGNORECASE)
    words_block = None
    for m in item_re.finditer(txt):
        block = m.group(1)
        if re.search(r'name\s*=\s*"words"', block, re.IGNORECASE):
            words_block = block
            break
    if not words_block:
        return []
    intervals = []
    interval_re = re.compile(r'intervals \[\d+\]:([\s\S]*?)(?=intervals \[\d+\]:|$)', re.IGNORECASE)
    field_re = re.compile(r'xmin\s*=\s*([0-9.eE+-]+)[\s\S]*?xmax\s*=\s*([0-9.eE+-]+)[\s\S]*?text\s*=\s*"([\s\S]*?)"', re.IGNORECASE)
    for im in interval_re.finditer(words_block):
        block = im.group(1)
        f = field_re.search(block)
        if f:
            try:
                start = float(f.group(1))
                end = float(f.group(2))
            except Exception:
                continue
            text = f.group(3).replace('\\"', '"').replace('\\n', '\n').strip()
            if text:
                intervals.append({'start': start, 'end': end, 'text': text})
    return intervals


def run_mfa(corpus_dir: Path, dictionary: str, acoustic_model: str, output_dir: Path, *, conda_env: str | None = None, mfa_cmd: str | None = None, mfa_opts: str | None = None, cwd: Path | None = None, env: dict | None = None):
    """Invoke MFA. If `conda_env` is provided, run via `conda run -n <env> ...`.
    If `mfa_cmd` is provided, it will be used as the MFA executable (can be a full path or a wrapper command).
    `mfa_opts` if provided is split and appended to the command.
    """
    import shlex

    base = mfa_cmd if mfa_cmd else 'mfa'
    # allow mfa_cmd to contain spaces/arguments (split it)
    base_parts = shlex.split(base)
    # On Windows, MFA can choke on non-ASCII paths; convert to short (8.3) paths when available
    def _short(p: Path) -> str:
        pstr = str(p)
        if platform.system().lower().startswith('win'):
            try:
                import ctypes
                buf = ctypes.create_unicode_buffer(260)
                get_short = ctypes.windll.kernel32.GetShortPathNameW
                res = get_short(pstr, buf, 260)
                if res and res > 0:
                    return buf.value
            except Exception:
                pass
        return pstr

    align_parts = base_parts + ['align', _short(corpus_dir), dictionary, acoustic_model, _short(output_dir)]
    # append user-provided MFA options (if any). Do NOT force --clean here;
    # callers may wish to control --clean/--jobs externally via --mfa-opts.
    if mfa_opts:
        align_parts += shlex.split(mfa_opts)
    if conda_env:
        # Use --no-capture-output so MFA logs stream directly through conda run
        cmd = ['conda', 'run', '--no-capture-output', '-n', conda_env] + align_parts
    else:
        cmd = align_parts
    print('Running:', ' '.join(cmd), 'cwd=' + (str(cwd) if cwd else os.getcwd()))
    # Let output stream to parent so progress logs and warnings are visible
    subprocess.run(cmd, check=True, cwd=(str(cwd) if cwd else None), env=env)


def parse_textgrid(textgrid_path: Path):
    try:
        from textgrid import TextGrid
    except Exception:
        die('Missing Python package `textgrid`. Install with `pip install textgrid`')
    try:
        tg = TextGrid.fromFile(str(textgrid_path))
    except Exception as e:
        # Fallback to a regex-based tolerant parser for slightly malformed TextGrids
        try:
            return _fallback_parse_textgrid(textgrid_path)
        except Exception:
            # re-raise original for visibility
            raise

    # prefer tier named 'words' or 'word'
    tier = None
    for tname in ('words', 'word', 'Words'):
        for t in tg.tiers:
            if t.name.lower() == tname.lower():
                tier = t
                break
        if tier:
            break
    if tier is None:
        # fallback: use first interval tier
        for t in tg.tiers:
            if hasattr(t, 'intervals'):
                tier = t
                break
    if tier is None:
        return []
    intervals = []
    for interval in tier.intervals:
        try:
            text = (interval.mark or '').strip()
        except Exception:
            text = ''
        if not text:
            continue
        intervals.append({'start': interval.minTime, 'end': interval.maxTime, 'text': text})
    return intervals


def remove_punct_space(s: str) -> str:
    if not s:
        return ''
    out_chars = []
    import unicodedata
    for ch in s:
        if ch.isspace():
            continue
        cat = unicodedata.category(ch)
        if cat and cat.startswith('P'):
            continue
        out_chars.append(ch)
    return ''.join(out_chars)


def build_token_char_ranges_from_intervals(intervals):
    ranges = []
    pos = 0
    concat_parts = []
    for it in intervals:
        tok = it.get('text', '')
        tok_pure = remove_punct_space(tok)
        if not tok_pure:
            ranges.append({'token': it, 'startChar': None, 'endChar': None, 'pure': ''})
            continue
        start = pos
        end = pos + len(tok_pure) - 1
        ranges.append({'token': it, 'startChar': start, 'endChar': end, 'pure': tok_pure})
        concat_parts.append(tok_pure)
        pos = end + 1
    concat_pure = ''.join(concat_parts)
    return concat_pure, ranges


def edit_distance_bounded(a: str, b: str, limit: int) -> int:
    la = len(a); lb = len(b)
    if abs(la - lb) > limit:
        return limit + 1
    prev = list(range(lb + 1))
    for i in range(1, la + 1):
        cur = [i] + [0] * lb
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


def build_cues_from_alignments(pairs, mfa_output_dir: Path, pause_token: str = '\n'):
    cues = []
    import hashlib
    for wav, transcript, base in pairs:
        tg_path = mfa_output_dir / f"{base}.TextGrid"
        if not tg_path.exists():
            print('Missing TextGrid for', base)
            continue
        intervals = parse_textgrid(tg_path)
        # Build cleaned token char stream (punctuation and spaces removed)
        concat_pure, token_char_ranges = build_token_char_ranges_from_intervals(intervals)

        # Paragraph split
        with open(transcript, 'r', encoding='utf8') as f:
            text = f.read()
        paragraphs = [p for p in re.split(re.escape(pause_token), text) if p and p.strip()]

        # Prepare paragraph objects with stable id
        para_objs = []
        for p in paragraphs:
            pid = hashlib.md5(p.encode('utf8')).hexdigest()[:10]
            para_objs.append({'id': pid, 'text': p})

        # Sequential mapping using strict char-match on cleaned strings, with bounded fuzzy fallback
        search_pos = 0
        prev_end_time = None
        for i, pobj in enumerate(para_objs):
            p = pobj['text']
            p_pure = remove_punct_space(p)
            if not p_pure:
                cues.append({'chunk': base, 'paragraph_index': i, 'paragraph_id': pobj['id'], 'start': None, 'end': None, 'aligned': False, 'text': p, 'match_type': '无法匹配'})
                continue

            idx_found = concat_pure.find(p_pure, search_pos)
            idx_is_fuzzy = False
            used_wlen = None
            if idx_found == -1:
                # attempt bounded fuzzy matching (allow up to 10 edits)
                best = (11, None, None)
                lp = len(p_pure)
                if lp > 0 and concat_pure:
                    min_w = max(1, lp - 10)
                    max_w = min(len(concat_pure), lp + 10)
                    limit = 10
                    for wlen in range(min_w, max_w + 1):
                        # slide windows
                        for s in range(0, len(concat_pure) - wlen + 1):
                            window = concat_pure[s:s + wlen]
                            d = edit_distance_bounded(p_pure, window, limit)
                            if d <= 10 and d < best[0]:
                                best = (d, s, wlen)
                                if d == 0:
                                    break
                        if best[0] == 0:
                            break
                if best[0] <= 10 and best[1] is not None:
                    idx_found = best[1]
                    idx_is_fuzzy = True
                    used_wlen = best[2]

            if idx_found == -1:
                # no match found
                cues.append({'chunk': base, 'paragraph_index': i, 'paragraph_id': pobj['id'], 'start': None, 'end': None, 'aligned': False, 'text': p, 'match_type': '无法匹配'})
                continue

            pstart = idx_found
            pend = idx_found + len(p_pure) - 1
            # advance search_pos to preserve order
            search_pos = pend + 1

            # find token ranges overlapping this char span
            used_tokens = [tr for tr in token_char_ranges if tr['startChar'] is not None and not (tr['endChar'] < pstart or tr['startChar'] > pend)]
            if not used_tokens:
                # no timed tokens overlapping; mark unaligned but keep match_type
                # If this is the first matched paragraph in the chunk (no prev_end_time),
                # assign start to chunk zero (0.0). Otherwise use prev_end_time.
                start = 0.0 if prev_end_time is None else prev_end_time
                cues.append({'chunk': base, 'paragraph_index': i, 'paragraph_id': pobj['id'], 'start': start, 'end': None, 'aligned': False, 'text': p, 'match_type': ('模糊匹配' if idx_is_fuzzy else '精确匹配')})
                continue

            first_token = used_tokens[0]['token']
            last_token = used_tokens[-1]['token']
            matched_start = first_token.get('start')
            matched_end = last_token.get('end')

            # set assigned_start: if no previous aligned paragraph in this chunk, use chunk zero (0.0)
            assigned_start = 0.0 if prev_end_time is None else prev_end_time
            cues.append({'chunk': base, 'paragraph_index': i, 'paragraph_id': pobj['id'], 'start': assigned_start, 'end': matched_end, 'aligned': True, 'text': p, 'match_type': ('模糊匹配' if idx_is_fuzzy else '精确匹配')})
            prev_end_time = matched_end
    return cues


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--dir', required=True, help='Article tts directory (contains chunk-*.orig.wav and chunk-*.txt)')
    p.add_argument('--dict', required=True, help='Pronunciation dictionary path or name for MFA')
    p.add_argument('--acoustic', required=True, help='Acoustic model name or path for MFA')
    p.add_argument('--out', help='Output cues JSON path (defaults to cues.mfa.json in dir)')
    p.add_argument('--pause', default='\n', help='Pause token used between paragraphs')
    p.add_argument('--convert-textgrids-only', action='store_true', help='Only convert existing TextGrid files in mfa_output from Traditional->Simplified and exit')
    p.add_argument('--conda-env', help='Optional conda environment name to run MFA in (uses `conda run -n <env> ...`)')
    p.add_argument('--mfa-cmd', help='Optional custom MFA command or path (overrides `mfa` executable)')
    p.add_argument('--mfa-opts', help='Optional extra MFA CLI options to append to the align command (e.g. "--fast --beam 10")')
    p.add_argument('--keep-tmp', action='store_true', help='Keep temporary MFA run directory for debugging (do not delete tmp_run)')
    args = p.parse_args()

    # Normalize MFA options:
    # - `--single_speaker` may be added when user requests multiple `--jobs`
    mfa_opts = args.mfa_opts or ''
    import shlex
    mfa_tokens = shlex.split(mfa_opts)
    # By default, ensure MFA is invoked with `--clean` to perform a clean run.
    # This is the default destructive behavior; callers can omit it by
    # explicitly passing `--mfa-opts` that override or remove `--clean`.
    if '--clean' not in mfa_tokens:
        mfa_tokens.append('--clean')
    # detect requested jobs value
    jobs_val = None
    if '--jobs' in mfa_tokens:
        try:
            idx = mfa_tokens.index('--jobs')
            if idx + 1 < len(mfa_tokens):
                jobs_val = int(mfa_tokens[idx + 1])
        except Exception:
            jobs_val = None
    # if jobs requested > 1 and --single_speaker not present, add it to allow splitting
    if jobs_val and jobs_val > 1 and '--single_speaker' not in mfa_tokens:
        mfa_tokens += ['--single_speaker']
    mfa_opts = ' '.join(mfa_tokens)

    article_dir = Path(args.dir)
    if not article_dir.exists():
        die('Article dir not found: ' + str(article_dir))

    # MFA is expected to be installed and available in PATH; do not check here per user request.

    pairs = find_chunks(article_dir)
    if not pairs:
        die('No chunk-*.orig.wav + chunk-*.txt pairs found in ' + str(article_dir))

    # To avoid MFA problems with non-ASCII paths, create a temporary ASCII-only
    # working directory on the same drive (root) and run MFA there. After the
    # run, copy the MFA output back to the article directory.
    drive_root = Path(article_dir.anchor or Path.cwd().anchor)
    tmp_run = drive_root / f"mfa_run_{uuid.uuid4().hex[:8]}"
    tmp_corpus = tmp_run / 'mfa_corpus'
    tmp_output = tmp_run / 'mfa_output'
    try:
        if tmp_run.exists():
            shutil.rmtree(tmp_run)
        tmp_run.mkdir(parents=True, exist_ok=True)
        print('Temporary run dir:', tmp_run)
        prepare_corpus(pairs, tmp_corpus)
        # Also write article-level labs from the newest chunk transcripts so
        # `docs/.../mfa_corpus` contains persistent .lab files for auditing
        # and for cases where MFA is later run in-place.
        try:
            write_article_labs(article_dir, pairs)
        except Exception:
            pass

        # ensure no pre-existing output path in target dir (do not pass --clean to MFA)
        target_output = article_dir / 'mfa_output'
        if target_output.exists():
            shutil.rmtree(target_output)

        # set HOME/USERPROFILE to tmp_run so MFA uses the temporary directory
        run_env = os.environ.copy()
        # Try running MFA inside tmp_run first. If it fails due to existing MFA
        # workspace / missing intermediate files, fall back to running MFA in
        # the article dir with a --clean option appended (do not force this by
        # default; only use it as a recovery path).
        try:
            run_mfa(tmp_corpus, args.dict, args.acoustic, tmp_output, conda_env=args.conda_env, mfa_cmd=args.mfa_cmd, mfa_opts=mfa_opts, cwd=tmp_run, env=run_env)
        except subprocess.CalledProcessError as e:
            print('MFA run in temporary dir failed; retrying in article dir with --clean appended')
            # prepare a corpus in the article dir and run MFA there with --clean
            article_corpus = article_dir / 'mfa_corpus'
            if article_corpus.exists():
                shutil.rmtree(article_corpus)
            prepare_corpus(pairs, article_corpus)
            article_output = article_dir / 'mfa_output'
            if article_output.exists():
                shutil.rmtree(article_output)
            # Retry in article dir without appending --clean (do not force a clean run)
            fallback_opts = mfa_opts
            run_mfa(article_corpus, args.dict, args.acoustic, article_output, conda_env=args.conda_env, mfa_cmd=args.mfa_cmd, mfa_opts=fallback_opts)
            # use article_output for subsequent steps
            tmp_output = article_output

        # move tmp_output -> target_output
        if tmp_output.exists():
            shutil.move(str(tmp_output), str(target_output))
        else:
            die('MFA did not produce output in temporary directory')
        # Strip unnecessary 'phones' tier from TextGrids to reduce file size
        try:
            import re
            strip_phones_tier(target_output)
        except Exception as e:
            print('Warning: TextGrid phones-strip step failed', e)

        # Temporarily skip converting TextGrid contents from Traditional to Simplified
        # (keep TextGrids as-produced by MFA for inspection)
        # try:
        #     convert_textgrids_in_dir(target_output)
        # except Exception as e:
        #     print('Warning: TextGrid conversion step failed', e)

        # After converting TextGrids to Simplified, generate human-readable SRTs
        # from the TextGrid files so QA can inspect alignments. This calls the
        # repository's Node converter `textgrid-to-srt.cjs` located in the
        # same `.vitepress` directory.
        try:
            node_script = Path(__file__).resolve().parent / 'textgrid-to-srt.cjs'
            cmd = ['node', str(node_script), str(article_dir)]
            print('Running SRT generation:', ' '.join(cmd))
            subprocess.run(cmd, check=True)
        except Exception as e:
            print('Warning: SRT generation step failed', e)

        cues = build_cues_from_alignments(pairs, target_output, pause_token=args.pause)
    finally:
        # cleanup temporary run directory unless user requested to keep it
        try:
            if not args.keep_tmp:
                if tmp_run.exists():
                    shutil.rmtree(tmp_run)
            else:
                print('Keeping temporary run dir for inspection:', tmp_run)
        except Exception:
            pass
    out_path = Path(args.out) if args.out else article_dir / 'cues.mfa.json'
    with open(out_path, 'w', encoding='utf8') as f:
        json.dump({'source': str(article_dir), 'count': len(cues), 'cues': cues}, f, ensure_ascii=False, indent=2)
    print('Wrote', out_path)


if __name__ == '__main__':
    main()
