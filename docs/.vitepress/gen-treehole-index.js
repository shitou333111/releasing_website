#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from repository root if present. This allows running the script
// locally with environment variables defined in the project's `.env` file.
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const outputDir = path.resolve(__dirname, '../content-for-search/treehole-content');
const cacheFile = path.resolve(__dirname, 'treehole-cache.json');

const supabaseUrl = (process.env.TREEHOLE_INDEX_SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim();
const supabaseKey = (
  process.env.TREEHOLE_INDEX_SUPABASE_SERVICE_ROLE_KEY
  || process.env.TREEHOLE_INDEX_SUPABASE_ANON_KEY
  || process.env.VITE_SUPABASE_ANON_KEY
  || ''
).trim();

function sanitizeFileSegment(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'thread';
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadCache() {
  if (!fs.existsSync(cacheFile)) {
    return { threads: {} };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.threads && typeof parsed.threads === 'object') {
      return parsed;
    }
  } catch {
    // Ignore malformed cache.
  }

  return { threads: {} };
}

function saveCache(cache) {
  fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2), 'utf8');
}

function hashPayload(payload) {
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function normalizeText(text) {
  return String(text || '').replace(/\r\n/g, '\n').trim();
}

function escapeYamlText(text) {
  return String(text || '').replace(/"/g, '\\"');
}

function deleteFileIfExists(filePath) {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function removeEmptyDirectories(dir) {
  if (!fs.existsSync(dir)) return;
  const items = fs.readdirSync(dir);
  for (const item of items) {
    const full = path.join(dir, item);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      removeEmptyDirectories(full);
    }
  }

  const after = fs.readdirSync(dir);
  if (after.length === 0 && dir !== outputDir) {
    fs.rmdirSync(dir);
  }
}

function removeLegacyFlatFiles() {
  if (!fs.existsSync(outputDir)) return;
  const items = fs.readdirSync(outputDir);
  for (const item of items) {
    const full = path.join(outputDir, item);
    const stat = fs.statSync(full);
    if (stat.isFile() && item.toLowerCase().endsWith('.md')) {
      fs.unlinkSync(full);
    }
  }
}

async function fetchAllRows(client, table, selectClause, filters = (q) => q, pageSize = 500) {
  const rows = [];
  let offset = 0;

  while (true) {
    let query = client.from(table).select(selectClause).range(offset, offset + pageSize - 1);
    query = filters(query);

    const { data, error } = await query;
    if (error) {
      throw error;
    }

    const chunk = data || [];
    rows.push(...chunk);

    if (chunk.length < pageSize) {
      break;
    }

    offset += pageSize;
  }

  return rows;
}

function toThreadFileName(threadNo, title, id) {
  const no = sanitizeFileSegment(threadNo || 'thread');
  const t = sanitizeFileSegment(title || 'untitled');
  const shortId = String(id || '').slice(0, 8) || 'unknown';
  return `${no}-${t}-${shortId}.md`;
}

function buildMarkdown(thread, replies) {
  const title = `[${thread.thread_no}] ${thread.title}`;
  const rootContent = normalizeText(thread.content);

  const sortedReplies = [...replies].sort((a, b) => {
    const ta = new Date(a.created_at).getTime();
    const tb = new Date(b.created_at).getTime();
    return ta - tb;
  });

  const replyBlock = sortedReplies.length
    ? sortedReplies
      .map((reply) => `- ${reply.author_alias_label}: ${normalizeText(reply.content)}`)
      .join('\n')
    : '- 暂无回复';

  return `---
title: "${escapeYamlText(title)}"
editLink: false
outline: false
permalink: /content-for-search/treehole-content/${thread.id}/index
---

# ${title}

> 此页面由 TreeHole 构建索引自动生成，仅用于站内搜索，不作为导航页面。

## 帖子编号

${thread.thread_no}

## 标题

${thread.title}

## 主贴内容

${rootContent}

## 回复内容

${replyBlock}
`;
}

async function generateTreeHoleIndex() {
  console.log('🔍 开始生成 TreeHole 搜索索引...\n');

  ensureDir(outputDir);

  if (!supabaseUrl || !supabaseKey) {
    console.log('⚠️ 未配置 TreeHole 索引环境变量，跳过生成。');
    console.log('   需要至少提供 TREEHOLE_INDEX_SUPABASE_URL + TREEHOLE_INDEX_SUPABASE_ANON_KEY');
    return;
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });

  const cache = loadCache();
  const nextCache = { threads: {} };

  const threadRows = await fetchAllRows(
    supabase,
    'treehole_thread_cards',
    'id,thread_no,title,content,creator_alias_label,visibility,status,created_at,updated_at',
    (query) => query.eq('visibility', 'public').neq('status', 'deleted').order('updated_at', { ascending: false })
  );

  const threadIds = threadRows.map((row) => row.id);
  const replyRows = threadIds.length
    ? await fetchAllRows(
      supabase,
      'treehole_replies',
      'id,thread_id,author_alias_label,content,created_at',
      (query) => query.in('thread_id', threadIds).order('created_at', { ascending: true })
    )
    : [];

  const repliesByThread = new Map();
  for (const reply of replyRows) {
    const list = repliesByThread.get(reply.thread_id) || [];
    list.push(reply);
    repliesByThread.set(reply.thread_id, list);
  }

  let processed = 0;
  let skipped = 0;
  let removed = 0;

  for (const thread of threadRows) {
    const replies = repliesByThread.get(thread.id) || [];
    const payload = JSON.stringify({
      id: thread.id,
      thread_no: thread.thread_no,
      title: thread.title,
      content: thread.content,
      updated_at: thread.updated_at,
      replies: replies.map((item) => ({
        id: item.id,
        author_alias_label: item.author_alias_label,
        content: item.content,
        created_at: item.created_at
      }))
    });

    const hash = hashPayload(payload);
    const existing = cache.threads[thread.id];
    const fileName = existing?.file || toThreadFileName(thread.thread_no, thread.title, thread.id);
    const threadDir = path.join(outputDir, String(thread.id));
    ensureDir(threadDir);
    const outputPath = path.join(threadDir, fileName);

    nextCache.threads[thread.id] = { hash, file: fileName };

    if (existing && existing.hash === hash && fs.existsSync(outputPath)) {
      skipped += 1;
      continue;
    }

    const markdown = buildMarkdown(thread, replies);
    fs.writeFileSync(outputPath, markdown, 'utf8');
    processed += 1;
  }

  for (const [threadId, info] of Object.entries(cache.threads || {})) {
    if (nextCache.threads[threadId]) {
      continue;
    }

    const oldPath = path.join(outputDir, threadId, info.file);
    deleteFileIfExists(oldPath);
    removed += 1;
  }

  removeLegacyFlatFiles();
  removeEmptyDirectories(outputDir);
  saveCache(nextCache);

  console.log(`✅ TreeHole 索引生成完成`);
  console.log(`   - 帖子总数: ${threadRows.length}`);
  console.log(`   - 新增/更新: ${processed}`);
  console.log(`   - 跳过: ${skipped}`);
  console.log(`   - 删除: ${removed}`);
  console.log(`   - 输出目录: ${outputDir}`);
}

generateTreeHoleIndex().catch((error) => {
  console.error('❌ TreeHole 索引生成失败:', error?.message || error);
  process.exitCode = 0; // 即使失败也返回成功，不影响开发服务器启动
});
