import { defineStore } from 'pinia';
import { ref, computed, watch, shallowRef } from 'vue';
import { v4 as uuidv4 } from 'uuid';
import type { Annotation, User, Reply } from '../utils/types';
import { DEFAULT_TAG_COLORS } from '../utils/types';
import { useUserStore } from './userStore';
import { normalizePagePath } from '../utils/pagePath';
import { deleteCloudAnnotation, fetchCloudAnnotations, upsertCloudAnnotation } from '../utils/cloudStorage';
import { isSupabaseConfigured } from '../utils/supabase';

export const useAnnotationStore = defineStore('annotation', () => {
  const userStore = useUserStore();
  const annotations = shallowRef<Annotation[]>([]);
  const currentPagePath = ref<string>('');
  const selectedAnnotationId = ref<string | null>(null);
  const filterUser = ref<string | null>(null);
  const pageNotesEnabled = ref<boolean>(false);
  const cloudLoadToken = ref(0);

  function getTextPositionKey(annotation: Annotation): number {
    const selectors = Array.isArray(annotation.target?.selector) ? annotation.target.selector : [];
    const starts = selectors
      .map(selector => Number(selector?.start))
      .filter(value => Number.isFinite(value) && value >= 0);

    if (!starts.length) {
      return Number.POSITIVE_INFINITY;
    }

    return Math.min(...starts);
  }

  function getPdfPositionKey(annotation: Annotation): { page: number; topRank: number } {
    const selectors = Array.isArray(annotation.target?.selector) ? annotation.target.selector : [];
    let page = Number.POSITIVE_INFINITY;
    let topRank = Number.POSITIVE_INFINITY;

    selectors.forEach(selector => {
      const pageNumber = Number(selector?.pageNumber || 0);
      const quadpoints = Array.isArray(selector?.quadpoints) ? selector.quadpoints : [];
      if (!Number.isFinite(pageNumber) || pageNumber <= 0 || quadpoints.length < 8) {
        return;
      }

      const ys: number[] = [];
      for (let index = 1; index < quadpoints.length; index += 2) {
        const y = Number(quadpoints[index]);
        if (Number.isFinite(y)) {
          ys.push(y);
        }
      }

      const maxY = ys.length ? Math.max(...ys) : 0;
      const currentTopRank = -maxY;

      if (pageNumber < page || (pageNumber === page && currentTopRank < topRank)) {
        page = pageNumber;
        topRank = currentTopRank;
      }
    });

    return { page, topRank };
  }

  function compareByPagePosition(a: Annotation, b: Annotation): number {
    if (a.type === 'text' && b.type === 'text') {
      const textDelta = getTextPositionKey(a) - getTextPositionKey(b);
      if (Number.isFinite(textDelta) && textDelta !== 0) {
        return textDelta;
      }
    }

    if (a.type === 'pdf' && b.type === 'pdf') {
      const posA = getPdfPositionKey(a);
      const posB = getPdfPositionKey(b);

      if (posA.page !== posB.page) {
        return posA.page - posB.page;
      }

      if (posA.topRank !== posB.topRank) {
        return posA.topRank - posB.topRank;
      }
    }

    if (a.type !== b.type) {
      return a.type === 'text' ? -1 : 1;
    }

    return new Date(a.created).getTime() - new Date(b.created).getTime();
  }

  const filteredAnnotations = computed(() => {
    let result = annotations.value.filter(a => a.pagePath === currentPagePath.value);

    result = result.filter(a => {
      if (a.privacy === 'public') return true;
      return !!userStore.currentUser && a.creator.id === userStore.currentUser.id;
    });

    if (filterUser.value) {
      result = result.filter(a => a.creator.id === filterUser.value);
    }

    return [...result].sort(compareByPagePosition);
  });

  const selectedAnnotation = computed(() => {
    if (!selectedAnnotationId.value) return null;
    return annotations.value.find(a => a.id === selectedAnnotationId.value) || null;
  });

  function setCurrentPage(path: string) {
    currentPagePath.value = normalizePagePath(path);

    if (!pageNotesEnabled.value) {
      annotations.value = [];
      selectedAnnotationId.value = null;
      return;
    }

    void loadAnnotations();
  }

  function setPageNotesEnabled(enabled: boolean) {
    if (pageNotesEnabled.value === enabled) {
      return;
    }

    pageNotesEnabled.value = enabled;

    if (!enabled) {
      annotations.value = [];
      selectedAnnotationId.value = null;
      filterUser.value = null;
      return;
    }

    void loadAnnotations();
  }

  async function loadAnnotations() {
    if (!pageNotesEnabled.value) {
      annotations.value = [];
      return;
    }

    const pagePath = normalizePagePath(currentPagePath.value);
    if (!isSupabaseConfigured) {
      annotations.value = [];
      return;
    }

    const token = ++cloudLoadToken.value;
    const cloudAnnotations = await fetchCloudAnnotations(pagePath);

    if (token !== cloudLoadToken.value || pagePath !== currentPagePath.value) {
      return;
    }

    annotations.value = cloudAnnotations
      .map(annotation => ({
        ...annotation,
        pagePath: normalizePagePath(annotation.pagePath)
      }))
      .sort((a, b) => {
      return new Date(a.created).getTime() - new Date(b.created).getTime();
    });
  }

  async function syncAnnotationToCloud(annotation: Annotation) {
    if (!isSupabaseConfigured) return;
    if (!userStore.isCloudAuthenticated) return;

    await upsertCloudAnnotation(annotation, userStore.currentUser?.id || null);
  }

  function addAnnotation(
    type: 'text' | 'pdf',
    target: Annotation['target'],
    comment: string,
    user: User,
    color: string = DEFAULT_TAG_COLORS[0],
    privacy: 'public' | 'private' = 'public'
  ): Annotation | null {
    if (!userStore.isCloudAuthenticated || !userStore.currentUser) {
      userStore.setAuthError('请先注册/登录后再创建标注');
      return null;
    }

    const now = new Date().toISOString();
    const annotation: Annotation = {
      id: uuidv4(),
      pagePath: normalizePagePath(currentPagePath.value),
      type,
      target,
      bodies: [
        {
          type: 'TextualBody',
          value: comment,
          purpose: 'commenting',
          created: now
        }
      ],
      creator: user,
      privacy,
      likes: [],
      replies: [],
      tags: [],
      color,
      created: now,
      isCollapsed: false
    };

    annotations.value = [...annotations.value, annotation];
    void syncAnnotationToCloud(annotation);
    return annotation;
  }

  function updateAnnotation(id: string, updates: Partial<Annotation>) {
    const index = annotations.value.findIndex(a => a.id === id);
    if (index >= 0) {
      const newAnnotations = [...annotations.value];
      newAnnotations[index] = {
        ...newAnnotations[index],
        ...updates,
        pagePath: normalizePagePath(newAnnotations[index].pagePath),
        modified: new Date().toISOString()
      };
      annotations.value = newAnnotations;

      const updated = newAnnotations[index];
      if (userStore.currentUser?.id === updated.creator.id) {
        void syncAnnotationToCloud(updated);
      }
    }
  }

  function deleteAnnotation(id: string) {
    const target = annotations.value.find(a => a.id === id);
    if (!target || !userStore.currentUser || target.creator.id !== userStore.currentUser.id) {
      return;
    }

    annotations.value = annotations.value.filter(a => a.id !== id);
    void deleteCloudAnnotation(id, userStore.currentUser.id);
    if (selectedAnnotationId.value === id) {
      selectedAnnotationId.value = null;
    }
  }

  function selectAnnotation(id: string | null) {
    selectedAnnotationId.value = id;
  }

  function toggleLike(annotationId: string, userId: string) {
    const newAnnotations = [...annotations.value];
    const annotation = newAnnotations.find(a => a.id === annotationId);
    if (annotation) {
      const likeIndex = annotation.likes.indexOf(userId);
      const updatedAnnotation = {
        ...annotation,
        likes: likeIndex >= 0
          ? annotation.likes.filter((_, i) => i !== likeIndex)
          : [...annotation.likes, userId]
      };
      
      const index = newAnnotations.findIndex(a => a.id === annotationId);
      newAnnotations[index] = updatedAnnotation;
      annotations.value = newAnnotations;

      if (userStore.currentUser?.id === updatedAnnotation.creator.id) {
        void syncAnnotationToCloud(updatedAnnotation);
      }
    }
  }

  function addReply(annotationId: string, content: string, user: User) {
    const newAnnotations = [...annotations.value];
    const annotation = newAnnotations.find(a => a.id === annotationId);
    if (annotation) {
      const reply: Reply = {
        id: uuidv4(),
        annotationId,
        content,
        creator: user,
        created: new Date().toISOString(),
        likes: []
      };
      
      const updatedAnnotation = {
        ...annotation,
        replies: [...annotation.replies, reply]
      };
      
      const index = newAnnotations.findIndex(a => a.id === annotationId);
      newAnnotations[index] = updatedAnnotation;
      annotations.value = newAnnotations;

      if (userStore.currentUser?.id === updatedAnnotation.creator.id) {
        void syncAnnotationToCloud(updatedAnnotation);
      }
    }
  }

  function deleteReply(annotationId: string, replyId: string) {
    const newAnnotations = [...annotations.value];
    const annotation = newAnnotations.find(a => a.id === annotationId);
    if (annotation) {
      const updatedAnnotation = {
        ...annotation,
        replies: annotation.replies.filter(r => r.id !== replyId)
      };
      
      const index = newAnnotations.findIndex(a => a.id === annotationId);
      newAnnotations[index] = updatedAnnotation;
      annotations.value = newAnnotations;

      if (userStore.currentUser?.id === updatedAnnotation.creator.id) {
        void syncAnnotationToCloud(updatedAnnotation);
      }
    }
  }

  function toggleReplyLike(annotationId: string, replyId: string, userId: string) {
    const newAnnotations = [...annotations.value];
    const annotation = newAnnotations.find(a => a.id === annotationId);
    if (annotation) {
      const updatedReplies = annotation.replies.map(reply => {
        if (reply.id === replyId) {
          const likeIndex = reply.likes.indexOf(userId);
          return {
            ...reply,
            likes: likeIndex >= 0
              ? reply.likes.filter((_, i) => i !== likeIndex)
              : [...reply.likes, userId]
          };
        }
        return reply;
      });
      
      const updatedAnnotation = {
        ...annotation,
        replies: updatedReplies
      };
      
      const index = newAnnotations.findIndex(a => a.id === annotationId);
      newAnnotations[index] = updatedAnnotation;
      annotations.value = newAnnotations;

      if (userStore.currentUser?.id === updatedAnnotation.creator.id) {
        void syncAnnotationToCloud(updatedAnnotation);
      }
    }
  }

  function setFilterUser(userId: string | null) {
    filterUser.value = userId;

    if (
      selectedAnnotationId.value &&
      !filteredAnnotations.value.some(annotation => annotation.id === selectedAnnotationId.value)
    ) {
      selectedAnnotationId.value = null;
    }
  }

  watch(
    () => userStore.currentUser?.id,
    () => {
      if (!pageNotesEnabled.value) return;
      void loadAnnotations();
    }
  );

  watch(
    () => userStore.isCloudAuthenticated,
    () => {
      if (!pageNotesEnabled.value) return;
      void loadAnnotations();
    }
  );

  return {
    annotations,
    currentPagePath,
    selectedAnnotationId,
    filterUser,
    pageNotesEnabled,
    filteredAnnotations,
    selectedAnnotation,
    setCurrentPage,
    setPageNotesEnabled,
    loadAnnotations,
    addAnnotation,
    updateAnnotation,
    deleteAnnotation,
    selectAnnotation,
    toggleLike,
    addReply,
    deleteReply,
    toggleReplyLike,
    setFilterUser
  };
});
