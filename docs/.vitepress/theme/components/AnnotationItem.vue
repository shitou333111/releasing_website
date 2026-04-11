<script setup lang="ts">
import { ref, computed, onUnmounted, watch, nextTick } from 'vue';
import { useUserStore } from '../stores/userStore';
import { useAnnotationStore } from '../stores/annotationStore';
import { useAnnotationConfig } from '../composables/useAnnotationConfig';
import type { Annotation } from '../utils/types';
import { copyTextToClipboard } from '../utils/clipboard';

const props = defineProps<{
  annotation: Annotation;
}>();

const userStore = useUserStore();
const annotationStore = useAnnotationStore();
const { config } = useAnnotationConfig();

const showReplies = ref(false);
const showReplyInput = ref(false);
const replyContent = ref('');
const copyFeedbackVisible = ref(false);
const editContent = ref('');
const isEditingComment = ref(false);
const commentEditorRef = ref<HTMLTextAreaElement | null>(null);
let copyFeedbackTimeout = 0;

const isActive = computed(() => annotationStore.selectedAnnotationId === props.annotation.id);

const isLiked = computed(() => 
  userStore.currentUser && props.annotation.likes.includes(userStore.currentUser.id)
);

const isOwner = computed(() => 
  userStore.currentUser && props.annotation.creator.id === userStore.currentUser.id
);

const originalContent = computed(() => props.annotation.bodies[0]?.value || '');

const canUpdateComment = computed(() => {
  if (!isOwner.value) return false;
  return editContent.value.trim() !== originalContent.value.trim();
});

watch(
  () => props.annotation.bodies[0]?.value,
  (nextValue) => {
    if (!isEditingComment.value) {
      editContent.value = nextValue || '';
    }
  },
  { immediate: true }
);

function formatDate(input?: string): string {
  if (!input) return '';
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return '';

  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

function toggleLike() {
  if (userStore.currentUser) {
    annotationStore.toggleLike(props.annotation.id, userStore.currentUser.id);
  }
}

async function beginEditComment() {
  if (!isOwner.value) return;

  handleClick();

  isEditingComment.value = true;
  await nextTick();
  commentEditorRef.value?.focus();
}

function handleCommentEditorBlur() {
  isEditingComment.value = false;
}

function updateComment() {
  if (!canUpdateComment.value) return;

  const now = new Date().toISOString();
  const createdAt = props.annotation.bodies[0]?.created || now;

  annotationStore.updateAnnotation(props.annotation.id, {
    bodies: [
      {
        type: 'TextualBody',
        value: editContent.value.trim(),
        purpose: 'commenting',
        created: createdAt,
        modified: now
      }
    ]
  });

  isEditingComment.value = false;
}

function toggleReplies() {
  showReplies.value = !showReplies.value;
  if (!showReplies.value) {
    showReplyInput.value = false;
    replyContent.value = '';
  }
}

function submitReply() {
  if (!userStore.isLoggedIn) {
    userStore.setAuthError('请先注册/登录后再回复');
    userStore.openAuthModal();
    return;
  }

  if (replyContent.value.trim() && userStore.currentUser) {
    annotationStore.addReply(props.annotation.id, replyContent.value.trim(), userStore.currentUser);
    replyContent.value = '';
    showReplyInput.value = false;
  }
}

async function copyAnnotationContent() {
  const quote = props.annotation.target.selector[0]?.quote?.trim() || '';
  const comment = props.annotation.bodies[0]?.value?.trim() || '';

  const content = comment
    ? `高亮：${quote || '(无)'}\n笔记：${comment}`
    : quote;

  if (!content) return;

  try {
    const copied = await copyTextToClipboard(content);
    if (!copied) {
      throw new Error('clipboard copy fallback failed');
    }

    copyFeedbackVisible.value = true;
    if (copyFeedbackTimeout) {
      window.clearTimeout(copyFeedbackTimeout);
    }
    copyFeedbackTimeout = window.setTimeout(() => {
      copyFeedbackVisible.value = false;
      copyFeedbackTimeout = 0;
    }, 1100);
  } catch (error) {
    console.error('Failed to copy annotation card content:', error);
  }
}

function deleteAnnotation() {
  if (confirm('确定要删除这个标注吗？')) {
    annotationStore.deleteAnnotation(props.annotation.id);
  }
}

function toggleReplyLike(replyId: string) {
  if (userStore.currentUser) {
    annotationStore.toggleReplyLike(props.annotation.id, replyId, userStore.currentUser.id);
  }
}

function handleClick() {
  document.dispatchEvent(new CustomEvent('annotation-card-select', {
    detail: {
      annotationId: props.annotation.id,
      source: 'sidebar-card'
    }
  }));

  annotationStore.selectAnnotation(props.annotation.id);

  const candidateSelectors = [
    `.vp-doc [data-annotation-id="${props.annotation.id}"]`,
    `.vp-doc [data-id="${props.annotation.id}"]`,
    `.pdf-viewer-container [data-annotation-id="${props.annotation.id}"]`,
    `.pdf-viewer-container [data-id="${props.annotation.id}"]`,
    `.r6o-annotation[data-id="${props.annotation.id}"]`,
    `.r6o-annotation[data-annotation-id="${props.annotation.id}"]`
  ];

  const directMatch = candidateSelectors
    .map(selector => document.querySelector(selector))
    .find(Boolean) as HTMLElement | null;

  if (directMatch) {
    directMatch.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  const quote = props.annotation.target.selector[0]?.quote;
  if (!quote) return;

  const quoteContainer = Array.from(document.querySelectorAll('.vp-doc p, .vp-doc li, .vp-doc blockquote'))
    .find(el => el.textContent?.includes(quote)) as HTMLElement | undefined;

  quoteContainer?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function toggleReplyInput() {
  if (!userStore.isLoggedIn) {
    userStore.setAuthError('请先注册/登录后再回复');
    userStore.openAuthModal();
    return;
  }

  showReplyInput.value = !showReplyInput.value;
}

onUnmounted(() => {
  if (copyFeedbackTimeout) {
    window.clearTimeout(copyFeedbackTimeout);
    copyFeedbackTimeout = 0;
  }
});
</script>

<template>
  <div 
    class="annotation-item" 
    :class="{ active: isActive }"
    :style="{ borderLeftColor: annotation.color, '--annotation-color': annotation.color }"
    :data-annotation-id="annotation.id"
    @click="handleClick"
  >
    <div class="annotation-item-header">
      <div class="annotation-user-meta">
        <span class="annotation-user">{{ annotation.creator.name }}</span>
        <span class="annotation-date">{{ formatDate(annotation.created) }}</span>
      </div>
      <div v-if="config.features.privacy" class="annotation-privacy">
        {{ annotation.privacy === 'public' ? '公开' : '私密' }}
      </div>
    </div>

    <div class="annotation-quote">
      {{ annotation.target.selector[0]?.quote || '(已选内容)' }}
    </div>

    <div v-if="isOwner" class="annotation-comment-wrap">
      <div
        v-if="!isEditingComment"
        class="annotation-comment annotation-comment-editable"
        @click.stop="beginEditComment"
      >
        {{ editContent || '（点击添加笔记）' }}
      </div>
      <textarea
        v-else
        ref="commentEditorRef"
        v-model="editContent"
        class="annotation-comment-editor"
        placeholder="请输入笔记（可选）"
        rows="3"
        @click.stop
        @blur="handleCommentEditorBlur"
      ></textarea>
    </div>
    <div v-else-if="annotation.bodies[0]?.value" class="annotation-comment">
      {{ annotation.bodies[0]?.value }}
    </div>

    <div class="annotation-actions">
      <button 
        v-if="config.features.likes"
        class="annotation-action-btn" 
        :class="{ liked: isLiked }"
        @click.stop="toggleLike"
      >
        <span class="like-icon" aria-hidden="true">{{ isLiked ? '♥' : '♡' }}</span>
        {{ annotation.likes.length }}
      </button>
      <button v-if="config.features.replies" class="annotation-action-btn" @click.stop="toggleReplies">
        💬 {{ annotation.replies.length }}
      </button>
      <button class="annotation-action-btn copy-only" :class="{ copied: copyFeedbackVisible }" @click.stop="copyAnnotationContent">
        <span class="copy-icon" aria-hidden="true">{{ copyFeedbackVisible ? '✓' : '⧉' }}</span>
        <span v-if="!copyFeedbackVisible">复制</span>
      </button>
      <button
        v-if="isOwner"
        class="annotation-action-btn"
        :class="{ disabled: !canUpdateComment }"
        :disabled="!canUpdateComment"
        @click.stop="updateComment"
      >
        更新
      </button>
      <button v-if="isOwner" class="annotation-action-btn delete-action" @click.stop="deleteAnnotation" aria-label="删除标注" title="删除">
        <svg class="card-trash-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M9 3.5h6m-9 3h12m-1 0-.8 11.1a1.5 1.5 0 0 1-1.5 1.4H9.3a1.5 1.5 0 0 1-1.5-1.4L7 6.5m3 3.5v5.2m4-5.2v5.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
      </button>
    </div>

    <div v-if="config.features.replies && showReplies" class="replies-section">
      <div v-for="reply in annotation.replies" :key="reply.id" class="reply-item">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
          <div class="annotation-user-meta" style="font-size: 11px;">
            <span>{{ reply.creator.name }}</span>
            <span class="annotation-date">{{ formatDate(reply.created) }}</span>
          </div>
          <button 
            class="annotation-action-btn" 
            :style="{ padding: '2px 4px', fontSize: '10px' }"
            :class="{ liked: userStore.currentUser && reply.likes.includes(userStore.currentUser.id) }"
            @click.stop="toggleReplyLike(reply.id)"
          >
            <span class="like-icon" aria-hidden="true">{{ userStore.currentUser && reply.likes.includes(userStore.currentUser.id) ? '♥' : '♡' }}</span>
            {{ reply.likes.length }}
          </button>
        </div>
        <div style="font-size: 12px;">{{ reply.content }}</div>
      </div>

      <div style="margin-top: 8px;">
        <button class="annotation-action-btn" @click.stop="toggleReplyInput">
          {{ showReplyInput ? '收起回复框' : '写回复' }}
        </button>
      </div>

      <div v-if="showReplyInput">
        <textarea 
          v-model="replyContent"
          class="reply-input"
          placeholder="输入回复内容..."
          rows="2"
          @keyup.ctrl.enter="submitReply"
        ></textarea>
        <div style="display: flex; gap: 8px; margin-top: 8px;">
          <button class="modal-btn cancel" @click.stop="showReplyInput = false; replyContent = '';" style="padding: 4px 10px; font-size: 12px;">取消</button>
          <button class="modal-btn submit" @click.stop="submitReply" style="padding: 4px 10px; font-size: 12px;">回复</button>
        </div>
      </div>
    </div>
  </div>
</template>
