<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, nextTick } from 'vue';
import { useRoute } from 'vitepress';
import { useUserStore } from '../stores/userStore';
import { useTreeHoleStore } from './treeHoleStore';
import type { TreeHoleThreadCard, TreeHoleView } from './treeholeTypes';
import { TREEHOLE_MAX_IMAGE_FILES, TREEHOLE_MAX_IMAGE_SIZE_MB, validateImageFiles } from './treeholeLimits';

const route = useRoute();

const props = withDefaults(defineProps<{ view?: TreeHoleView }>(), {
  view: 'all'
});

function resolveViewFromRoute(path: string): TreeHoleView {
  if (path.startsWith('/树洞/favorites')) return 'favorites';
  if (path.startsWith('/树洞/mine')) return 'mine';
  if (path.startsWith('/树洞/replies')) return 'replies';
  return 'all';
}

function deriveInitialView(): TreeHoleView {
  if (props.view && props.view !== 'all') {
    return props.view;
  }
  return resolveViewFromRoute(route.path);
}

const activeView = ref<TreeHoleView>(deriveInitialView());

const userStore = useUserStore();
const treeHoleStore = useTreeHoleStore();

const showCreateForm = ref(false);
const threadTitle = ref('');
const threadContent = ref('');
const threadImageFiles = ref<File[]>([]);
const threadImagePreviewUrls = ref<string[]>([]);

const replyContent = ref('');
const replyingThreadId = ref<string | null>(null);

const localError = ref('');

const lightboxOpen = ref(false);
const lightboxImageSrc = ref('');

const expandedThreadIds = ref<Set<string>>(new Set());
const observer = ref<IntersectionObserver | null>(null);
const prefetchObserver = ref<IntersectionObserver | null>(null);
const lastCardRef = ref<HTMLDivElement | null>(null);
const threadCardMap = new Map<string, HTMLElement>();
const prefetchedThreadIds = new Set<string>();
const PRELOAD_BELOW_COUNT = 10;
const MAX_SEARCH_PAGES = 20;

const isLoggedIn = computed(() => userStore.isLoggedIn && !!userStore.currentUser);
const currentUserId = computed(() => userStore.currentUser?.id || null);

const requiresLogin = computed(() => {
  return activeView.value === 'mine' || activeView.value === 'favorites' || activeView.value === 'replies';
});

const canShowThreadComposer = computed(() => {
  return activeView.value === 'all' || activeView.value === 'mine' || activeView.value === 'favorites' || activeView.value === 'replies';
});

const tabItems = [
  { value: 'all' as TreeHoleView, label: '全部帖子' },
  { value: 'mine' as TreeHoleView, label: '发布的帖子' },
  { value: 'favorites' as TreeHoleView, label: '收藏的帖子' },
  { value: 'replies' as TreeHoleView, label: '回复' }
];

// 固定的 alias initial 颜色映射
const BADGE_COLOR_MAP: Record<string, string> = {
  'A': '#7AA2E3',
  'B': '#F38C8C',
  'C': '#99DDCC',
  'D': '#F7D08A'
};
// 备用颜色，用于其他字符
const BADGE_COLORS_FALLBACK = [
  '#B19CD9', '#A8D8EA', '#FFB3BA', '#BAFFC9', '#FFFFBA', '#BAE1FF'
];

const dailySequenceMap = computed(() => {
  const sorted = [...treeHoleStore.threads].sort((a, b) => 
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  const byDate = new Map<string, number>();
  const seqMap = new Map<string, string>();

  sorted.forEach((thread) => {
    const datePart = toDatePart(thread.createdAt);
    const next = (byDate.get(datePart) || 0) + 1;
    byDate.set(datePart, next);
    seqMap.set(thread.id, `${datePart}-${String(next).padStart(3, '0')}`);
  });

  return seqMap;
});

function toDatePart(dateInput: string | Date | null | undefined): string {
  const date = dateInput ? new Date(dateInput) : new Date();
  if (Number.isNaN(date.getTime())) {
    const now = new Date();
    return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  }

  const y = String(date.getFullYear());
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function getBadgeColor(alias: string | null | undefined) {
  const initial = getAliasInitial(alias);
  // 如果在固定颜色映射中有，优先使用固定颜色
  if (BADGE_COLOR_MAP[initial]) {
    return BADGE_COLOR_MAP[initial];
  }
  // 否则使用备用颜色池
  let h = 0;
  const s = String(alias || 'anon');
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return BADGE_COLORS_FALLBACK[h % BADGE_COLORS_FALLBACK.length];
}

function getAliasInitial(alias: string | null | undefined) {
  const normalized = String(alias || '?').trim();
  return (normalized[0] || '?').toUpperCase();
}

function formatThreadNo(thread: Partial<TreeHoleThreadCard>) {
  const raw = String(thread.threadNo || '').trim();
  if (/^\d{8}-\d{3}$/.test(raw)) {
    return raw;
  }

  if (/^TH-\d{4}-\d+$/.test(raw)) {
    const suffix = String(raw.split('-').pop() || '1').slice(-3).padStart(3, '0');
    return `${toDatePart(thread.createdAt)}-${suffix}`;
  }

  if (thread.id && dailySequenceMap.value.has(thread.id)) {
    return dailySequenceMap.value.get(thread.id) as string;
  }

  return `${toDatePart(thread.createdAt)}-001`;
}

function formatShortThreadNo(thread: Partial<TreeHoleThreadCard>) {
  // 始终返回完整的编号格式，如 20261103-001
  return formatThreadNo(thread);
}

function resetThreadForm() {
  threadTitle.value = '';
  threadContent.value = '';
  threadImageFiles.value = [];
  threadImagePreviewUrls.value.forEach(url => URL.revokeObjectURL(url));
  threadImagePreviewUrls.value = [];
}

function clearThreadImage() {
  threadImageFiles.value = [];
  threadImagePreviewUrls.value.forEach(url => URL.revokeObjectURL(url));
  threadImagePreviewUrls.value = [];
}

function resetAuthForm() {
  userStore.clearAuthMessages();
}

function setLocalError(message: string) {
  localError.value = message;
}

function clearLocalError() {
  localError.value = '';
}

function handleLogout() {
  userStore.logout();
}

function openAuthModal() {
  resetAuthForm();
  userStore.openAuthModal();
}

function closeAuthModal() {
  userStore.closeAuthModal();
  resetAuthForm();
}

function toggleThreadExpand(threadId: string) {
  if (expandedThreadIds.value.has(threadId)) {
    expandedThreadIds.value.delete(threadId);
  } else {
    expandedThreadIds.value.add(threadId);
    treeHoleStore.loadThreadDetail(threadId, currentUserId.value);
  }
}

function setActiveView(view: TreeHoleView) {
  if (activeView.value === view) return;
  activeView.value = view;
  showCreateForm.value = false;
  resetThreadForm();
  loadCurrentViewAndRestoreScroll();
}

function openLightbox(src: string) {
  if (!src) return;
  lightboxImageSrc.value = src;
  lightboxOpen.value = true;
}

function closeLightbox() {
  lightboxOpen.value = false;
  lightboxImageSrc.value = '';
}

function handleThreadImagesChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = (input.files && input.files[0]) || null;
  const files = file ? [file] : [];
  const validationError = validateImageFiles(files);

  if (validationError) {
    setLocalError(validationError);
    input.value = '';
    return;
  }

  clearLocalError();
  
  threadImagePreviewUrls.value.forEach(url => URL.revokeObjectURL(url));
  
  threadImageFiles.value = files;
  threadImagePreviewUrls.value = files.map(f => URL.createObjectURL(f));
}

function triggerThreadImageUpload() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = (e) => handleThreadImagesChange(e);
  input.click();
}

async function handleCreateThread() {
  clearLocalError();

  if (!isLoggedIn.value || !currentUserId.value) {
    openAuthModal();
    return;
  }

  if (!threadTitle.value.trim()) {
    setLocalError('请输入帖子标题');
    return;
  }

  if (!threadContent.value.trim()) {
    setLocalError('请输入帖子内容');
    return;
  }

  const validationError = validateImageFiles(threadImageFiles.value);
  if (validationError) {
    setLocalError(validationError);
    return;
  }

  await treeHoleStore.submitThread(
    {
      title: threadTitle.value.trim(),
      content: threadContent.value.trim(),
      visibility: 'public',
      images: threadImageFiles.value
    },
    currentUserId.value
  );

  showCreateForm.value = false;
  resetThreadForm();
}

async function handleCreateReply(threadId: string) {
  clearLocalError();

  if (!isLoggedIn.value || !currentUserId.value) {
    openAuthModal();
    return;
  }

  if (!replyContent.value.trim()) {
    setLocalError('请输入回复内容');
    return;
  }

  await treeHoleStore.submitReply(
    {
      threadId: threadId,
      content: replyContent.value.trim(),
      images: []
    },
    currentUserId.value
  );

  replyContent.value = '';
  replyingThreadId.value = null;
}

async function handleToggleFavorite(threadId: string, currentFavorited: boolean) {
  if (!currentUserId.value) {
    openAuthModal();
    return;
  }

  await treeHoleStore.toggleFavorite(threadId, currentFavorited, currentUserId.value);
}

function setupObserver() {
  if (observer.value) {
    observer.value.disconnect();
  }

  observer.value = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && !treeHoleStore.loadingMore && treeHoleStore.hasMore) {
          treeHoleStore.loadMore(currentUserId.value);
        }
      }
    },
    {
      rootMargin: '200px'
    }
  );
}

function setThreadCardRef(threadId: string, el: Element | null, index: number) {
  const element = el as HTMLElement | null;
  if (element) {
    threadCardMap.set(threadId, element);
  } else {
    threadCardMap.delete(threadId);
  }

  if (index === treeHoleStore.threads.length - 1) {
    lastCardRef.value = element as HTMLDivElement | null;
  }
}

function prefetchFromIndex(startIndex: number) {
  const threads = treeHoleStore.threads;
  const endIndex = Math.min(threads.length - 1, startIndex + PRELOAD_BELOW_COUNT);

  for (let i = startIndex; i <= endIndex; i += 1) {
    const thread = threads[i];
    if (!thread || prefetchedThreadIds.has(thread.id)) continue;
    prefetchedThreadIds.add(thread.id);
    treeHoleStore.loadThreadDetail(thread.id, currentUserId.value);
  }
}

function setupPrefetchObserver() {
  if (prefetchObserver.value) {
    prefetchObserver.value.disconnect();
  }

  prefetchObserver.value = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const target = entry.target as HTMLElement;
        const index = Number(target.dataset.threadIndex || -1);
        if (Number.isFinite(index) && index >= 0) {
          prefetchFromIndex(index);
        }
      }
    },
    {
      rootMargin: '200px 0px 800px 0px',
      threshold: 0
    }
  );

  for (const el of threadCardMap.values()) {
    prefetchObserver.value.observe(el);
  }
}

async function jumpToThreadById(threadId: string) {
  if (!threadId) return;

  let index = treeHoleStore.threads.findIndex(thread => thread.id === threadId);
  let attempts = 0;

  while (index === -1 && treeHoleStore.hasMore && attempts < MAX_SEARCH_PAGES) {
    await treeHoleStore.loadMore(currentUserId.value);
    index = treeHoleStore.threads.findIndex(thread => thread.id === threadId);
    attempts += 1;
  }

  if (index === -1) {
    return;
  }

  const thread = treeHoleStore.threads[index];
  expandedThreadIds.value.add(thread.id);
  await treeHoleStore.loadThreadDetail(thread.id, currentUserId.value);
  await nextTick();

  const el = threadCardMap.get(thread.id);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function loadCurrentViewAndRestoreScroll() {
  const savedPosition = treeHoleStore.getScrollPosition(activeView.value);
  prefetchedThreadIds.clear();
  treeHoleStore.loadView(activeView.value, currentUserId.value).then(async () => {
    await nextTick();
    const pendingThreadId = sessionStorage.getItem('treehole_search_thread_id');
    if (pendingThreadId) {
      sessionStorage.removeItem('treehole_search_thread_id');
      await jumpToThreadById(pendingThreadId);
      return;
    }

    window.scrollTo(0, savedPosition);
  });
}

watch(
  () => [props.view, route.path],
  () => {
    const nextView = deriveInitialView();
    if (route.path === '/树洞/' && props.view === 'all') {
      return;
    }
    if (activeView.value !== nextView) {
      activeView.value = nextView;
      showCreateForm.value = false;
      resetThreadForm();
      loadCurrentViewAndRestoreScroll();
    }
  }
);

watch(
  () => currentUserId.value,
  async () => {
    await treeHoleStore.loadView(activeView.value, currentUserId.value);
  }
);

watch(lastCardRef, (newEl) => {
  if (!observer.value) return;
  
  observer.value.disconnect();
  if (newEl) {
    observer.value.observe(newEl);
  }
}, { flush: 'post' });

watch(() => treeHoleStore.threads.length, () => {
  nextTick(() => {
    setupPrefetchObserver();
  });
});

onMounted(async () => {
  if (!userStore.currentUser) {
    await userStore.initUser();
  }
  setupObserver();
  loadCurrentViewAndRestoreScroll();
});

onUnmounted(() => {
  treeHoleStore.saveScrollPosition(activeView.value);
  if (observer.value) {
    observer.value.disconnect();
  }
  if (prefetchObserver.value) {
    prefetchObserver.value.disconnect();
  }
});
</script>

<template>
  <section class="treehole-wrap">
    <header class="treehole-topbar">
      <div class="treehole-topbar-left">
        <h2 class="treehole-title">树洞</h2>
        <span class="treehole-subtitle">匿名发帖/回复</span>
      </div>
      <div class="treehole-topbar-right">
        <div class="treehole-auth-inline">
          <button v-if="!isLoggedIn" class="treehole-btn" @click="openAuthModal">注册/登录</button>
          <template v-else>
            <span class="treehole-username-badge">{{ userStore.currentUser?.name }}</span>
            <button class="treehole-btn treehole-btn-ghost" @click="handleLogout">退出</button>
          </template>
          <button v-if="canShowThreadComposer" class="treehole-btn treehole-btn-primary" :disabled="!isLoggedIn" @click="showCreateForm = !showCreateForm">
            {{ showCreateForm ? '收起' : '发帖' }}
          </button>
        </div>
      </div>
    </header>

    <div class="treehole-alert treehole-alert-error" v-if="localError || treeHoleStore.error">
      {{ localError || treeHoleStore.error }}
    </div>

    <div class="treehole-page-title-wrapper">
      <div class="treehole-tab-group">
        <button
          v-for="tab in tabItems"
          :key="tab.value"
          class="treehole-tab"
          :class="{ active: activeView === tab.value }"
          @click="setActiveView(tab.value)"
        >
          {{ tab.label }}
        </button>
      </div>
      <button v-if="activeView === 'all'" class="treehole-refresh-btn" @click="treeHoleStore.refresh(currentUserId)">
        <svg viewBox="0 0 24 24" width="20" height="20" :class="{ 'treehole-refresh-spinning': treeHoleStore.isRefreshing }">
          <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"></path>
        </svg>
      </button>
    </div>

    <div class="treehole-composer" v-if="showCreateForm">
      <label>
        <input v-model="threadTitle" maxlength="120" placeholder="输入帖子标题" type="text">
      </label>
      <label>
        <textarea v-model="threadContent" rows="5" placeholder="输入帖子内容"></textarea>
      </label>
      <label>
        <span class="upload-hint" @click="triggerThreadImageUpload">上传图片（仅限一张）</span>
      </label>
      <div class="treehole-image-preview" v-if="threadImagePreviewUrls.length">
        <div class="treehole-image-preview-wrapper">
          <img :src="threadImagePreviewUrls[0]" alt="预览图片">
          <button class="treehole-image-delete-btn" @click="clearThreadImage">
            <svg viewBox="0 0 24 24" width="16" height="16">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"></path>
            </svg>
          </button>
        </div>
      </div>
      <button class="treehole-btn treehole-btn-primary" :disabled="treeHoleStore.creatingThread" @click="handleCreateThread">
        {{ treeHoleStore.creatingThread ? '发布中...' : '发布帖子' }}
      </button>
    </div>

    <template v-if="activeView === 'replies'">
      <div class="treehole-replies-list" v-if="!treeHoleStore.loadingList">
        <article class="treehole-reply-card" v-for="item in treeHoleStore.receivedReplies" :key="item.id">
          <header>
            <strong><span class="thread-number">[{{ formatShortThreadNo({ threadNo: item.threadNo, createdAt: item.createdAt }) }}]</span> {{ item.threadTitle }}</strong>
          </header>
          <p class="treehole-reply-content">{{ item.content }}</p>
          <footer>
            <span>来自 {{ item.authorAlias }}</span>
            <span>{{ new Date(item.createdAt).toLocaleString() }}</span>
          </footer>
        </article>
        <p v-if="treeHoleStore.receivedReplies.length === 0" class="treehole-empty">暂无收到的回复</p>
      </div>
      <p v-else class="treehole-empty">加载中...</p>
    </template>

    <template v-else>
      <div class="treehole-list-shell">
        <p v-if="treeHoleStore.loadingList" class="treehole-empty">加载帖子中...</p>

        <article
          class="treehole-thread-card"
          :class="{ 'treehole-thread-card-expanded': expandedThreadIds.has(thread.id) }"
          v-for="(thread, index) in treeHoleStore.threads"
          :key="thread.id"
          :data-thread-id="thread.id"
          :data-thread-index="index"
          :ref="(el) => setThreadCardRef(thread.id, el, index)"
        >
          <div class="treehole-thread-main" @click="toggleThreadExpand(thread.id)">
            <header>
              <strong><span class="thread-number">[{{ formatShortThreadNo(thread) }}]</span> {{ thread.title }}</strong>
            </header>
            <div class="treehole-thread-content" :class="{ 'treehole-thread-content-truncated': !expandedThreadIds.has(thread.id) && thread.content.length > 150 }">
              {{ thread.content }}
            </div>
            <div class="treehole-click-expand" v-if="!expandedThreadIds.has(thread.id) && thread.content.length > 150">
              点击展开
            </div>
            <div class="treehole-images" v-if="thread.images.length && expandedThreadIds.has(thread.id)">
              <img
                v-for="image in thread.images"
                :key="image.id"
                :src="image.publicUrl"
                alt="帖子图片"
                @click.stop="openLightbox(image.publicUrl)"
              >
            </div>
          </div>

          <template v-if="expandedThreadIds.has(thread.id)">
            <div class="treehole-replies">
              <h4>回复 ({{ treeHoleStore.threadDetails.get(thread.id)?.replies.length || 0 }})</h4>
              <article class="treehole-reply" v-for="(reply, idx) in (treeHoleStore.threadDetails.get(thread.id)?.replies || [])" :key="reply.id">
                <header>
                  <span class="reply-number">#{{ idx + 1 }}</span>
                  <span class="author-badge" :style="{ background: getBadgeColor(reply.authorAlias) }">{{ getAliasInitial(reply.authorAlias) }}</span>
                  <span>{{ new Date(reply.createdAt).toLocaleString() }}</span>
                </header>
                <p>{{ reply.content }}</p>
              </article>
            </div>

            <div class="treehole-composer treehole-reply-composer" v-if="isLoggedIn">
              <label>
                <textarea v-model="replyContent" rows="4" placeholder="输入回复内容"></textarea>
              </label>
              <button class="treehole-btn treehole-btn-primary" :disabled="treeHoleStore.creatingReply" @click="handleCreateReply(thread.id)">
                {{ treeHoleStore.creatingReply ? '发送中...' : '发送回复' }}
              </button>
            </div>
            <div v-else class="treehole-reply-login-hint">
              <button class="treehole-btn" @click="openAuthModal">登录后回复</button>
            </div>
          </template>

          <div class="treehole-thread-footer">
            <span class="author-badge" :style="{ background: getBadgeColor(thread.creatorAlias) }">{{ getAliasInitial(thread.creatorAlias) }}</span>
            <span class="treehole-date">{{ new Date(thread.createdAt).toLocaleString() }}</span>
            <span class="treehole-stat">
              <svg viewBox="0 0 24 24" width="16" height="16">
                <path d="M21 6h-2v9H6v2c0 .55.45 1 1 1h11l4 4V7c0-.55-.45-1-1-1zm-4 6V3c0-.55-.45-1-1-1H3c-.55 0-1 .45-1 1v14l4-4h10c.55 0 1-.45 1-1z"></path>
              </svg>
              {{ thread.replyCount }}
            </span>
            <button
              v-if="isLoggedIn"
              :class="['treehole-favorite-btn', { favorited: thread.isFavorited }]"
              @click.stop="handleToggleFavorite(thread.id, thread.isFavorited)"
              aria-pressed="false"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <!-- filled: use currentColor for fill -->
                <path
                  v-if="thread.isFavorited"
                  d="M17 3H7c-1.1 0-1.99.9-1.99 2L5 21l7-3 7 3V5c0-1.1-.9-2-2-2z"
                  fill="currentColor"
                  stroke="none"
                />
                <!-- outline: no fill, stroked path using currentColor -->
                <path
                  v-else
                  d="M17 3H7c-1.1 0-1.99.9-1.99 2L5 21l7-3 7 3V5c0-1.1-.9-2-2-2z"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linejoin="round"
                  stroke-linecap="round"
                />
              </svg>
              {{ thread.favoriteCount }}
            </button>
            <span v-else class="treehole-stat">
              <svg viewBox="0 0 24 24" width="16" height="16">
                <path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z"></path>
              </svg>
              {{ thread.favoriteCount }}
            </span>
            <button v-if="expandedThreadIds.has(thread.id)" class="treehole-btn treehole-btn-ghost treehole-btn-small" @click.stop="toggleThreadExpand(thread.id)">
              收起
            </button>
          </div>
        </article>

        <p v-if="treeHoleStore.loadingMore" class="treehole-empty">加载更多中...</p>
        <p v-if="!treeHoleStore.loadingList && treeHoleStore.threads.length === 0" class="treehole-empty">暂无帖子</p>
      </div>
    </template>

    <div
      v-if="lightboxOpen"
      class="treehole-lightbox"
      @click="closeLightbox"
    >
      <div class="treehole-lightbox-inner" @click.stop>
        <button class="treehole-lightbox-close" type="button" @click.stop="closeLightbox">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"></path>
          </svg>
        </button>
        <img :src="lightboxImageSrc" alt="放大图片">
      </div>
    </div>
  </section>
</template>

<style scoped>
.treehole-wrap {
  margin-top: 14px;
  display: grid;
  gap: 14px;
}

.treehole-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border: 1px solid color-mix(in srgb, var(--vp-c-brand-1) 20%, var(--vp-c-divider));
  border-radius: 16px;
  background:
    radial-gradient(80% 120% at 0% 0%, color-mix(in srgb, var(--vp-c-brand-1) 16%, transparent), transparent 60%),
    var(--vp-c-bg-soft);
  flex-wrap: nowrap;
  min-height: 52px;
  max-width: 100%;
  overflow: hidden;
}

.treehole-topbar-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 0 0 auto;
  min-width: 0;
}

.treehole-title {
  margin: 0;
  font-size: 20px;
  line-height: 1;
  letter-spacing: 0.02em;
  display: flex;
  align-items: center;
  font-weight: 700;
  color: var(--vp-c-text-1);
  padding-top: 0 !important;
  padding-bottom: 0 !important;
}

.treehole-subtitle {
  color: var(--vp-c-text-2);
  font-size: 13px;
  white-space: nowrap;
  line-height: 1;
  display: flex;
  align-items: center;
}

.treehole-topbar-right {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  flex-wrap: nowrap;
  justify-content: flex-end;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  margin-left: auto;
  width: 100%;
}

.treehole-username-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 6px 14px;
  border-radius: 8px;
  background: transparent;
  border: 1px solid var(--vp-c-divider);
  color: var(--vp-c-text-1);
  font-size: 13px;
  font-weight: 400;
  white-space: nowrap;
  line-height: 1;
  min-height: 28px;
  flex: 0 1 auto;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}

.treehole-auth-inline {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: nowrap;
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  justify-content: flex-end;
  margin-left: auto;
}

.treehole-auth-inline > :not(.treehole-username-badge) {
  flex: 0 0 auto;
}

.treehole-btn,
.treehole-btn-ghost,
.treehole-btn-primary {
  flex: 0 0 auto;
}

.treehole-btn {
  border: 1px solid color-mix(in srgb, var(--vp-c-brand-1) 70%, var(--vp-c-divider));
  color: white;
  background: linear-gradient(135deg, var(--vp-c-brand-1), var(--vp-c-brand-2));
  border-radius: 999px;
  padding: 7px 14px;
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  transition: transform 0.12s ease, box-shadow 0.2s ease, filter 0.2s ease;
  box-shadow: 0 8px 20px color-mix(in srgb, var(--vp-c-brand-1) 20%, transparent);
  white-space: nowrap;
}

.treehole-btn:hover {
  transform: translateY(-1px);
  filter: brightness(1.04);
}

.treehole-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
  transform: none;
  box-shadow: none;
}

.treehole-btn-ghost {
  color: var(--vp-c-text-1);
  background: var(--vp-c-bg);
  border-color: var(--vp-c-divider);
  box-shadow: none;
}

.treehole-btn-small {
  padding: 4px 10px;
  font-size: 12px;
}

.treehole-btn-primary {
  color: white;
  background: linear-gradient(135deg, var(--vp-c-brand-1), var(--vp-c-brand-2));
}

.treehole-alert {
  border: 1px solid color-mix(in srgb, var(--vp-c-brand-1) 40%, var(--vp-c-divider));
  border-radius: 12px;
  padding: 10px 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  background: color-mix(in srgb, var(--vp-c-brand-1) 6%, var(--vp-c-bg));
}

.treehole-alert-error {
  border-color: color-mix(in srgb, #ef4444 55%, var(--vp-c-divider));
  color: #dc2626;
  background: color-mix(in srgb, #ef4444 8%, var(--vp-c-bg));
}

.treehole-page-title-wrapper {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.treehole-tab-group {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.treehole-tab {
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-2);
  border-radius: 999px;
  padding: 6px 12px;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  transition: border-color 0.2s ease, color 0.2s ease, background 0.2s ease;
}

.treehole-tab.active {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
  background: color-mix(in srgb, var(--vp-c-brand-1) 12%, var(--vp-c-bg));
}

.treehole-refresh-btn {
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vp-c-text-2);
  transition: color 0.2s ease;
}

.treehole-refresh-btn:hover {
  color: var(--vp-c-brand-1);
}

.treehole-refresh-spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.treehole-composer {
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  padding: 14px;
  display: grid;
  gap: 12px;
  background: color-mix(in srgb, var(--vp-c-bg-soft) 80%, transparent);
}

.treehole-composer label {
  display: grid;
  gap: 6px;
}

.treehole-composer label span {
  font-size: 13px;
  color: var(--vp-c-text-2);
}

.treehole-composer input,
.treehole-composer textarea {
  width: 100%;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  padding: 9px 11px;
  font-size: 14px;
  background: var(--vp-c-bg-soft);
}

.treehole-image-preview {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.treehole-image-preview-wrapper {
  position: relative;
  display: inline-block;
}

.treehole-image-preview img {
  width: 120px;
  max-width: 100%;
  border-radius: 10px;
  border: 1px solid var(--vp-c-divider);
}

.treehole-image-delete-btn {
  position: absolute;
  top: -6px;
  right: -6px;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: 999px;
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: var(--vp-c-text-2);
  transition: border-color 0.2s ease, color 0.2s ease;
}

.treehole-image-delete-btn:hover {
  color: #ef4444;
  border-color: #ef4444;
}

.upload-hint {
  font-size: 13px;
  color: var(--vp-c-text-2);
  display: inline-block;
  padding: 8px 14px;
  background: var(--vp-c-bg-soft);
  border-radius: 999px;
  border: 1px dashed var(--vp-c-divider);
  text-align: center;
  cursor: pointer;
  transition: border-color 0.2s ease, color 0.2s ease, background 0.2s ease;
}

.upload-hint:hover {
  border-color: color-mix(in srgb, var(--vp-c-brand-1) 40%, var(--vp-c-divider));
  color: var(--vp-c-brand-1);
  background: color-mix(in srgb, var(--vp-c-brand-1) 8%, var(--vp-c-bg-soft));
}

.treehole-list-shell {
  display: grid;
  gap: 10px;
}

.treehole-thread-card {
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  padding: 12px;
  display: grid;
  gap: 10px;
  background: linear-gradient(180deg, var(--vp-c-bg-soft), var(--vp-c-bg));
  transition: border-color 0.2s ease, transform 0.12s ease, box-shadow 0.2s ease;
}

.treehole-thread-card:hover {
  border-color: color-mix(in srgb, var(--vp-c-brand-1) 50%, var(--vp-c-divider));
}

.treehole-thread-card-expanded {
  box-shadow: 0 10px 24px color-mix(in srgb, var(--vp-c-brand-1) 14%, transparent);
}

.treehole-thread-main {
  cursor: pointer;
}

.treehole-thread-main header strong {
  font-size: 15px;
  line-height: 1.45;
}

.treehole-thread-content {
  margin: 8px 0 0;
  color: var(--vp-c-text-2);
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
}

.treehole-thread-content-truncated {
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}

.treehole-click-expand {
  margin-top: 8px;
  font-size: 12px;
  color: var(--vp-c-brand-1);
}

.treehole-thread-footer {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  color: var(--vp-c-text-2);
  font-size: 12px;
}

.treehole-date {
  color: var(--vp-c-text-2);
  font-size: 12px;
}

.treehole-stat {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.treehole-favorite-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 2px;
  color: var(--vp-c-text-2);
  font-size: 12px;
  line-height: 1;
}

.treehole-favorite-btn.favorited {
  color: var(--vp-c-brand-1);
}

.treehole-replies {
  display: grid;
  gap: 10px;
  padding-top: 4px;
}

.treehole-replies h4 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--vp-c-text-1);
}

.treehole-reply {
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  padding: 12px;
  background: var(--vp-c-bg-soft);
  display: grid;
  gap: 8px;
}

.treehole-reply header {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 12px;
  color: var(--vp-c-text-2);
}

.reply-number {
  font-weight: 700;
  color: var(--vp-c-brand-1);
  font-size: 13px;
}

.thread-number {
  color: #6b7280; /* 深灰色 */
}

.author-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 999px;
  color: white;
  font-weight: 700;
  font-size: 11px;
  line-height: 1;
}

.treehole-reply p {
  margin: 0;
  line-height: 1.7;
  font-size: 13px;
}

.treehole-reply-composer {
  margin-top: 4px;
}

.treehole-reply-login-hint {
  display: flex;
  justify-content: flex-start;
}

.treehole-replies-list {
  display: grid;
  gap: 10px;
}

.treehole-reply-card {
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  padding: 12px;
  display: grid;
  gap: 8px;
  background: var(--vp-c-bg);
}

.treehole-reply-card header strong {
  font-size: 14px;
}

.treehole-reply-content {
  margin: 0;
  color: var(--vp-c-text-2);
  line-height: 1.65;
}

.treehole-reply-card footer {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: center;
  color: var(--vp-c-text-2);
  font-size: 12px;
}

.treehole-images {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 8px;
}

.treehole-images img {
  width: 160px;
  max-width: 100%;
  border-radius: 10px;
  border: 1px solid var(--vp-c-divider);
  cursor: zoom-in;
}

.treehole-lightbox {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 999;
  padding: 24px;
}

.treehole-lightbox-inner {
  position: relative;
  max-width: min(920px, 92vw);
  max-height: 88vh;
}

.treehole-lightbox-inner img {
  display: block;
  max-width: 100%;
  max-height: 88vh;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--vp-c-divider) 55%, transparent);
  box-shadow: 0 20px 60px rgba(15, 23, 42, 0.35);
  background: var(--vp-c-bg);
}

.treehole-lightbox-close {
  position: absolute;
  top: -10px;
  right: -10px;
  width: 30px;
  height: 30px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--vp-c-divider) 55%, transparent);
  background: var(--vp-c-bg);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: var(--vp-c-text-1);
}

.treehole-lightbox-close:hover {
  color: #ef4444;
  border-color: #ef4444;
}

.treehole-empty {
  margin: 0;
  color: var(--vp-c-text-2);
  font-size: 13px;
}

@media (max-width: 900px) {
  .treehole-topbar {
    align-items: center;
  }

  .treehole-topbar-left {
    width: auto;
  }

  .treehole-topbar-right {
    width: auto;
  }

  .treehole-auth-inline {
    width: auto;
  }

  .treehole-tab-group {
    gap: 6px;
  }

  .treehole-tab {
    padding: 5px 10px;
    font-size: 12px;
  }
}

@media (max-width: 600px) {
  .treehole-topbar {
    padding: 10px 12px;
    gap: 8px;
  }

  .treehole-topbar-right {
    gap: 8px;
  }

  .treehole-auth-inline {
    gap: 6px;
  }

  .treehole-username-badge {
    padding: 5px 10px;
    font-size: 12px;
  }

  .treehole-btn {
    padding: 6px 10px;
    font-size: 12px;
  }
}

/* Favorite icon: ensure unfavorited state is an outline (hollow) */
.treehole-favorite-btn:not(.favorited) svg path {
  fill: none !important;
  stroke: currentColor !important;
  stroke-width: 1.6px !important;
  stroke-linejoin: round !important;
  stroke-linecap: round !important;
}
.treehole-favorite-btn.favorited svg path {
  fill: currentColor !important;
  stroke: none !important;
}
</style>
