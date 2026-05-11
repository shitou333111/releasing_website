<script setup lang="ts">
import { ref } from 'vue';
import { useUserStore } from '../stores/userStore';

const userStore = useUserStore();
const username = ref('');
const password = ref('');
const submitting = ref(false);

async function handleSubmit() {
  if (submitting.value) return;
  submitting.value = true;
  try {
    const success = await userStore.signInOrRegisterWithUsername(username.value, password.value);
    if (success) {
      userStore.closeAuthModal();
      username.value = '';
      password.value = '';
    }
  } finally {
    submitting.value = false;
  }
}

function handleClose() {
  userStore.closeAuthModal();
  username.value = '';
  password.value = '';
}
</script>

<template>
  <Teleport to="body">
    <div v-if="userStore.authModalOpen" class="auth-modal-overlay" @click.self="handleClose">
      <div class="auth-modal">
      <div class="auth-modal-header">
        <div class="auth-modal-title-group">
          <h3>注册/登录</h3>
          <span class="auth-modal-hint">用户不存在会自动注册</span>
        </div>
        <button class="auth-modal-close" @click="handleClose">×</button>
      </div>
      <div class="auth-modal-body">
        <div v-if="userStore.authError" class="auth-error">{{ userStore.authError }}</div>
        <div v-if="userStore.authNotice" class="auth-notice">{{ userStore.authNotice }}</div>
        <form class="auth-form" @submit.prevent="handleSubmit">
          <label class="auth-label">
            用户名
            <input 
              type="text" 
              v-model="username" 
              placeholder="输入用户名（最多10个字符）"
              maxlength="10"
              autocomplete="username"
            />
          </label>
          <label class="auth-label">
            密码
            <input 
              type="password" 
              v-model="password" 
              placeholder="输入密码"
              autocomplete="current-password"
            />
          </label>
          <button 
            class="auth-submit" 
            type="submit"
            :disabled="submitting" 
          >
            {{ submitting ? '处理中...' : '注册/登录' }}
          </button>
        </form>
      </div>
    </div>
  </div>
  </Teleport>
</template>

<style scoped>
.auth-modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.auth-modal {
  background: var(--vp-c-bg);
  border-radius: 12px;
  padding: 24px;
  width: 90%;
  max-width: 400px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.1);
}

.auth-modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.auth-modal-title-group {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.auth-modal-header h3 {
  margin: 0;
  font-size: 20px;
}

.auth-modal-hint {
  font-size: 12px;
  color: var(--vp-c-text-2);
  white-space: nowrap;
}

.auth-modal-close {
  background: transparent;
  border: none;
  font-size: 24px;
  cursor: pointer;
  color: var(--vp-c-text-2);
  padding: 4px 8px;
}

.auth-modal-close:hover {
  color: var(--vp-c-text-1);
}

.auth-error {
  padding: 12px;
  border: 1px solid #f56a6a;
  background: #fff5f5;
  color: #dc2626;
  border-radius: 8px;
  margin-bottom: 16px;
}

.auth-notice {
  padding: 12px;
  border: 1px solid #3d9970;
  background: #f0fdf4;
  color: #15803d;
  border-radius: 8px;
  margin-bottom: 16px;
}

.auth-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.auth-label {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 14px;
  color: var(--vp-c-text-1);
}

.auth-label input {
  padding: 10px 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  font-size: 14px;
  background: var(--vp-c-bg-soft);
}

.auth-submit {
  padding: 12px;
  background: linear-gradient(135deg, var(--vp-c-brand-1), var(--vp-c-brand-2));
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  cursor: pointer;
}

.auth-submit:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

</style>
