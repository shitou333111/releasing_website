#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const cacheFile = path.resolve(__dirname, 'tts-cache.json');
const cacheAudioDir = path.resolve(__dirname, 'tts-cache-audio');
const articleDir = path.resolve(__dirname, '..', 'public', 'tts', '书', '决定自由');
const segmentsPath = path.join(articleDir, 'segments.json');

const startIndex = Number(process.env.START_INDEX || 882);
const endIndex = Number(process.env.END_INDEX || 886);

function loadJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function saveJson(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function getKeyForSegment(cleanText) {
  return crypto.createHash('sha1').update(`${process.env.MIMO_TTS_MODEL || 'mimo-v2-tts'}|${process.env.MIMO_TTS_VOICE || 'mimo_default'}|${process.env.MIMO_TTS_STYLE || '温暖 平和 宁静 沉稳'}|${process.env.MIMO_TTS_SYSTEM_PROMPT || ''}|${process.env.MIMO_TTS_USER_PROMPT || ''}|${cleanText}`).digest('hex');
}

const segmentsData = loadJson(segmentsPath, null);
if (!segmentsData) {
  console.error('Cannot find segments.json at', segmentsPath);
  process.exit(1);
}

const targetSegments = (segmentsData.segments || []).filter(s => s.index + 1 >= startIndex && s.index + 1 <= endIndex);
if (!targetSegments.length) {
  console.error('No segments found in range', startIndex, endIndex);
  process.exit(1);
}

const cache = loadJson(cacheFile, { records: {} });
let removed = 0;
for (const seg of targetSegments) {
  const key = getKeyForSegment(seg.cleanText);
  if (cache.records && cache.records[key]) {
    const fileRel = cache.records[key].file;
    delete cache.records[key];
    removed += 1;
    if (fileRel) {
      const abs = path.resolve(__dirname, fileRel);
      if (fs.existsSync(abs)) {
        fs.unlinkSync(abs);
        console.log('Deleted cached audio file', abs);
      }
    }
    // also try standard location cacheAudioDir/key.wav
    const alt = path.join(cacheAudioDir, `${key}.wav`);
    if (fs.existsSync(alt)) {
      fs.unlinkSync(alt);
      console.log('Deleted alt cached audio file', alt);
    }
  } else {
    console.log('No cache record for segment', seg.id, 'key', key);
  }
}

saveJson(cacheFile, cache);
console.log(`Removed ${removed} cache records for segments ${startIndex}-${endIndex}.`);
process.exit(0);
