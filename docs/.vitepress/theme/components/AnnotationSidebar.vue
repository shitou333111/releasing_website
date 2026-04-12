<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import { useUserStore } from '../stores/userStore';
import { useAnnotationStore } from '../stores/annotationStore';
import AnnotationItem from './AnnotationItem.vue';

const props = withDefaults(defineProps<{ isMobilePanel?: boolean }>(), {
  isMobilePanel: false
});

const emit = defineEmits<{
  (e: 'requestClosePanel'): void;
}>();

const userStore = useUserStore();
const annotationStore = useAnnotationStore();

const username = ref('');
const password = ref('');
const authBackdropPressed = ref(false);

const isCloudAuth = computed(() => userStore.cloudAuthEnabled);
const showLoginModal = computed({
  get: () => userStore.authModalOpen,
  set: (value: boolean) => {
    if (value) {
      userStore.openAuthModal();
    } else {
      userStore.closeAuthModal();
    }
  }
});

function resetAuthForm() {
  username.value = '';
  password.value = '';
  userStore.clearAuthMessages();
}

function openAuthModal() {
  resetAuthForm();
  userStore.openAuthModal();
}

function closeAuthModal() {
  userStore.closeAuthModal();
  resetAuthForm();
}

function startAuthBackdropClose() {
  authBackdropPressed.value = true;
}

function cancelAuthBackdropClose() {
  authBackdropPressed.value = false;
}

function maybeCloseAuthModal() {
  if (authBackdropPressed.value) {
    closeAuthModal();
  }

  authBackdropPressed.value = false;
}

async function handleLogin() {
  if (!isCloudAuth.value) {
    userStore.setAuthError('当前仅支持 Supabase 云端模式，请先配置环境变量');
    return;
  }

  if (!username.value.trim() || !password.value.trim()) return;

  const ok = await userStore.signInOrRegisterWithUsername(
    username.value.trim(),
    password.value
  );

  if (ok) {
    closeAuthModal();
  }
}

async function handleLogout() {
  await userStore.logout();
}

const uniqueUsers = computed(() => {
  const users = new Map();
  const currentPath = annotationStore.currentPagePath;
  const currentUserId = userStore.currentUser?.id;
  
  for (const anno of annotationStore.annotations) {
    if (anno.pagePath !== currentPath) continue;
    if (anno.privacy !== 'public' && anno.creator.id !== currentUserId) continue;
    
    if (!users.has(anno.creator.id)) {
      users.set(anno.creator.id, anno.creator);
    }
  }
  return Array.from(users.values());
});

const isAllFilterActive = computed(() => !annotationStore.filterUser);
const isMineFilterActive = computed(() => {
  if (!userStore.currentUser) return false;
  return annotationStore.filterUser === userStore.currentUser.id;
});
const selectedCustomUser = computed(() => {
  if (!annotationStore.filterUser) return '';
  if (annotationStore.filterUser === userStore.currentUser?.id) return '';
  return annotationStore.filterUser;
});
const isCustomFilterActive = computed(() => {
  if (!annotationStore.filterUser) return false;
  if (annotationStore.filterUser === userStore.currentUser?.id) return false;
  return true;
});
const selectableUsers = computed(() => {
  const me = userStore.currentUser?.id;
  return uniqueUsers.value.filter(user => user.id !== me);
});

function setFilterAll() {
  annotationStore.setFilterUser(null);
}

function setFilterMine() {
  if (!userStore.currentUser) {
    userStore.setAuthError('请先注册/登录后使用“自己”筛选');
    userStore.openAuthModal();
    return;
  }

  annotationStore.setFilterUser(userStore.currentUser.id);
}

function handleCustomUserFilter(value: string) {
  annotationStore.setFilterUser(value || null);
}

function requestClosePanel() {
  emit('requestClosePanel');
}

watch(() => annotationStore.selectedAnnotationId, async (selectedId) => {
  if (!selectedId) return;

  await nextTick();
  const selectedItem = document.querySelector(
    `.annotation-item[data-annotation-id="${selectedId}"]`
  ) as HTMLElement | null;

  selectedItem?.scrollIntoView({
    behavior: 'smooth',
    block: 'nearest'
  });
});
</script>

<template>
  <div class="annotation-sidebar">
    <div class="user-section">
      <div class="user-info">
        <span class="current-user-label">当前用户</span>
        <span class="current-user-name">{{ userStore.currentUser?.name || '未登录' }}</span>
      </div>
      <button v-if="!userStore.isLoggedIn" class="login-btn" @click="openAuthModal">
        注册/登录
      </button>
      <button v-else class="login-btn logout-btn" @click="handleLogout">
        退出
      </button>
    </div>

    <div class="annotation-heading-row">
      <div class="annotation-heading-title">笔记 ({{ annotationStore.filteredAnnotations.length }})</div>
      <div class="filter-user-group">
        <button
          class="filter-chip"
          :class="{ active: isMineFilterActive }"
          @click="setFilterMine"
        >
          自己
        </button>
        <button
          class="filter-chip"
          :class="{ active: isAllFilterActive }"
          @click="setFilterAll"
        >
          全部
        </button>
        <div class="filter-user-select-wrap" :class="{ active: isCustomFilterActive }">
          <select
            class="filter-chip filter-user-select"
            :class="{ active: isCustomFilterActive }"
            :value="selectedCustomUser"
            @change="handleCustomUserFilter($event.target.value)"
          >
            <option value="">选择</option>
            <option
              v-for="user in selectableUsers"
              :key="user.id"
              :value="user.id"
            >
              {{ user.name }}
            </option>
          </select>
          <span class="filter-user-caret" aria-hidden="true">⌵</span>
        </div>
        <button
          v-if="props.isMobilePanel"
          class="filter-chip note-panel-close-btn"
          @click="requestClosePanel"
        >
          收起
        </button>
      </div>
    </div>

    <div class="annotation-list">
      <AnnotationItem 
        v-for="annotation in annotationStore.filteredAnnotations" 
        :key="annotation.id" 
        :annotation="annotation"
      />
      <div v-if="annotationStore.filteredAnnotations.length === 0" style="text-align: center; color: var(--vp-c-text-2); padding: 24px; font-size: 13px;">
        暂无标注，选中文本开始添加吧！
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="showLoginModal"
        class="create-annotation-modal auth-modal"
        @mousedown.self="startAuthBackdropClose"
        @mouseup.self="maybeCloseAuthModal"
      >
        <div class="create-annotation-content auth-dialog" @mousedown.stop="cancelAuthBackdropClose" @mouseup.stop="cancelAuthBackdropClose">
          <div class="auth-header">
            <h3 class="auth-title">输入用户名和密码</h3>
            <p class="auth-subtitle">用户名不存在会自动注册并登录，已存在则直接登录。</p>
          </div>

          <div class="auth-form">
            <label class="auth-field" for="auth-username-input">
              <span class="auth-label">用户名</span>
              <input
                id="auth-username-input"
                v-model="username"
                type="text"
                maxlength="10"
                placeholder="支持汉字，最多 10 个字符"
                class="auth-input"
                @keyup.enter="handleLogin"
              >
            </label>

            <label class="auth-field" for="auth-password-input">
              <span class="auth-label">密码</span>
              <input
                id="auth-password-input"
                v-model="password"
                type="password"
                placeholder="请输入密码"
                class="auth-input"
                @keyup.enter="handleLogin"
              >
            </label>
          </div>

          <div v-if="userStore.authError" class="auth-feedback auth-error">
            {{ userStore.authError }}
          </div>
          <div v-if="userStore.authNotice" class="auth-feedback auth-notice">
            {{ userStore.authNotice }}
          </div>

          <div class="modal-actions auth-actions">
            <button class="modal-btn cancel auth-btn auth-btn-ghost" @click="closeAuthModal">取消</button>
            <button class="modal-btn submit auth-btn auth-btn-primary" @click="handleLogin" :disabled="userStore.authLoading || !isCloudAuth">
              {{ userStore.authLoading ? '处理中...' : '注册/登录' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
