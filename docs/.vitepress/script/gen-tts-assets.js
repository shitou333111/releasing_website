#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import MarkdownIt from 'markdown-it';
import implicitFigures from 'markdown-it-implicit-figures';
import {
  cleanTextForTTS,
  createStableFingerprint,
  normalizeWhitespace,
  splitTTSChunks
} from './readAloudText.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Load .env-like files from repo root and cwd to populate process.env when needed.
function loadDotEnvFiles() {
  try {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const candidates = [
      path.join(repoRoot, '.env'),
      path.join(repoRoot, '.env.local'),
      path.join(process.cwd(), '.env'),
      path.join(process.cwd(), '.env.local')
    ];
    for (const envPath of candidates) {
      if (!fs.existsSync(envPath)) continue;
      try {
        const content = fs.readFileSync(envPath, 'utf8');
        for (const rawLine of content.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line || line.startsWith('#')) continue;
          const idx = line.indexOf('=');
          if (idx === -1) continue;
          const key = line.slice(0, idx).trim();
          let val = line.slice(idx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (!(key in process.env) || !process.env[key]) {
            process.env[key] = val;
          }
        }
      } catch (e) {
        console.warn('Unable to read env file', envPath, e?.message || e);
      }
    }
  } catch (e) {
    console.warn('Error loading env files:', e?.message || e);
  }
}
loadDotEnvFiles();

function isoLocalWithOffset(date) {
  const d = date || new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());
  const ms = String((d.getMilliseconds() || 0)).padStart(3, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const offH = pad(Math.floor(Math.abs(offsetMin) / 60));
  const offM = pad(Math.abs(offsetMin) % 60);
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${ms}${sign}${offH}:${offM}`;
}

const docsRoot = path.resolve(__dirname, '..');
const outputRoot = path.resolve(docsRoot, 'public/tts');
const manifestPath = path.join(outputRoot, 'manifest.json');
const cacheFile = path.resolve(__dirname, 'tts-cache.json');
const cacheAudioDir = path.resolve(__dirname, 'tts-cache-audio');

const MIMO_API_KEY = process.env.MIMO_API_KEY?.trim() || '';
// Choose base URL based on API key type per MiMo docs (pay-as-you-go: sk-..., token plan: tp-...)
const DEFAULT_MIMO_BASE = 'https://api.xiaomimimo.com/v1';
const TOKEN_PLAN_BASE = 'https://token-plan-cn.xiaomimimo.com/v1';
const envProvidedUrl = process.env.MIMO_API_URL?.trim();
let selectedBase = DEFAULT_MIMO_BASE;
if (envProvidedUrl) {
  selectedBase = envProvidedUrl;
} else if (MIMO_API_KEY.startsWith('tp-')) {
  selectedBase = TOKEN_PLAN_BASE;
}
const MIMO_API_URL = `${selectedBase.replace(/\/+$/, '')}/chat/completions`;
const MIMO_TTS_MODEL = process.env.MIMO_TTS_MODEL?.trim() || 'mimo-v2-tts';
const MIMO_TTS_VOICE = process.env.MIMO_TTS_VOICE?.trim() || 'mimo_default';
const MIMO_TTS_STYLE = process.env.MIMO_TTS_STYLE?.trim() || '温暖 平和 宁静 沉稳';
const MIMO_TTS_SYSTEM_PROMPT = process.env.MIMO_TTS_SYSTEM_PROMPT?.trim()
  || '你是专业的中文有声朗读助手。你的声音呈现为女性心理学导师，温暖、平和、令人宁静，语速中等偏慢，停连自然。';
const MIMO_TTS_USER_PROMPT = process.env.MIMO_TTS_USER_PROMPT?.trim()
  || '请以女性心理学导师的口吻朗读以下文本：语气温暖、平和、包容，给听者安全感和被理解感，避免夸张情绪与强烈戏剧化表达。';
const MIMO_TTS_TEMPERATURE = process.env.MIMO_TTS_TEMPERATURE ? Number(process.env.MIMO_TTS_TEMPERATURE) : 0.3;
const MIMO_TTS_TOP_P = process.env.MIMO_TTS_TOP_P ? Number(process.env.MIMO_TTS_TOP_P) : 0.5;
// Determine sensible default for max chars per TTS request.
// Use environment override if provided; otherwise pick a safe default based on model limits.
let defaultMaxChars = 260;
try {
  const modelName = (process.env.MIMO_TTS_MODEL || MIMO_TTS_MODEL || '').toLowerCase();
  if (modelName.includes('mimo-v2-tts')) {
    // MiMo v2 TTS: context 8K. Reserve some space for prompts/style/meta.
    // Use a conservative default of 6000 characters to avoid hitting context limits.
    defaultMaxChars = 6000;
  }
} catch (e) {
  // fallback to small default
  defaultMaxChars = 260;
}
const MAX_CHARS_PER_CHUNK = Number(process.env.MIMO_TTS_MAX_CHARS || defaultMaxChars);
console.log(`TTS chunk size configured: MAX_CHARS_PER_CHUNK=${MAX_CHARS_PER_CHUNK}`);
// Default to a small batch for pilot verification; set MIMO_TTS_MAX_PARAGRAPHS=0 to disable limit.
const MAX_PARAGRAPHS = Number(process.env.MIMO_TTS_MAX_PARAGRAPHS || 20);
const FORCE_REFRESH = process.argv.includes('--force');
const MIMO_AUTH_MODE = (process.env.MIMO_AUTH_MODE || 'api-key').trim(); // 'api-key' | 'bearer' | 'both'

// Default hardcoded target for backwards compatibility. This will be
// overridden by CLI flags: `--article <outputDir>` or `--all`.
const DEFAULT_TARGET_ARTICLES = [
  {
    source: '书/决定自由.md',
    routePath: '/书/决定自由',
    outputDir: '书/决定自由'
  }
];

function trimSlashes(str) {
  let s = String(str || '');
  while (s.startsWith('/')) s = s.slice(1);
  while (s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

function discoverAllArticles() {
  const found = [];

  function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        if (full === path.resolve(__dirname, 'public')) continue;
        if (full === path.resolve(__dirname, '.vitepress')) continue;
        walk(full);
        continue;
      }
      if (!name.endsWith('.md')) continue;
      const rel = path.relative(docsRoot, full).replace(/\\/g, '/');
      const raw = fs.readFileSync(full, 'utf8');
      const { frontmatter } = splitFrontmatter(raw);
      const readAloudEnabled = frontmatter.readAloudEnabled === true || String(frontmatter.readAloudEnabled).toLowerCase() === 'true';
      if (!readAloudEnabled) continue;

      const outputDir = rel.replace(/\.md$/i, '');
      const routePath = '/' + trimSlashes(outputDir);
      found.push({ source: rel, routePath, outputDir });
    }
  }

  walk(docsRoot);
  return found;
}

function buildSingleArticleFromArg(arg) {
  // Accept either an outputDir-like arg (书/我和莱斯特) or a source-like arg (书/我和莱斯特.md)
  const cleaned = String(arg || '').replace(/^\/+/, '');
  if (!cleaned) return null;
  const source = cleaned.endsWith('.md') ? cleaned : `${cleaned}.md`;
  const outputDir = cleaned.replace(/\.md$/i, '');
  const routePath = '/' + trimSlashes(outputDir);
  // validate source exists
  const sourcePath = path.resolve(docsRoot, source);
  if (!fs.existsSync(sourcePath)) return null;
  return { source, routePath, outputDir };
}

const md = new MarkdownIt({
  html: true,
  linkify: false,
  breaks: false,
  typographer: false
});

md.use(implicitFigures, {
  figcaption: 'Title',
  keepAlt: true
});

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function loadJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function parseFrontmatterValue(rawValue) {
  const value = rawValue.trim();
  if (!value) return '';

  if (value === 'true') return true;
  if (value === 'false') return false;

  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric) && String(numeric) === value) {
    return numeric;
  }

  return value;
}

function splitFrontmatter(markdown) {
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    return { frontmatter: {}, body: markdown, lineOffset: 0 };
  }

  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    return { frontmatter: {}, body: markdown, lineOffset: 0 };
  }

  const frontmatterLines = lines.slice(1, endIndex);
  const frontmatter = {};

  for (const line of frontmatterLines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const colonIndex = line.indexOf(':');
    if (colonIndex <= 0) continue;

    const key = line.slice(0, colonIndex).trim();
    const rawValue = line.slice(colonIndex + 1);
    frontmatter[key] = parseFrontmatterValue(rawValue);
  }

  return {
    frontmatter,
    body: lines.slice(endIndex + 1).join('\n'),
    lineOffset: endIndex + 1
  };
}

function inlineTokenToText(token) {
  if (!token) return '';

  if (token.type === 'text' || token.type === 'code_inline') {
    return token.content || '';
  }

  if (token.type === 'softbreak' || token.type === 'hardbreak') {
    return '\n';
  }

  if (token.type === 'html_inline') {
    return token.content || '';
  }

  return '';
}

function extractInlineText(inlineToken) {
  const children = Array.isArray(inlineToken.children) ? inlineToken.children : [];
  let text = '';

  for (const child of children) {
    if (child.type === 'image') {
      continue;
    }

    text += inlineTokenToText(child);
  }

  return text;
}

function buildSegments(markdownBody, lineOffset) {
  const tokens = md.parse(markdownBody, {});
  const segments = [];

  let blockquoteDepth = 0;
  let index = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token.type === 'blockquote_open') {
      blockquoteDepth += 1;
      continue;
    }

    if (token.type === 'blockquote_close') {
      blockquoteDepth = Math.max(0, blockquoteDepth - 1);
      continue;
    }

    if (blockquoteDepth > 0) {
      continue;
    }

    const isHeading = token.type === 'heading_open' && /^h[2-6]$/.test(token.tag);
    const isParagraph = token.type === 'paragraph_open';

    if (!isHeading && !isParagraph) {
      continue;
    }

    const inlineToken = tokens[i + 1];
    if (!inlineToken || inlineToken.type !== 'inline') {
      continue;
    }

    const rawText = extractInlineText(inlineToken);
    const cleanText = cleanTextForTTS(rawText);

    if (!cleanText) {
      continue;
    }

    const lineStart = Array.isArray(token.map) ? token.map[0] + 1 + lineOffset : null;
    const lineEnd = Array.isArray(token.map) ? token.map[1] + lineOffset : null;

    const segment = {
      id: `p-${String(index + 1).padStart(5, '0')}`,
      index,
      type: isHeading ? 'heading' : 'paragraph',
      tag: isHeading ? token.tag : 'p',
      source: {
        lineStart,
        lineEnd
      },
      rawText: normalizeWhitespace(rawText),
      cleanText,
      fingerprint: createStableFingerprint(cleanText)
    };

    segments.push(segment);
    index += 1;
  }

  return segments;
}

function toRouteVariants(routePath) {
  // Return a single canonical route key (no trailing slash) to avoid
  // duplicate manifest entries like "/path" and "/path/".
  const normalized = routePath === '/' ? '/' : routePath.replace(/\/+$/, '');
  return [normalized];
}

function toBuffer(base64Data) {
  return Buffer.from(base64Data, 'base64');
}

function parseWav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('音频格式不是 WAV (RIFF/WAVE)');
  }

  let offset = 12;
  let fmt = null;
  const dataChunks = [];

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkDataStart = offset + 8;
    const chunkDataEnd = chunkDataStart + chunkSize;

    if (chunkDataEnd > buffer.length) {
      break;
    }

    if (chunkId === 'fmt ') {
      fmt = {
        audioFormat: buffer.readUInt16LE(chunkDataStart),
        channels: buffer.readUInt16LE(chunkDataStart + 2),
        sampleRate: buffer.readUInt32LE(chunkDataStart + 4),
        bitsPerSample: buffer.readUInt16LE(chunkDataStart + 14)
      };
    }

    if (chunkId === 'data') {
      dataChunks.push(buffer.slice(chunkDataStart, chunkDataEnd));
    }

    offset = chunkDataEnd + (chunkSize % 2);
  }

  if (!fmt) {
    throw new Error('WAV 缺少 fmt chunk');
  }

  if (!dataChunks.length) {
    throw new Error('WAV 缺少 data chunk');
  }

  const data = Buffer.concat(dataChunks);
  const blockAlign = fmt.channels * (fmt.bitsPerSample / 8);
  const byteRate = fmt.sampleRate * blockAlign;

  return {
    ...fmt,
    blockAlign,
    byteRate,
    data
  };
}

function assertCompatibleFormat(baseFormat, nextFormat) {
  const keys = ['audioFormat', 'channels', 'sampleRate', 'bitsPerSample'];
  for (const key of keys) {
    if (baseFormat[key] !== nextFormat[key]) {
      throw new Error(`音频参数不一致: ${key} (${baseFormat[key]} vs ${nextFormat[key]})`);
    }
  }
}

function buildWav(parsed) {
  const subchunk1Size = 16;
  const dataSize = parsed.data.length;
  const totalSize = 4 + (8 + subchunk1Size) + (8 + dataSize);
  const buffer = Buffer.alloc(8 + totalSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(totalSize, 4);
  buffer.write('WAVE', 8);

  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(subchunk1Size, 16);
  buffer.writeUInt16LE(parsed.audioFormat, 20);
  buffer.writeUInt16LE(parsed.channels, 22);
  buffer.writeUInt32LE(parsed.sampleRate, 24);
  buffer.writeUInt32LE(parsed.byteRate, 28);
  buffer.writeUInt16LE(parsed.blockAlign, 32);
  buffer.writeUInt16LE(parsed.bitsPerSample, 34);

  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  parsed.data.copy(buffer, 44);

  return buffer;
}

function concatParsedWavs(items) {
  if (!items.length) {
    throw new Error('没有可拼接的音频数据');
  }

  const first = items[0];
  for (let i = 1; i < items.length; i++) {
    assertCompatibleFormat(first, items[i]);
  }

  return {
    ...first,
    data: Buffer.concat(items.map(item => item.data))
  };
}

function getDurationSeconds(parsedWav) {
  if (!parsedWav.byteRate) return 0;
  return parsedWav.data.length / parsedWav.byteRate;
}

async function synthesizeChunk(text) {
  const assistantContent = MIMO_TTS_STYLE ? `<style>${MIMO_TTS_STYLE}</style>${text}` : text;

  let messages;
  if (MIMO_TTS_MODEL && MIMO_TTS_MODEL.includes('tts')) {
    // For TTS model, the target text must be in an `assistant` role and system role may be disallowed.
    messages = [
      {
        role: 'user',
        content: MIMO_TTS_USER_PROMPT || ''
      },
      {
        role: 'assistant',
        content: assistantContent
      }
    ];
  } else {
    messages = [
      {
        role: 'system',
        content: MIMO_TTS_SYSTEM_PROMPT
      },
      {
        role: 'user',
        content: MIMO_TTS_USER_PROMPT
      },
      {
        role: 'assistant',
        content: assistantContent
      }
    ];
  }

  const payload = {
    model: MIMO_TTS_MODEL,
    messages,
    audio: {
      format: 'wav',
      voice: MIMO_TTS_VOICE
    },
    temperature: MIMO_TTS_TEMPERATURE,
    top_p: MIMO_TTS_TOP_P,
    stream: false
  };

  const headers = {
    'Content-Type': 'application/json'
  };

  if (MIMO_AUTH_MODE === 'api-key' || MIMO_AUTH_MODE === 'both') {
    headers['api-key'] = MIMO_API_KEY;
  }
  if (MIMO_AUTH_MODE === 'bearer' || MIMO_AUTH_MODE === 'both') {
    headers['Authorization'] = `Bearer ${MIMO_API_KEY}`;
  }

  // Log auth mode (without revealing key)
  console.error('Using MIMO_AUTH_MODE=', MIMO_AUTH_MODE);

  const response = await fetch(MIMO_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(errorText);
    } catch (e) {
      parsed = errorText;
    }

    // Mask sensitive header values for logging
    const maskedHeaders = {};
    for (const k of Object.keys(headers)) {
      if (/api-key|authorization/i.test(k)) {
        maskedHeaders[k] = '<masked>'; 
      } else {
        maskedHeaders[k] = headers[k];
      }
    }

    console.error('=== TTS request diagnostics ===');
    console.error('Request URL:', MIMO_API_URL);
    console.error('Request headers (masked):', JSON.stringify(maskedHeaders, null, 2));
    console.error('Request payload (truncated):', JSON.stringify(payload).slice(0, 800));
    const responseHeadersObj = {};
    try {
      for (const [k, v] of response.headers) {
        responseHeadersObj[k] = v;
      }
    } catch (e) {
      // ignore
    }

    // Mask any header values that might echo the key
    const maskedResponseHeaders = {};
    for (const k of Object.keys(responseHeadersObj)) {
      if (/api-key|authorization|set-cookie/i.test(k)) {
        maskedResponseHeaders[k] = '<masked-header>';
      } else {
        maskedResponseHeaders[k] = responseHeadersObj[k];
      }
    }

    console.error('Response status:', response.status, response.statusText);
    console.error('Response headers (masked):', JSON.stringify(maskedResponseHeaders, null, 2));
    console.error('Response body:', typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2));
    console.error('=== end diagnostics ===');

    throw new Error(`TTS 请求失败: HTTP ${response.status} - ${String(parsed).slice(0, 800)}`);
  }

  const result = await response.json();
  const base64Data = result?.choices?.[0]?.message?.audio?.data;

  if (!base64Data) {
    throw new Error('TTS 响应缺少 audio.data');
  }

  return parseWav(toBuffer(base64Data));
}

function loadCache() {
  return loadJson(cacheFile, { records: {} });
}

function saveCache(cache) {
  saveJson(cacheFile, cache);
}

function getSegmentCacheKey(segment) {
  return crypto
    .createHash('sha1')
    .update(`${MIMO_TTS_MODEL}|${MIMO_TTS_VOICE}|${MIMO_TTS_STYLE}|${MIMO_TTS_SYSTEM_PROMPT}|${MIMO_TTS_USER_PROMPT}|temp=${MIMO_TTS_TEMPERATURE}|top_p=${MIMO_TTS_TOP_P}|${segment.cleanText}`)
    .digest('hex');
}

async function synthesizeSegment(segment, cache) {
  const key = getSegmentCacheKey(segment);
  const cacheRecord = cache.records[key];

  if (!FORCE_REFRESH && cacheRecord?.file) {
    const absolutePath = path.resolve(__dirname, cacheRecord.file);
    if (fs.existsSync(absolutePath)) {
      const cachedParsed = parseWav(fs.readFileSync(absolutePath));
      return {
        key,
        parsed: cachedParsed,
        fromCache: true
      };
    }
  }

  const chunks = splitTTSChunks(segment.cleanText, MAX_CHARS_PER_CHUNK);
  if (!chunks.length) {
    throw new Error(`段落 ${segment.id} 清洗后为空`);
  }

  const parsedChunks = [];
  for (let i = 0; i < chunks.length; i++) {
    const parsed = await synthesizeChunk(chunks[i]);
    parsedChunks.push(parsed);
  }

  const merged = concatParsedWavs(parsedChunks);
  const wavFile = buildWav(merged);

  ensureDir(cacheAudioDir);
  const cacheRelativeFile = path.relative(__dirname, path.join(cacheAudioDir, `${key}.wav`)).replace(/\\/g, '/');
  const cacheAbsoluteFile = path.resolve(__dirname, cacheRelativeFile);
  fs.writeFileSync(cacheAbsoluteFile, wavFile);

  cache.records[key] = {
    file: cacheRelativeFile,
    updatedAt: new Date().toISOString(),
    duration: getDurationSeconds(merged),
    chars: segment.cleanText.length
  };

  return {
    key,
    parsed: merged,
    fromCache: false
  };
}

async function processArticle(article, manifest, cache) {
  const sourcePath = path.resolve(docsRoot, article.source);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`找不到源文件: ${article.source}`);
  }

  const rawMarkdown = fs.readFileSync(sourcePath, 'utf8');
  const { frontmatter, body, lineOffset } = splitFrontmatter(rawMarkdown);

  const readAloudEnabled = frontmatter.readAloudEnabled === true || String(frontmatter.readAloudEnabled).toLowerCase() === 'true';
  if (!readAloudEnabled) {
    console.log(`⏭️ 跳过 ${article.source} (readAloudEnabled 未开启)`);
    return;
  }

  let segments = buildSegments(body, lineOffset);
  if (MAX_PARAGRAPHS > 0) {
    segments = segments.slice(0, MAX_PARAGRAPHS);
  }

  if (!segments.length) {
    throw new Error(`${article.source} 中没有可朗读段落`);
  }

  const articleOutputDir = path.join(outputRoot, article.outputDir);
  ensureDir(articleOutputDir);

  const segmentOutputPath = path.join(articleOutputDir, 'segments.json');

  // If outputs already exist (segments.json, cues.json, final.wav), reuse them
  // to avoid re-synthesizing just to update the manifest.
  const existingCuesPath = path.join(articleOutputDir, 'cues.json');
  const existingFinalWavPath = path.join(articleOutputDir, 'final.wav');
  const existingSegmentsPath = segmentOutputPath;

  if (fs.existsSync(existingCuesPath) && fs.existsSync(existingFinalWavPath) && fs.existsSync(existingSegmentsPath)) {
    try {
      const existingCues = loadJson(existingCuesPath, null);
      const existingSegments = loadJson(existingSegmentsPath, null);
      if (existingCues && existingSegments) {
        const publicBase = `/tts/${article.outputDir.replace(/\\/g, '/')}`;
        const entry = {
          routePath: article.routePath,
          source: article.source,
          audio: `${publicBase}/final.wav`,
          cues: `${publicBase}/cues.json`,
          segments: `${publicBase}/segments.json`,
          count: existingCues.count || (Array.isArray(existingCues.cues) ? existingCues.cues.length : 0),
          totalDuration: existingCues.totalDuration || existingCues.totalDuration === 0 ? existingCues.totalDuration : (existingCues.cues && existingCues.cues.length ? existingCues.cues[existingCues.cues.length - 1].end : 0),
          generatedAt: existingCues.generatedAt || new Date().toISOString(),
          fingerprint: crypto.createHash('sha1').update((existingSegments.segments || existingSegments).map(s => s.fingerprint).join('|')).digest('hex')
        };

        const routeVariants = toRouteVariants(article.routePath);
        for (const key of routeVariants) {
          manifest.entries[key] = entry;
        }

        console.log(`ℹ️ 复用已存在输出：${article.outputDir}，已更新 manifest 条目`);
        return;
      }
    } catch (e) {
      console.warn(`无法加载现有输出，继续生成: ${e.message}`);
    }
  }

  // Persist segments before possible synthesis
  saveJson(segmentOutputPath, {
    source: article.source,
    routePath: article.routePath,
    count: segments.length,
    generatedAt: new Date().toISOString(),
    segments
  });

  if (!MIMO_API_KEY) {
    throw new Error('缺少 MIMO_API_KEY 环境变量，无法调用 Xiaomi MiMo TTS API');
  }

  console.log(`🎙️ 开始合成 ${article.source}，共 ${segments.length} 段`);

  const cues = [];
  const parsedParagraphAudios = [];
  let timeline = 0;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const { parsed, fromCache } = await synthesizeSegment(segment, cache);
    const duration = getDurationSeconds(parsed);

    cues.push({
      id: segment.id,
      index: segment.index,
      type: segment.type,
      tag: segment.tag,
      start: Number(timeline.toFixed(3)),
      end: Number((timeline + duration).toFixed(3)),
      duration: Number(duration.toFixed(3)),
      fingerprint: segment.fingerprint,
      text: segment.cleanText,
      source: segment.source
    });

    parsedParagraphAudios.push(parsed);
    timeline += duration;

    const status = fromCache ? '缓存' : '新生成';
    console.log(`  ${String(i + 1).padStart(4, ' ')} / ${segments.length}  ${status}  ${segment.id}`);
  }

  const merged = concatParsedWavs(parsedParagraphAudios);
  const finalWavPath = path.join(articleOutputDir, 'final.wav');
  fs.writeFileSync(finalWavPath, buildWav(merged));

  const cuesPath = path.join(articleOutputDir, 'cues.json');
  saveJson(cuesPath, {
    source: article.source,
    routePath: article.routePath,
    totalDuration: Number(timeline.toFixed(3)),
    count: cues.length,
    generatedAt: isoLocalWithOffset(new Date()),
    cues
  });

  const publicBase = `/tts/${article.outputDir.replace(/\\/g, '/')}`;
  const entry = {
    routePath: article.routePath,
    source: article.source,
    audio: `${publicBase}/final.wav`,
    cues: `${publicBase}/cues.json`,
    segments: `${publicBase}/segments.json`,
    count: cues.length,
    totalDuration: Number(timeline.toFixed(3)),
    generatedAt: isoLocalWithOffset(new Date()),
    fingerprint: crypto.createHash('sha1').update(segments.map(s => s.fingerprint).join('|')).digest('hex')
  };

  const routeVariants = toRouteVariants(article.routePath);
  for (const key of routeVariants) {
    manifest.entries[key] = entry;
  }
}

async function generateTTSAssets() {
  ensureDir(outputRoot);

  const manifest = loadJson(manifestPath, {
    generatedAt: null,
    entries: {}
  });

  const cache = loadCache();

  // CLI options: --article <outputDir|source.md>  or --all
  const argv = process.argv.slice(2);
  const allFlag = argv.includes('--all');
  const articleFlagIndex = argv.findIndex(a => a === '--article');

  let targetArticles = DEFAULT_TARGET_ARTICLES;

  if (allFlag) {
    const discovered = discoverAllArticles();
    if (discovered.length) targetArticles = discovered;
    else console.log('未发现启用 readAloudEnabled 的文章，使用默认目标。');
  } else if (articleFlagIndex >= 0 && argv[articleFlagIndex + 1]) {
    const built = buildSingleArticleFromArg(argv[articleFlagIndex + 1]);
    if (!built) {
      throw new Error(`无法解析或找不到指定文章: ${argv[articleFlagIndex + 1]}`);
    }
    targetArticles = [built];
  }

  for (const article of targetArticles) {
    await processArticle(article, manifest, cache);
  }

  manifest.generatedAt = isoLocalWithOffset(new Date());
  saveJson(manifestPath, manifest);
  saveCache(cache);

  console.log('\n✅ TTS 资源生成完成');
  console.log(`   - manifest: ${manifestPath}`);
}

generateTTSAssets().catch((error) => {
  console.error(`\n❌ 生成失败: ${error.message}`);
  process.exitCode = 1;
});
