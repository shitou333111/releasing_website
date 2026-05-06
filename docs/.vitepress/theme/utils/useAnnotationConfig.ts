import { computed } from 'vue';
import { useRoute } from 'vitepress';
import type { AnnotationConfig } from '../utils/types';
import { annotationConfig as projectAnnotationConfig } from '../../annotations.config';

const defaultConfig: AnnotationConfig = {
  enabled: true,
  paths: ['/**'],
  features: {
    pdfAnnotation: true,
    replies: true,
    likes: true,
    privacy: true
  },
  defaultTagColors: [
    '#ffeb3b',
    '#4caf50',
    '#2196f3',
    '#f44336',
    '#9c27b0',
    '#ff9800',
    '#00bcd4',
    '#e91e63'
  ]
};

export function useAnnotationConfig() {
  const route = useRoute();

  function normalizePath(path: string): string {
    const [pathname] = path.split(/[?#]/);
    if (!pathname) return '/';
    if (pathname.length > 1 && pathname.endsWith('/')) {
      return pathname.slice(0, -1);
    }
    return pathname;
  }

  function globToRegExp(pattern: string): RegExp {
    const normalizedPattern = normalizePath(pattern);
    const escaped = normalizedPattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*');
    return new RegExp(`^${escaped}$`);
  }

  function matchesPatterns(path: string, patterns: string[]): boolean {
    return patterns.some(pattern => globToRegExp(pattern).test(path));
  }

  const isEnabledForCurrentPage = computed(() => {
    // 如果全局 enabled 为 false，直接返回 false，不管 paths
    if (!projectAnnotationConfig.enabled) {
      return false;
    }
    
    // 解码 URL 编码的路径
    let currentPath = route.path;
    try {
      currentPath = decodeURI(currentPath);
    } catch (e) {
      // 解码失败时使用原始路径
    }
    currentPath = normalizePath(currentPath);
    
    // 简单检查：只要路径以 /书 开头就启用
    return currentPath.startsWith('/书');
  });

  const config = computed<AnnotationConfig>(() => ({
    ...defaultConfig,
    ...projectAnnotationConfig,
    features: {
      ...defaultConfig.features,
      ...projectAnnotationConfig.features
    },
    defaultTagColors: projectAnnotationConfig.defaultTagColors?.length
      ? projectAnnotationConfig.defaultTagColors
      : defaultConfig.defaultTagColors
  }));

  return {
    isEnabledForCurrentPage,
    config
  };
}
