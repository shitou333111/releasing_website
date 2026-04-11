import type { AnnotationConfig } from '../theme/utils/types';

export const annotationConfig: AnnotationConfig = {
  enabled: true,
  paths: {
    enabled: [
      '/*/*',
      '/**'
    ],
    disabled: []
  },
  features: {
    pdfAnnotation: true,
    replies: true,
    likes: true,
    privacy: true
  },
  defaultTagColors: [
    '#ff9800',
    '#9c27b0',
    '#4caf50',
    '#f44336'
  ]
};
