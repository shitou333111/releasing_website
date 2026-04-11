import { computed } from 'vue';
import { useRoute } from 'vitepress';
import type { AnnotationConfig } from '../utils/types';
import { annotationConfig as projectAnnotationConfig } from '../../config/annotations.config';

const defaultConfig: AnnotationConfig = {
  enabled: true,
  paths: {
    enabled: ['/**'],
    disabled: []
  },
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
    const currentPath = normalizePath(route.path);
    const enabledPatterns = projectAnnotationConfig.paths.enabled;
    const disabledPatterns = projectAnnotationConfig.paths.disabled;

    const enabledByPath = enabledPatterns.length === 0
      ? true
      : matchesPatterns(currentPath, enabledPatterns);

    const disabledByPath = disabledPatterns.length > 0
      && matchesPatterns(currentPath, disabledPatterns);

    return projectAnnotationConfig.enabled && enabledByPath && !disabledByPath;
  });

  const config = computed<AnnotationConfig>(() => ({
    ...defaultConfig,
    ...projectAnnotationConfig,
    paths: {
      ...defaultConfig.paths,
      ...projectAnnotationConfig.paths
    },
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
