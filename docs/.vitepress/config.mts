import { defineConfig } from 'vitepress';

export default defineConfig({
  lang: 'zh-CN',
  title: 'Releasing',
  description: 'A VitePress website for publishing content, custom features, and branded presentation.',
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    logo: '/icon-192x192-trans.png',
    nav: [
      { text: '首页', link: '/' },
      { text: '开始', link: '/guide/' }
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
      { icon: 'github', link: 'https://github.com/' }
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
