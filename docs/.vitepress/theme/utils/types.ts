export interface User {
  id: string;
  name: string;
  avatar?: string;
  email?: string;
  authProvider?: 'local' | 'supabase';
  isAnonymous: boolean;
}

export interface Reply {
  id: string;
  annotationId: string;
  content: string;
  creator: User;
  created: string;
  likes: string[];
}

export interface AnnotationTag {
  id: string;
  name: string;
  color: string;
}

export interface Annotation {
  id: string;
  pagePath: string;
  type: 'text' | 'pdf';
  target: {
    selector: Array<{
      quote?: string;
      start?: number;
      end?: number;
      pageNumber?: number;
      quadpoints?: number[];
    }>;
  };
  bodies: Array<{
    type: 'TextualBody';
    value: string;
    purpose: 'commenting' | 'tagging';
    created: string;
    modified?: string;
  }>;
  creator: User;
  privacy: 'public' | 'private';
  likes: string[];
  replies: Reply[];
  tags: AnnotationTag[];
  color: string;
  created: string;
  modified?: string;
  isCollapsed?: boolean;
}

export interface AnnotationConfig {
  enabled: boolean;
  paths: string[];
  features: {
    pdfAnnotation: boolean;
    replies: boolean;
    likes: boolean;
    privacy: boolean;
  };
  defaultTagColors: string[];
}

export const DEFAULT_TAG_COLORS = [
  '#ff9800',
  '#9c27b0',
  '#4caf50',
  '#f44336'
];
