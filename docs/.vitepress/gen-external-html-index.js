#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { load } from 'cheerio';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const htmlSrcDir = path.resolve(__dirname, '../public/html'); // source HTML files
const outputDir = path.resolve(__dirname, '../content-for-search/html-content');
const cacheFile = path.resolve(__dirname, 'external-html-cache.json');

function computeFileHash(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const hashSum = crypto.createHash('md5');
  hashSum.update(fileBuffer);
  return hashSum.digest('hex');
}

function loadCache() {
  if (fs.existsSync(cacheFile)) {
    try {
      return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch (e) {
      return {};
    }
  }
  return {};
}

function saveCache(cache) {
  fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
}

function findAllHtmlFiles(dir, relativePath = '') {
  let files = [];
  if (!fs.existsSync(dir)) return files;
  const items = fs.readdirSync(dir);

  for (const item of items) {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      files = files.concat(findAllHtmlFiles(fullPath, path.join(relativePath, item)));
    } else if (item.toLowerCase().endsWith('.html')) {
      files.push({ name: item, relativePath, fullPath });
    }
  }

  return files;
}

function deleteDirectoryRecursive(dir) {
  if (!fs.existsSync(dir)) return;
  const items = fs.readdirSync(dir);
  for (const item of items) {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) deleteDirectoryRecursive(fullPath);
    else fs.unlinkSync(fullPath);
  }
  fs.rmdirSync(dir);
}

function safeText($el) {
  // collapse whitespace
  const txt = $el.text() || '';
  return txt.replace(/\s+/g, ' ').trim();
}

async function generateExternalHtmlIndex() {
  console.log('🔍 开始生成 External HTML 内容索引...');

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const cache = loadCache();
  let processed = 0, skipped = 0, removed = 0;

  const htmlFiles = findAllHtmlFiles(htmlSrcDir);
  const currentKeys = new Set(htmlFiles.map(f => path.join(f.relativePath, f.name)));

  // clean removed
  for (const key of Object.keys(cache)) {
    if (!currentKeys.has(key)) {
      console.log('  🗑️ 删除旧索引:', key);
      const rp = path.dirname(key);
      const base = path.basename(key, '.html');
      const outPath = path.join(outputDir, rp, `${base}.md`);
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
      delete cache[key];
      removed++;
    }
  }

  for (const file of htmlFiles) {
    const { name, relativePath, fullPath } = file;
    const fileHash = computeFileHash(fullPath);
    const cacheKey = path.join(relativePath, name);
    const baseName = path.basename(name, '.html');
    const outputSubDir = path.join(outputDir, relativePath);
    if (!fs.existsSync(outputSubDir)) fs.mkdirSync(outputSubDir, { recursive: true });

    const outMd = path.join(outputSubDir, `${baseName}.md`);

    if (cache[cacheKey] === fileHash && fs.existsSync(outMd)) {
      console.log(`⏭ 跳过: ${cacheKey} (未修改)`);
      skipped++;
      continue;
    }

    console.log('📄 处理:', cacheKey);
    try {
      const html = fs.readFileSync(fullPath, 'utf8');
      const $ = load(html);

      // page selector mirrors ExternalHTMLViewer default
      const pages = $( '.pf' ).toArray();
      // fallback to body as single page
      if (!pages.length) pages.push($('body').first().get(0));

      let markdownContent = '';
      pages.forEach((p, idx) => {
        const num = idx + 1;
        const $p = $(p);
        const title = $p.find('h1,h2,h3').first().text().trim() || `${baseName} - P${num}`;
        const text = safeText($p) || '';
        markdownContent += `\n\n---\n\n## 第 ${num} 页 {#page-${num}}\n\n${text}\n`;
      });

      const md = `---\ntitle: "${baseName}"\neditLink: false\noutline: false\npermalink: /content-for-search/html-content/${relativePath ? relativePath + '/' : ''}${baseName}\n---\n\n# ${baseName}\n\n> 此页面由外部 HTML 自动索引生成，仅用于站点搜索索引和跳转。\n\n${markdownContent}\n`;

      fs.writeFileSync(outMd, md, 'utf8');
      cache[cacheKey] = fileHash;
      processed++;
    } catch (err) {
      console.error('❌ 处理失败:', cacheKey, err.message || err);
    }
  }

  saveCache(cache);

  console.log('\n✅ External HTML 索引生成完成');
  console.log(`  处理: ${processed}, 跳过: ${skipped}, 删除: ${removed}`);
  console.log('  输出目录:', outputDir);
}

generateExternalHtmlIndex().catch(err => {
  console.error('❌ External HTML 索引生成失败:', err);
  process.exitCode = 0; // 即使失败也返回成功，不影响开发服务器启动
});
