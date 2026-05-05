#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import PDFParser from 'pdf2json';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const pdfDir = path.resolve(__dirname, '../public/PDFs');
const outputDir = path.resolve(__dirname, '../content-for-search/pdf-content');
const cacheFile = path.resolve(__dirname, 'pdf-cache.json');

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

function findAllPDFFiles(dir, relativePath = '') {
  let files = [];
  const items = fs.readdirSync(dir);

  for (const item of items) {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      files = files.concat(findAllPDFFiles(fullPath, path.join(relativePath, item)));
    } else if (item.toLowerCase().endsWith('.pdf')) {
      files.push({
        name: item,
        relativePath: relativePath,
        fullPath: fullPath
      });
    }
  }

  return files;
}

function safeDecodeURIComponent(str) {
  try {
    return decodeURIComponent(str);
  } catch (e) {
    return str;
  }
}

function extractPDFTextWithPages(pdfPath) {
  return new Promise((resolve, reject) => {
    const pdfParser = new PDFParser(null, true);
    
    pdfParser.on('pdfParser_dataError', err => reject(err));
    
    pdfParser.on('pdfParser_dataReady', pdfData => {
      const pages = [];
      
      if (pdfData.Pages) {
        pdfData.Pages.forEach((page, index) => {
          let pageText = '';
          if (page.Texts) {
            page.Texts.forEach(text => {
              if (text.R && text.R.length > 0) {
                const decodedText = safeDecodeURIComponent(text.R[0].T);
                pageText += decodedText + ' ';
              }
            });
          }
          pages.push({
            pageNumber: index + 1,
            text: pageText
          });
        });
      }
      
      resolve(pages);
    });
    
    pdfParser.loadPDF(pdfPath);
  });
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, function(m) {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    }[m];
  });
}

function deleteDirectoryRecursive(dir) {
  if (!fs.existsSync(dir)) {
    return;
  }
  const items = fs.readdirSync(dir);
  for (const item of items) {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      deleteDirectoryRecursive(fullPath);
    } else {
      fs.unlinkSync(fullPath);
    }
  }
  fs.rmdirSync(dir);
}

async function generatePDFIndex() {
  console.log('🔍 开始生成PDF搜索索引...\n');

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const cache = loadCache();
  let processedCount = 0;
  let skippedCount = 0;
  let deletedCount = 0;

  if (!fs.existsSync(pdfDir)) {
    console.log('⚠️ PDF目录不存在:', pdfDir);
    console.log('🧹 清理旧的索引文件...');
    deleteDirectoryRecursive(outputDir);
    fs.writeFileSync(cacheFile, '{}');
    console.log('✅ 已清理所有旧的索引文件\n');
    return;
  }

  const pdfFiles = findAllPDFFiles(pdfDir);
  const currentCacheKeys = new Set(pdfFiles.map(f => path.join(f.relativePath, f.name)));

  console.log(`📁 找到 ${pdfFiles.length} 个PDF文件\n`);

  console.log('🧹 清理旧的缓存和索引文件...');
  for (const cacheKey of Object.keys(cache)) {
    if (!currentCacheKeys.has(cacheKey)) {
      console.log(`  🗑️  删除旧索引: ${cacheKey}`);
      const relativePath = path.dirname(cacheKey);
      const baseName = path.basename(cacheKey, '.pdf');
      const mdPath = path.join(outputDir, relativePath, `${baseName}.md`);
      if (fs.existsSync(mdPath)) {
        fs.unlinkSync(mdPath);
      }
      delete cache[cacheKey];
      deletedCount++;
    }
  }

  for (const pdfFile of pdfFiles) {
    const { name, relativePath, fullPath } = pdfFile;
    const fileHash = computeFileHash(fullPath);
    const cacheKey = path.join(relativePath, name);
    const baseName = path.basename(name, '.pdf');
    const outputSubDir = path.join(outputDir, relativePath);

    if (!fs.existsSync(outputSubDir)) {
      fs.mkdirSync(outputSubDir, { recursive: true });
    }

    const mdPath = path.join(outputSubDir, `${baseName}.md`);

    if (cache[cacheKey] === fileHash && fs.existsSync(mdPath)) {
      console.log(`⏭️  跳过: ${cacheKey} (未修改)`);
      skippedCount++;
      continue;
    }

    console.log(`📄 处理: ${cacheKey}`);

    try {
      const pages = await extractPDFTextWithPages(fullPath);

      let markdownContent = '';
      for (const page of pages) {
        markdownContent += `\n\n---\n\n## 第 ${page.pageNumber} 页 {#page-${page.pageNumber}}\n\n${page.text}`;
      }

      const mdContent = `---
title: "${name}"
editLink: false
outline: false
permalink: /content-for-search/pdf-content/${relativePath ? relativePath + '/' : ''}${baseName}
---

# ${name}

> 此页面由PDF自动索引生成，仅用于搜索功能，查看网站中相应的PDF页面。

---

${markdownContent}
`;

      fs.writeFileSync(mdPath, mdContent, 'utf8');
      cache[cacheKey] = fileHash;
      processedCount++;
    } catch (error) {
      console.error(`❌ 处理 ${cacheKey} 失败:`, error.message);
    }
  }

  saveCache(cache);

  console.log(`\n✅ PDF索引生成完成！`);
  console.log(`   - 处理: ${processedCount} 个`);
  console.log(`   - 跳过: ${skippedCount} 个`);
  console.log(`   - 删除: ${deletedCount} 个`);
  console.log(`   - 输出目录: ${outputDir}`);
}

generatePDFIndex().catch((error) => {
  console.error('❌ PDF 索引生成失败:', error?.message || error);
  process.exitCode = 0; // 即使失败也返回成功，不影响开发服务器启动
});
