#!/usr/bin/env python3
"""Align chunked Chinese audio+transcript using WhisperX (word-level timings).

Usage:
  python align-with-whisperx.py --dir <tts_article_dir>
  or
  python align-with-whisperx.py --audio <wav> --transcript <txt> --out <json>

The script attempts to import whisperx and whisper. If not installed, it prints
instructions. Outputs per-chunk JSON files with word timings and a combined
`cues.whisperx.json` in the article directory.
"""
import sys
import os
import json
import argparse

def missing(msg):
    print(msg, file=sys.stderr)
    sys.exit(1)

def ensure_whisperx():
    try:
        import whisperx
        import whisper
        return whisperx, whisper
    except Exception as e:
        missing("Required packages not found. Install with:\n\npython -m pip install -U openai-whisper whisperx ffmpeg-python\n# and a suitable torch build, see WhisperX docs\n")

def align_pair(whisperx, whisper, audio_path, transcript_path, device='cpu'):
    # Read transcript
    with open(transcript_path, 'r', encoding='utf8') as f:
        transcript = f.read().strip()
    # Run whisper transcription (to get segments)
    model = whisperx.load_model("small", device)
    result = model.transcribe(audio_path)
    # Load alignment model
    language = result.get('language', 'zh')
    align_model, metadata = whisperx.load_align_model(language_code=language, device=device)
    result_aligned = whisperx.align(result['segments'], align_model, metadata, audio_path, device)
    # result_aligned['word_segments'] contains words with start/end
    out = {
        'audio': os.path.basename(audio_path),
        'transcript': os.path.basename(transcript_path),
        'language': language,
        'words': result_aligned.get('word_segments', []),
        'segments': result_aligned.get('segments', [])
    }
    return out

def process_dir(dirpath):
    whisperx, whisper = ensure_whisperx()
    files = os.listdir(dirpath)
    pairs = []
    for name in files:
        if name.endswith('.orig.wav'):
            base = name[:-9]
            wav = os.path.join(dirpath, name)
            txt = os.path.join(dirpath, base + '.txt')
            if os.path.exists(txt):
                pairs.append((wav, txt, base))
    pairs.sort()
    combined_cues = []
    for wav, txt, base in pairs:
        print('Aligning', base)
        out = align_pair(whisperx, whisper, wav, txt)
        out_path = os.path.join(dirpath, base + '.whisperx.json')
        with open(out_path, 'w', encoding='utf8') as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
        # Map words to paragraphs by splitting transcript on double-newline (or single newline)
        # This is a best-effort; post-processing may be needed.
        combined_cues.append({ 'chunk': base, 'file': out_path, 'words': len(out.get('words', [])) })
    # Write combined summary
    summary_path = os.path.join(dirpath, 'cues.whisperx.json')
    with open(summary_path, 'w', encoding='utf8') as f:
        json.dump({ 'items': combined_cues }, f, ensure_ascii=False, indent=2)
    print('Wrote', summary_path)

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--dir', help='Article tts directory (contains chunk-*.orig.wav and chunk-*.txt)')
    p.add_argument('--audio')
    p.add_argument('--transcript')
    p.add_argument('--out')
    args = p.parse_args()
    if args.dir:
        if not os.path.isdir(args.dir):
            missing('Directory not found: ' + args.dir)
        process_dir(args.dir)
        return
    if args.audio and args.transcript and args.out:
        whisperx, whisper = ensure_whisperx()
        out = align_pair(whisperx, whisper, args.audio, args.transcript)
        with open(args.out, 'w', encoding='utf8') as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
        print('Wrote', args.out)
        return
    p.print_help()

if __name__ == '__main__':
    main()
