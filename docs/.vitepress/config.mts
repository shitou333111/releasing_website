import { defineConfig } from 'vitepress';
import { withSidebar } from 'vitepress-sidebar';
import implicitFigures from 'markdown-it-implicit-figures';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig(withSidebar({
  markdown: {
    config: (md) => {
      md.use(implicitFigures, {
        figcaption: 'Title',
        keepAlt: true
      });
    }
  },
  lang: 'zh-CN',
  appearance: true,
  title: 'Releasing',
  description: 'A VitePress website for publishing content, custom features, and branded presentation.',
  head: [
    ['link', { rel: 'icon', type: 'image/png', href: '/icon-192x192.png' }],
    ['meta', { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' }],
    ['meta', { name: 'theme-color', content: '#f8fafc', media: '(prefers-color-scheme: light)' }],
    ['meta', { name: 'theme-color', content: '#0b1120', media: '(prefers-color-scheme: dark)' }],
    ['meta', { name: 'apple-mobile-web-app-capable', content: 'yes' }],
    ['meta', { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' }],
    [
      'script',
      {},
      `var _hmt = _hmt || [];
      (function () {
        var hm = document.createElement('script');
        hm.src = 'https://hm.baidu.com/hm.js?24c092b334f382721e09367460ae9134';
        var s = document.getElementsByTagName('script')[0];
        s.parentNode.insertBefore(hm, s);
      })();`
    ]
  ],
  base: process.env.BASE_URL || '/',
  cleanUrls: true,
  lastUpdated: true,
  vite: {
    envDir: resolve(__dirname, '../..'),
    define: {
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: true,
    },
    server: {
      fs: {
        strict: false
      }
    },
    plugins: [
      {
        name: 'auto-restart-on-docs-structure-change',
        apply: 'serve',
        configureServer(server) {
          let restartTimer: ReturnType<typeof setTimeout> | null = null;
          let restarting = false;

          const shouldRestart = (rawPath: string): boolean => {
            const filePath = rawPath.replace(/\\/g, '/');

            if (!filePath.includes('/docs/')) return false;
            if (filePath.includes('/docs/.vitepress/')) return false;
            if (filePath.includes('/docs/public/')) return false;

            return filePath.endsWith('.md') || !filePath.includes('.');
          };

          const queueRestart = (filePath: string) => {
            if (!shouldRestart(filePath) || restarting) return;

            if (restartTimer) {
              clearTimeout(restartTimer);
            }

            restartTimer = setTimeout(async () => {
              restartTimer = null;
              restarting = true;

              server.config.logger.info('[sidebar] docs structure changed, restarting dev server to regenerate sidebar');
              try {
                await server.restart();
              } finally {
                restarting = false;
              }
            }, 150);
          };

          server.watcher.on('add', queueRestart);
          server.watcher.on('unlink', queueRestart);
          server.watcher.on('addDir', queueRestart);
          server.watcher.on('unlinkDir', queueRestart);
        }
      }
    ]
  },
  themeConfig: {
    logo: '/icon-192x192.png',
    outlineTitle: '章节',
    nav: [
      { text: '首页', link: '/' },
      { text: '资料', link: '/书/' },
      { text: '树洞', link: '/树洞/' },
      { text: 'APP', link: 'https://app.releasing.icu' }
    ],
    sidebar: {
      '/树洞/': []
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/shitou333111/releasing_website' }
    ],
    footer: {
      message: '情绪或许就像烟花，释放了会更美好~',
//      copyright: 'Copyright © 2026'
    },
    search: {
      provider: 'local'
    }
  }
}, {
  documentRootPath: 'docs',
  scanStartPath: '/',
  resolvePath: '/',
  useTitleFromFileHeading: false,
  useTitleFromFrontmatter: true,
  useFolderLinkFromIndexFile: true,
  useFolderTitleFromIndexFile: false,
  includeRootIndexFile: false,
  includeFolderIndexFile: false,
  excludeByGlobPattern: ['.vitepress/**', 'public/**', 'content-for-search/**', 'tree-hole/**', '树洞/**', '**/settings.md', '**/帖子.md'],
  collapsed: false,
  debugPrint: false
}));
