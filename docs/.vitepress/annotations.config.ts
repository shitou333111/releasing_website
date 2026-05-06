import type { AnnotationConfig } from '../theme/utils/types';

export const annotationConfig: AnnotationConfig = {
  enabled: true, // 开启路径配置
  paths: [
    '/书/**' // 书目录及其所有子目录和文件都启用
  ],
  features: {
    pdfAnnotation: false,
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
