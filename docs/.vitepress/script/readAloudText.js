const CIRCLED_FOOTNOTE_REGEX = /[①②③④⑤⑥⑦⑧⑨⑩]/g;
const HTML_TAG_REGEX = /<[^>]+>/g;
const BR_TAG_REGEX = /<br\s*\/?>/gi;
const WHITESPACE_REGEX = /\s+/g;

export function removeCircledFootnotes(input) {
  return String(input || '').replace(CIRCLED_FOOTNOTE_REGEX, '');
}

export function normalizeWhitespace(input) {
  return String(input || '')
    .replace(/\u00a0/g, ' ')
    .replace(WHITESPACE_REGEX, ' ')
    .trim();
}

export function stripInlineHtml(input) {
  return String(input || '')
    .replace(BR_TAG_REGEX, '\n')
    .replace(HTML_TAG_REGEX, ' ');
}

export function cleanTextForTTS(input) {
  const text = stripInlineHtml(input);
  const withoutFootnotes = removeCircledFootnotes(text);
  // Additional normalization rules for MD -> transcript extraction:
  // 1) Replace various ellipsis forms (unicode '…', repeated '……', or '...') with a Chinese comma '，'
  let normalized = String(withoutFootnotes || '')
    .replace(/(?:\u2026+|\.{3,})/g, '，');

  return normalizeWhitespace(normalized);
}

// FNV-1a 32-bit hash, deterministic for fast fingerprint matching.
export function createStableFingerprint(input) {
  const text = normalizeWhitespace(input);
  let hash = 0x811c9dc5;

  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }

  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function splitTTSChunks(input, maxChars = 260) {
  const text = normalizeWhitespace(input);
  if (!text) return [];
  if (text.length <= maxChars) return [text];

  const punctuation = new Set(['。', '！', '？', '；', ';', '.', '!', '?', '：', ':']);
  const chunks = [];
  let start = 0;

  // Try to avoid splitting mid-sentence: prefer the nearest sentence-ending
  // punctuation before the maxChars limit; if none found, allow a small
  // forward lookahead to find the next punctuation and split there instead
  // of cutting in the middle of a sentence.
  const LOOKAHEAD = 80;

  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);

    if (end < text.length) {
      let splitAt = -1;
      // search backward first
      for (let i = end - 1; i >= start; i--) {
        if (punctuation.has(text[i])) {
          splitAt = i + 1;
          break;
        }
      }

      // if no punctuation found backward, try a short forward lookahead
      if (splitAt <= start) {
        const forwardLimit = Math.min(text.length, end + LOOKAHEAD);
        for (let i = end; i < forwardLimit; i++) {
          if (punctuation.has(text[i])) {
            splitAt = i + 1;
            break;
          }
        }
      }

      if (splitAt > start) {
        end = splitAt;
      }
    }

    const chunk = normalizeWhitespace(text.slice(start, end));
    if (chunk) chunks.push(chunk);
    start = end;
  }

  return chunks;
}
