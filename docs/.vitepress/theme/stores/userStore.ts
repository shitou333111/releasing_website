import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { User } from '../utils/types';
import { ensureCloudProfile, getCloudProfileByName } from '../utils/cloudStorage';
import { isSupabaseConfigured, supabase } from '../utils/supabase';

export const useUserStore = defineStore('user', () => {
  const currentUser = ref<User | null>(null);
  const authLoading = ref(false);
  const authError = ref('');
  const authNotice = ref('');
  const authModalOpen = ref(false);
  const SUPABASE_REQUIRED_MESSAGE = '当前仅支持 Supabase 云端模式，请先配置环境变量';

  const isLoggedIn = computed(() => currentUser.value !== null && currentUser.value.authProvider === 'supabase');
  const isAnonymous = computed(() => !isLoggedIn.value);
  const cloudAuthEnabled = computed(() => isSupabaseConfigured && !!supabase);
  const isCloudAuthenticated = computed(() => cloudAuthEnabled.value && isLoggedIn.value);

  function clearAuthMessages() {
    authError.value = '';
    authNotice.value = '';
  }

  function openAuthModal() {
    authModalOpen.value = true;
  }

  function closeAuthModal() {
    authModalOpen.value = false;
  }

  function setAuthError(message: string) {
    authError.value = message;
    authNotice.value = '';
  }

  async function initUser() {
    clearAuthMessages();

    if (!cloudAuthEnabled.value || !supabase) {
      currentUser.value = null;
      setAuthError(SUPABASE_REQUIRED_MESSAGE);
      return;
    }

    authLoading.value = true;
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;

      const authUser = data.session?.user;
      if (authUser) {
        const user = await ensureCloudProfile(authUser);
        currentUser.value = user;
      } else {
        currentUser.value = null;
      }
    } catch (error: any) {
      console.error('Failed to initialize user session:', error);
      setAuthError(error?.message || '初始化云端会话失败');
      currentUser.value = null;
    } finally {
      authLoading.value = false;
    }
  }

  function toUtf8Bytes(input: string): Uint8Array {
    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(input);
    }

    const encoded = unescape(encodeURIComponent(input));
    const bytes = new Uint8Array(encoded.length);
    for (let i = 0; i < encoded.length; i += 1) {
      bytes[i] = encoded.charCodeAt(i);
    }

    return bytes;
  }

  function rotr(value: number, bits: number): number {
    return (value >>> bits) | (value << (32 - bits));
  }

  function sha256HexFallback(input: string): string {
    const initialHash = new Uint32Array([
      0x6a09e667,
      0xbb67ae85,
      0x3c6ef372,
      0xa54ff53a,
      0x510e527f,
      0x9b05688c,
      0x1f83d9ab,
      0x5be0cd19
    ]);

    const k = new Uint32Array([
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
      0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
      0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
      0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
      0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
      0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
      0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
      0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
      0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ]);

    const message = toUtf8Bytes(input);
    const bitLength = message.length * 8;
    const paddedLength = ((message.length + 9 + 63) >> 6) << 6;
    const padded = new Uint8Array(paddedLength);
    padded.set(message);
    padded[message.length] = 0x80;

    const bitLengthHi = Math.floor(bitLength / 0x100000000);
    const bitLengthLo = bitLength >>> 0;
    padded[paddedLength - 8] = (bitLengthHi >>> 24) & 0xff;
    padded[paddedLength - 7] = (bitLengthHi >>> 16) & 0xff;
    padded[paddedLength - 6] = (bitLengthHi >>> 8) & 0xff;
    padded[paddedLength - 5] = bitLengthHi & 0xff;
    padded[paddedLength - 4] = (bitLengthLo >>> 24) & 0xff;
    padded[paddedLength - 3] = (bitLengthLo >>> 16) & 0xff;
    padded[paddedLength - 2] = (bitLengthLo >>> 8) & 0xff;
    padded[paddedLength - 1] = bitLengthLo & 0xff;

    const w = new Uint32Array(64);
    for (let offset = 0; offset < padded.length; offset += 64) {
      for (let i = 0; i < 16; i += 1) {
        const index = offset + i * 4;
        w[i] = (
          (padded[index] << 24)
          | (padded[index + 1] << 16)
          | (padded[index + 2] << 8)
          | padded[index + 3]
        ) >>> 0;
      }

      for (let i = 16; i < 64; i += 1) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }

      let a = initialHash[0];
      let b = initialHash[1];
      let c = initialHash[2];
      let d = initialHash[3];
      let e = initialHash[4];
      let f = initialHash[5];
      let g = initialHash[6];
      let h = initialHash[7];

      for (let i = 0; i < 64; i += 1) {
        const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const temp1 = (h + s1 + ch + k[i] + w[i]) >>> 0;
        const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (s0 + maj) >>> 0;

        h = g;
        g = f;
        f = e;
        e = (d + temp1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (temp1 + temp2) >>> 0;
      }

      initialHash[0] = (initialHash[0] + a) >>> 0;
      initialHash[1] = (initialHash[1] + b) >>> 0;
      initialHash[2] = (initialHash[2] + c) >>> 0;
      initialHash[3] = (initialHash[3] + d) >>> 0;
      initialHash[4] = (initialHash[4] + e) >>> 0;
      initialHash[5] = (initialHash[5] + f) >>> 0;
      initialHash[6] = (initialHash[6] + g) >>> 0;
      initialHash[7] = (initialHash[7] + h) >>> 0;
    }

    return Array.from(initialHash)
      .map((value) => value.toString(16).padStart(8, '0'))
      .join('');
  }

  async function sha256Hex(input: string): Promise<string> {
    const hasWebCrypto = typeof globalThis !== 'undefined'
      && typeof globalThis.crypto !== 'undefined'
      && typeof globalThis.crypto.subtle !== 'undefined';

    if (hasWebCrypto) {
      try {
        const bytes = toUtf8Bytes(input);
        const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest))
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
      } catch {
        // Fall through to pure JS SHA-256.
      }
    }

    return sha256HexFallback(input);
  }

  async function buildSyntheticEmailFromUsername(username: string): Promise<string> {
    const normalized = username.trim();
    const hex = await sha256Hex(normalized);

    return `u${hex.slice(0, 30)}@releasing.local`;
  }

  function validateUsernameAndPassword(username: string, password: string): string | null {
    const trimmedUsername = username.trim();
    const usernameLength = Array.from(trimmedUsername).length;

    if (!trimmedUsername) {
      return '请输入用户名';
    }

    if (usernameLength > 10) {
      return '用户名最多 10 个字符';
    }

    if (!password) {
      return '请输入密码';
    }

    return null;
  }

  function normalizePasswordForAuth(password: string): string {
    if (password.length >= 6) {
      return password;
    }

    return `${password}__r6compat__`;
  }

  async function signInOrRegisterWithUsername(username: string, password: string) {
    clearAuthMessages();

    if (!supabase || !cloudAuthEnabled.value) {
      setAuthError(SUPABASE_REQUIRED_MESSAGE);
      return false;
    }

    const validationError = validateUsernameAndPassword(username, password);
    if (validationError) {
      authError.value = validationError;
      return false;
    }

    const trimmedUsername = username.trim();
    const normalizedPassword = normalizePasswordForAuth(password);
    authLoading.value = true;

    try {
      const existingProfile = await getCloudProfileByName(trimmedUsername);
      const syntheticEmail = await buildSyntheticEmailFromUsername(trimmedUsername);

      if (existingProfile) {
        const { data, error } = await supabase.auth.signInWithPassword({
          email: syntheticEmail,
          password: normalizedPassword
        });

        if (error || !data.user) {
          throw new Error('用户名已存在，但密码不正确');
        }

        const user = await ensureCloudProfile(data.user, trimmedUsername);
        currentUser.value = user;
        authNotice.value = '登录成功';
        return true;
      }

      const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
        email: syntheticEmail,
        password: normalizedPassword,
        options: {
          data: {
            name: trimmedUsername
          }
        }
      });

      if (signUpError) {
        throw signUpError;
      }

      let authUser = signUpData.user;

      if (!signUpData.session) {
        const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
          email: syntheticEmail,
          password: normalizedPassword
        });

        if (signInError || !signInData.user) {
          throw new Error('注册成功，但自动登录失败，请重试');
        }

        authUser = signInData.user;
      }

      if (!authUser) {
        throw new Error('注册失败，未获取到用户信息');
      }

      const user = await ensureCloudProfile(authUser, trimmedUsername);
      currentUser.value = user;
      authNotice.value = '注册并登录成功';

      return true;
    } catch (error: any) {
      authError.value = error?.message || '注册/登录失败';
      return false;
    } finally {
      authLoading.value = false;
    }
  }

  async function logout() {
    clearAuthMessages();

    if (cloudAuthEnabled.value && supabase) {
      try {
        const { error } = await supabase.auth.signOut();
        if (error) {
          console.error('Supabase sign out failed:', error.message);
        }
      } catch (error) {
        console.error('Supabase sign out exception:', error);
      }
    }

    currentUser.value = null;
  }

  function updateUser(updates: Partial<User>) {
    if (currentUser.value) {
      currentUser.value = {
        ...currentUser.value,
        ...updates,
        isAnonymous: false,
        authProvider: 'supabase'
      };
    }
  }

  return {
    currentUser,
    isLoggedIn,
    isAnonymous,
    cloudAuthEnabled,
    isCloudAuthenticated,
    authLoading,
    authError,
    authNotice,
    authModalOpen,
    initUser,
    signInOrRegisterWithUsername,
    logout,
    updateUser,
    clearAuthMessages,
    setAuthError,
    openAuthModal,
    closeAuthModal
  };
});
