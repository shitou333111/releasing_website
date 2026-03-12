import { defineConfig } from 'vitepress';

export default defineConfig({
  lang: 'zh-CN',
  appearance: true,
  title: 'Releasing',
  description: 'A VitePress website for publishing content, custom features, and branded presentation.',
  head: [
    ['link', { rel: 'icon', type: 'image/png', href: '/icon-192x192.png' }],
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
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    logo: '/icon-192x192.png',
    nav: [
      { text: '首页', link: '/' },
      { text: 'APP', link: 'https://app.releasing.icu' }
    ],
    sidebar: [
      {
        text: '开始使用',
        items: [
          { text: '项目说明', link: '/guide/' }
        ]
      }
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/shitou333111/releasing_website' }
    ],
    footer: {
      message: 'Built with VitePress.',
      copyright: 'Copyright © 2026'
    },
    search: {
      provider: 'local'
    }
  }
});
