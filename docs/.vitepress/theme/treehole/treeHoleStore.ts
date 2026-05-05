import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  createTreeHoleReply,
  createTreeHoleThread,
  fetchReceivedReplies,
  fetchTreeHoleThreadIdByNo,
  fetchTreeHoleThreadDetail,
  fetchTreeHoleThreads,
  setThreadFavorite
} from './treeholeApi';
import type {
  CreateTreeHoleReplyInput,
  CreateTreeHoleThreadInput,
  TreeHoleReceivedReply,
  TreeHoleThreadCard,
  TreeHoleThreadDetail,
  TreeHoleView
} from './treeholeTypes';

export const useTreeHoleStore = defineStore('treehole', () => {
  const threads = ref<TreeHoleThreadCard[]>([]);
  const selectedThread = ref<TreeHoleThreadDetail | null>(null);
  const threadDetails = ref<Map<string, TreeHoleThreadDetail>>(new Map());
  const receivedReplies = ref<TreeHoleReceivedReply[]>([]);
  const loadingList = ref(false);
  const loadingMore = ref(false);
  const loadingDetail = ref(false);
  const creatingThread = ref(false);
  const creatingReply = ref(false);
  const error = ref('');
  const currentView = ref<TreeHoleView>('all');
  const currentOffset = ref(0);
  const hasMore = ref(true);
  const isRefreshing = ref(false);
  const scrollPositions = ref<Map<string, number>>(new Map());
  const PAGE_SIZE = 10;

  const selectedThreadId = computed(() => selectedThread.value?.thread.id || null);

  function clearError() {
    error.value = '';
  }

  function setError(message: string) {
    error.value = message;
  }

  async function loadView(view: TreeHoleView, userId: string | null) {
    currentView.value = view;
    selectedThread.value = null;
    currentOffset.value = 0;
    hasMore.value = true;
    clearError();

    if (view === 'replies') {
      if (!userId) {
        receivedReplies.value = [];
        threads.value = [];
        setError('请先登录后查看收到的回复');
        return;
      }

      loadingList.value = true;
      try {
        receivedReplies.value = await fetchReceivedReplies(userId);
        threads.value = [];
      } catch (err: any) {
        setError(err?.message || '加载收到的回复失败');
      } finally {
        loadingList.value = false;
      }

      return;
    }

    if ((view === 'mine' || view === 'favorites') && !userId) {
      threads.value = [];
      setError('请先登录后查看该页面内容');
      return;
    }

    loadingList.value = true;
    try {
      const newThreads = await fetchTreeHoleThreads(view, userId, PAGE_SIZE, 0);
      threads.value = newThreads;
      hasMore.value = newThreads.length === PAGE_SIZE;
      receivedReplies.value = [];
    } catch (err: any) {
      setError(err?.message || '加载帖子失败');
    } finally {
      loadingList.value = false;
    }
  }

  async function loadMore(userId: string | null) {
    if (loadingMore.value || !hasMore.value || currentView.value === 'replies') {
      return;
    }

    loadingMore.value = true;
    clearError();

    try {
      const newOffset = currentOffset.value + PAGE_SIZE;
      const newThreads = await fetchTreeHoleThreads(currentView.value, userId, PAGE_SIZE, newOffset);
      
      if (newThreads.length > 0) {
        threads.value = [...threads.value, ...newThreads];
        currentOffset.value = newOffset;
        hasMore.value = newThreads.length === PAGE_SIZE;
      } else {
        hasMore.value = false;
      }
    } catch (err: any) {
      setError(err?.message || '加载更多帖子失败');
    } finally {
      loadingMore.value = false;
    }
  }

  async function refresh(userId: string | null) {
    isRefreshing.value = true;
    clearError();

    try {
      await loadView(currentView.value, userId);
    } catch (err: any) {
      setError(err?.message || '刷新失败');
    } finally {
      isRefreshing.value = false;
    }
  }

  function saveScrollPosition(view: string) {
    scrollPositions.value.set(view, window.scrollY);
  }

  function getScrollPosition(view: string): number {
    return scrollPositions.value.get(view) || 0;
  }

  async function openThread(threadId: string, userId: string | null) {
    clearError();
    loadingDetail.value = true;

    try {
      const detail = await fetchTreeHoleThreadDetail(threadId, userId);
      selectedThread.value = detail;
      threadDetails.value.set(threadId, detail);
    } catch (err: any) {
      setError(err?.message || '加载帖子详情失败');
    } finally {
      loadingDetail.value = false;
    }
  }

  async function loadThreadDetail(threadId: string, userId: string | null) {
    if (threadDetails.value.has(threadId)) {
      return;
    }

    clearError();
    try {
      const detail = await fetchTreeHoleThreadDetail(threadId, userId);
      threadDetails.value.set(threadId, detail);
    } catch (err: any) {
      setError(err?.message || '加载帖子详情失败');
    }
  }

  async function openThreadByNo(threadNo: string, userId: string | null) {
    const normalized = threadNo.trim();
    if (!normalized) {
      selectedThread.value = null;
      return;
    }

    const threadId = await fetchTreeHoleThreadIdByNo(normalized);
    if (!threadId) {
      selectedThread.value = null;
      return;
    }

    await openThread(threadId, userId);
  }

  async function refreshSelectedThread(userId: string | null) {
    const threadId = selectedThreadId.value;
    if (!threadId) return;

    await openThread(threadId, userId);
  }

  async function submitThread(input: CreateTreeHoleThreadInput, userId: string) {
    creatingThread.value = true;
    clearError();

    try {
      const threadId = await createTreeHoleThread(input, userId);
      await loadView(currentView.value === 'all' ? 'all' : currentView.value, userId);
      await openThread(threadId, userId);
    } catch (err: any) {
      setError(err?.message || '发帖失败');
      throw err;
    } finally {
      creatingThread.value = false;
    }
  }

  async function submitReply(input: CreateTreeHoleReplyInput, userId: string) {
    creatingReply.value = true;
    clearError();

    try {
      await createTreeHoleReply(input, userId);
      await refreshSelectedThread(userId);
      // 更新 threadDetails
      const threadId = input.threadId;
      if (threadId) {
        const detail = await fetchTreeHoleThreadDetail(threadId, userId);
        threadDetails.value.set(threadId, detail);
      }
      await loadView(currentView.value, userId);
    } catch (err: any) {
      setError(err?.message || '发送回复失败');
      throw err;
    } finally {
      creatingReply.value = false;
    }
  }

  async function toggleFavorite(threadId: string, currentFavorited: boolean, userId: string) {
    clearError();

    try {
      await setThreadFavorite(threadId, userId, !currentFavorited);
      // 先更新列表中的 isFavorited 状态
      threads.value = threads.value.map(thread => 
        thread.id === threadId ? { ...thread, isFavorited: !currentFavorited, favoriteCount: currentFavorited ? thread.favoriteCount - 1 : thread.favoriteCount + 1 } : thread
      );
      // 然后更新详情页中的状态
      if (selectedThread.value && selectedThread.value.thread.id === threadId) {
        selectedThread.value = {
          ...selectedThread.value,
          thread: {
            ...selectedThread.value.thread,
            isFavorited: !currentFavorited,
            favoriteCount: currentFavorited ? selectedThread.value.thread.favoriteCount - 1 : selectedThread.value.thread.favoriteCount + 1
          }
        };
      }
      // 最后更新 threadDetails
      if (threadDetails.value.has(threadId)) {
        const detail = threadDetails.value.get(threadId)!;
        threadDetails.value.set(threadId, {
          ...detail,
          thread: {
            ...detail.thread,
            isFavorited: !currentFavorited,
            favoriteCount: currentFavorited ? detail.thread.favoriteCount - 1 : detail.thread.favoriteCount + 1
          }
        });
      }
    } catch (err: any) {
      setError(err?.message || '收藏操作失败');
      throw err;
    }
  }

  function clearSelectedThread() {
    selectedThread.value = null;
  }

  return {
    threads,
    selectedThread,
    selectedThreadId,
    threadDetails,
    receivedReplies,
    loadingList,
    loadingMore,
    loadingDetail,
    creatingThread,
    creatingReply,
    error,
    currentView,
    hasMore,
    isRefreshing,
    PAGE_SIZE,
    loadView,
    openThread,
    openThreadByNo,
    loadThreadDetail,
    loadMore,
    refresh,
    saveScrollPosition,
    getScrollPosition,
    refreshSelectedThread,
    submitThread,
    submitReply,
    toggleFavorite,
    clearSelectedThread,
    clearError,
    setError
  };
});
