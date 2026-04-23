import fs from 'fs';
import path from 'path';
import MarkdownIt from 'markdown-it';
import implicitFigures from 'markdown-it-implicit-figures';
import { cleanTextForTTS } from './shared/readAloudText.js';

const mdPath = path.resolve('docs/书/决定自由.md');
const md = new MarkdownIt({ html: true });
md.use(implicitFigures, { figcaption: 'Title', keepAlt: true });

const raw = fs.readFileSync(mdPath, 'utf8');
const body = raw;
const tokens = md.parse(body, {});

function extractInlineText(inlineToken) {
  const children = Array.isArray(inlineToken.children) ? inlineToken.children : [];
  let text = '';
  for (const child of children) {
    if (child.type === 'image') continue;
    if (child.type === 'text' || child.type === 'code_inline' || child.type === 'html_inline') text += child.content || '';
    if (child.type === 'softbreak' || child.type === 'hardbreak') text += '\n';
  }
  return text;
}

const segments = [];
let blockquoteDepth = 0;
let index = 0;
for (let i = 0; i < tokens.length; i++) {
  const token = tokens[i];
  if (token.type === 'blockquote_open') { blockquoteDepth += 1; continue; }
  if (token.type === 'blockquote_close') { blockquoteDepth = Math.max(0, blockquoteDepth - 1); continue; }
  if (blockquoteDepth > 0) continue;
  const isHeading = token.type === 'heading_open' && /^h[2-6]$/.test(token.tag);
  const isParagraph = token.type === 'paragraph_open';
  if (!isHeading && !isParagraph) continue;
  const inlineToken = tokens[i + 1]; if (!inlineToken || inlineToken.type !== 'inline') continue;
  let rawText = extractInlineText(inlineToken);
  try { rawText = rawText.replace(/<sup\b[^>]*>.*?<\/sup>/gis, ''); } catch (e) {}
  const cleanText = cleanTextForTTS(rawText);
  if (!cleanText) continue;
  const segment = { id: `p-${String(index+1).padStart(5,'0')}`, index, type: isHeading? 'heading':'paragraph', tag: isHeading? token.tag:'p', rawText, cleanText };
  segments.push(segment); index += 1;
}

// simple chunking
const MAX_CHARS_PER_CHUNK = 2000;
const PAUSE_TOKEN = '\n';
const chunks = [];
let current = { text: '', segments: [] };
for (const seg of segments) {
  const segLen = (seg.cleanText || '').length;
  if (!current.segments.length) { current.segments.push(seg); current.text = seg.cleanText; }
  else {
    const attemptLen = current.text.length + PAUSE_TOKEN.length + segLen;
    if (attemptLen <= MAX_CHARS_PER_CHUNK) { current.text = current.text + PAUSE_TOKEN + seg.cleanText; current.segments.push(seg); }
    else { chunks.push(current); current = { text: seg.cleanText, segments: [seg] }; }
  }
}
if (current.segments.length) chunks.push(current);

console.log('chunks', chunks.length);
// print chunk 14 (index 13) if exists
const ci = 13;
if (chunks[ci]) {
  console.log('CHUNK-014 TEXT:\n', chunks[ci].text.slice(0,500));
} else {
  console.log('no chunk 14');
}
