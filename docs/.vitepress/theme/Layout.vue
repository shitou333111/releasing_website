<script setup lang="ts">
import DefaultTheme from 'vitepress/theme';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useData, useRoute } from 'vitepress';
import { useUserStore } from './stores/userStore';
import { useAnnotationStore } from './stores/annotationStore';
import AnnotationSidebar from './components/AnnotationSidebar.vue';
import TextAnnotator from './components/TextAnnotator.vue';
import PDFOutlineAside from './components/PDFOutlineAside.vue';
import { useAnnotationConfig } from './composables/useAnnotationConfig';
import './custom.css';

const { Layout } = DefaultTheme;
const route = useRoute();
const { frontmatter } = useData();

const userStore = useUserStore();
const annotationStore = useAnnotationStore();
const { isEnabledForCurrentPage } = useAnnotationConfig();
const activeAsideTab = ref<'outline' | 'annotations'>('outline');
const pageNotesEnabledOverride = ref<boolean | null>(null);
const isMobileViewport = ref(false);
const isMobileChapterPanelOpen = ref(false);
const mobileLocalNavContainerTarget = ref<HTMLElement | null>(null);
const mobileLocalNavPanelTarget = ref<HTMLElement | null>(null);
const PDF_OUTLINE_JUMP_EVENT = 'pdf-outline-jump';
let localNavObserver: MutationObserver | null = null;
let mobileViewportSyncRaf = 0;
let iosCalloutClassApplied = false;

const cloudStatusState = computed<'is-ok' | 'is-warn' | 'is-fail'>(() => {
  if (!userStore.cloudAuthEnabled) {
    return 'is-fail';
  }

  if (!userStore.isLoggedIn) {
    return 'is-warn';
  }

  return 'is-ok';
});

const cloudStatusClass = computed(() => cloudStatusState.value);
const cloudStatusTooltip = computed(() => {
  if (cloudStatusState.value === 'is-warn') {
    return '需要注册/登陆才能使用笔记功能';
  }

  const baseText = cloudStatusState.value === 'is-ok'
    ? 'Supabase 数据库已连接，笔记可存储'
    : 'Supabase 数据库连接失败，笔记功能失效';

  const detail = userStore.authError?.trim();
  return detail ? `${baseText}\n错误详情：${detail}` : baseText;
});

type PDFOutlineItem = {
  title: string;
  page: number;
  level: number;
};

function clampOutlineLevel(level: number): number {
  if (!Number.isFinite(level)) {
    return 1;
  }

  return Math.min(4, Math.max(1, Math.round(level)));
}

function parseInlinePDFOutlineItem(input: string): PDFOutlineItem | null {
  const raw = input.trim();
  if (!raw) {
    return null;
  }

  const quotedMatch = raw.match(/^["“](.+?)["”]\s+(\d+)(?:\s+(\d+))?$/);
  const plainMatch = raw.match(/^(.+?)\s+(\d+)(?:\s+(\d+))?$/);
  const matched = quotedMatch ?? plainMatch;

  if (!matched) {
    return null;
  }

  const title = matched[1]?.trim();
  const page = Number(matched[2]);
  const level = Number(matched[3] ?? 1);

  if (!title || !Number.isFinite(page) || page <= 0) {
    return null;
  }

  return {
    title,
    page,
    level: clampOutlineLevel(level)
  };
}

function normalizePDFOutlineItems(input: unknown): PDFOutlineItem[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.reduce<PDFOutlineItem[]>((list, item) => {
    if (typeof item === 'string') {
      const parsed = parseInlinePDFOutlineItem(item);
      if (parsed) {
        list.push(parsed);
      }

      return list;
    }

    if (!item || typeof item !== 'object') {
      return list;
    }

    const record = item as Record<string, unknown>;
    const page = Number(record.page ?? record.pageNumber ?? record.p ?? 0);
    if (!Number.isFinite(page) || page <= 0) {
      return list;
    }

    const titleRaw = typeof record.title === 'string' ? record.title.trim() : '';
    const levelRaw = Number(record.level ?? 1);

    list.push({
      title: titleRaw || `第 ${page} 页`,
      page,
      level: clampOutlineLevel(levelRaw)
    });

    return list;
  }, []);
}

const customPDFOutlineItems = computed(() => normalizePDFOutlineItems(frontmatter.value?.pdfOutline));
const customPDFOutlineViewerId = computed(() => {
  const raw = frontmatter.value?.pdfViewerId;
  return typeof raw === 'string' ? raw.trim() : '';
});
const isCustomPDFOutlineEnabled = computed(() => {
  return frontmatter.value?.outline === false && customPDFOutlineItems.value.length > 0;
});

function parseFrontmatterNoteEnabled(input: unknown): boolean {
  if (input === true) {
    return true;
  }

  if (typeof input === 'string') {
    return input.trim().toLowerCase() === 'true';
  }

  return false;
}

const isPageNotesEnabledByFrontmatter = computed(() => {
  return parseFrontmatterNoteEnabled(frontmatter.value?.notesEnabled);
});

const canShowNotesControls = computed(() => isEnabledForCurrentPage.value);

const isPageNotesEnabled = computed(() => {
  if (!isEnabledForCurrentPage.value) {
    return false;
  }

  return pageNotesEnabledOverride.value ?? isPageNotesEnabledByFrontmatter.value;
});

const noteToggleTooltip = computed(() => {
  return isPageNotesEnabled.value ? '点击关闭笔记功能' : '点击开启笔记功能';
});

const noteIndicatorTooltip = computed(() => {
  if (!isPageNotesEnabled.value) {
    return '笔记功能已关闭';
  }

  const prefix = cloudStatusState.value === 'is-ok'
    ? '绿灯：'
    : cloudStatusState.value === 'is-warn'
      ? '黄灯：'
      : '红灯：';

  return `${prefix}${cloudStatusTooltip.value}`;
});

const effectiveNoteDotClass = computed(() => {
  return isPageNotesEnabled.value ? cloudStatusClass.value : 'is-off';
});

function togglePageNotesEnabled() {
  if (!isEnabledForCurrentPage.value) {
    return;
  }

  const next = !isPageNotesEnabled.value;
  pageNotesEnabledOverride.value = next;

  if (!next) {
    annotationStore.selectAnnotation(null);
    handleMobileNotesClose();
    closeMobileChapterPanelIfOpen();
  }
}

function isIOSDevice(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false;
  }

  const userAgent = navigator.userAgent || '';
  return /iP(hone|od|ad)/.test(userAgent)
    || (userAgent.includes('Mac') && navigator.maxTouchPoints > 1);
}

function getMobileLocalNavDropdown(): HTMLElement | null {
  return (mobileLocalNavPanelTarget.value?.querySelector('.VPLocalNavOutlineDropdown') as HTMLElement | null)
    || document.querySelector('.VPLocalNavOutlineDropdown') as HTMLElement | null;
}

function getMobileChapterToggleButton(): HTMLButtonElement | null {
  const dropdown = getMobileLocalNavDropdown();
  if (!dropdown) return null;

  return Array.from(dropdown.children).find(
    (child) => child instanceof HTMLButtonElement
  ) as HTMLButtonElement | null;
}

function closeMobileChapterPanelIfOpen() {
  const chapterToggle = getMobileChapterToggleButton();

  if (!chapterToggle) {
    isMobileChapterPanelOpen.value = false;
    return;
  }

  if (isCustomPDFOutlineEnabled.value) {
    if (!isMobileChapterPanelOpen.value) return;

    isMobileChapterPanelOpen.value = false;
    chapterToggle.classList.remove('open');
    return;
  }

  if (chapterToggle?.classList.contains('open')) {
    chapterToggle.click();
  }
}

function syncMobileChapterToggleState() {
  if (!isMobileViewport.value || !isCustomPDFOutlineEnabled.value) {
    return;
  }

  const chapterToggle = getMobileChapterToggleButton();
  const fallbackChapterToggle = (mobileLocalNavContainerTarget.value?.querySelector('.VPLocalNav .menu') as HTMLElement | null)
    || document.querySelector('.VPLocalNav .menu') as HTMLElement | null;
  const chapterToggleElement = (chapterToggle as HTMLElement | null) || fallbackChapterToggle;

  if (!chapterToggleElement) {
    return;
  }

  const textNode = chapterToggleElement.querySelector('.menu-text') as HTMLElement | null;
  if (textNode) {
    if (textNode.textContent !== '章节') {
      textNode.textContent = '章节';
    }
  } else {
    const plainTextNode = Array.from(chapterToggleElement.childNodes).find(
      (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()
    );

    if (plainTextNode) {
      plainTextNode.textContent = '章节';
    }
  }

  chapterToggleElement.setAttribute('aria-label', '章节');

  if (chapterToggle) {
    chapterToggle.classList.toggle('open', isMobileChapterPanelOpen.value);
  }
}

function handleMobileChapterToggleClick(event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();

  activeAsideTab.value = 'outline';

  if (!isMobileViewport.value || !isCustomPDFOutlineEnabled.value) {
    return;
  }

  isMobileChapterPanelOpen.value = !isMobileChapterPanelOpen.value;
  syncMobileChapterToggleState();
  
  return false;
}

function syncMobileViewportState() {
  isMobileViewport.value = window.innerWidth < 960;
  mobileLocalNavContainerTarget.value = document.querySelector('.VPLocalNav .container') as HTMLElement | null;
  mobileLocalNavPanelTarget.value = document.querySelector('.VPLocalNav') as HTMLElement | null;

  if (!isMobileViewport.value || !isCustomPDFOutlineEnabled.value) {
    isMobileChapterPanelOpen.value = false;
  }

  const chapterToggle = getMobileChapterToggleButton();

  if (chapterToggle && !chapterToggle.dataset.annotationTabBound) {
    chapterToggle.addEventListener('click', handleMobileChapterToggleClick, true);
    chapterToggle.dataset.annotationTabBound = '1';
  }

  syncMobileChapterToggleState();
}

function switchAsideTab(tab: 'outline' | 'annotations') {
  if (tab === 'annotations') {
    if (!isPageNotesEnabled.value) {
      return;
    }

    closeMobileChapterPanelIfOpen();
  }

  activeAsideTab.value = tab;
}

function handleMobileNotesClick() {
  if (!isPageNotesEnabled.value) {
    return;
  }

  if (activeAsideTab.value === 'annotations') {
    handleMobileNotesClose();
    return;
  }

  switchAsideTab('annotations');
}

function handleMobileBackToTop() {
  closeMobileChapterPanelIfOpen();
  activeAsideTab.value = 'outline';
  window.scrollTo({ top: 0, left: 0, behavior: 'smooth' });
}

function handleMobileNotesClose() {
  activeAsideTab.value = 'outline';
}

function handleMobileOutsideClick(event: MouseEvent) {
  if (!isMobileViewport.value) {
    return;
  }

  const target = event.target as Element | null;
  if (!target) return;

  if (activeAsideTab.value === 'annotations') {
    if (target.closest('.mobile-localnav-notes')) {
      return;
    }

    if (target.closest('[data-mobile-tab="annotations"]')) {
      return;
    }

    handleMobileNotesClose();
    return;
  }

  if (!isCustomPDFOutlineEnabled.value || !isMobileChapterPanelOpen.value) {
    return;
  }

  if (target.closest('.mobile-localnav-pdf-outline')) {
    return;
  }

  if (target.closest('.VPLocalNavOutlineDropdown')) {
    return;
  }

  closeMobileChapterPanelIfOpen();
}

function queueViewportSync() {
  if (mobileViewportSyncRaf) return;

  mobileViewportSyncRaf = requestAnimationFrame(() => {
    mobileViewportSyncRaf = 0;
    syncMobileViewportState();
  });
}

function handlePDFSearchResultClick(event: MouseEvent) {
  const target = event.target as HTMLElement;
  const link = target.closest('a[href^="/pdf-content/"]') as HTMLAnchorElement | null;
  
  if (!link) return;
  
  event.preventDefault();
  event.stopPropagation();
  
  const href = link.getAttribute('href') || '';
  const hash = link.hash || '';
  
  let pageNumber = 1;
  if (hash && hash.startsWith('#page-')) {
    const match = hash.match(/#page-(\d+)/);
    if (match) {
      pageNumber = parseInt(match[1], 10);
    }
  }
  
  const targetPath = href.split('#')[0].replace('/pdf-content/', '/').replace(/\.html$/, '');
  
  sessionStorage.setItem('pdf_page_number', pageNumber.toString());
  
  window.location.replace(targetPath);
}

onMounted(() => {
  userStore.initUser();

  if (isIOSDevice()) {
    document.documentElement.classList.add('ios-touch-device');
    iosCalloutClassApplied = true;
  }

  annotationStore.setPageNotesEnabled(isPageNotesEnabled.value);
  annotationStore.setCurrentPage(route.path);
  syncMobileViewportState();

  localNavObserver = new MutationObserver(queueViewportSync);

  localNavObserver.observe(document.body, {
    subtree: true,
    childList: true
  });

  window.addEventListener('resize', queueViewportSync);
  document.addEventListener('click', handleMobileOutsideClick);
  document.addEventListener('click', handlePDFSearchResultClick, true);
  document.addEventListener('click', handleChapterLinkClick, true);
  document.addEventListener(PDF_OUTLINE_JUMP_EVENT, handlePDFOutlineJump as EventListener, true);
});

function handleChapterLinkClick(event: MouseEvent) {
  if (!isMobileChapterPanelOpen.value || !isMobileViewport.value) {
    return;
  }
  
  const target = event.target as HTMLElement;
  const link = target.closest('a');
  
  if (!link) {
    return;
  }
  
  const panel = document.querySelector('.mobile-localnav-pdf-outline, .VPLocalNavOutlineDropdown');
  if (!panel || !panel.contains(target)) {
    return;
  }
  
  if (link.getAttribute('href')?.startsWith('#') || !link.getAttribute('href')?.includes('://')) {
    isMobileChapterPanelOpen.value = false;
    syncMobileChapterToggleState();
    unlockBodyScroll();
  }
}

function handlePDFOutlineJump() {
  if (!isMobileViewport.value || !isCustomPDFOutlineEnabled.value || !isMobileChapterPanelOpen.value) {
    return;
  }

  // Avoid keeping the body in fixed-lock state, which can block page jump scrolling.
  closeMobileChapterPanelIfOpen();
  unlockBodyScroll();
}

watch(() => route.path, (newPath) => {
  pageNotesEnabledOverride.value = null;
  annotationStore.setPageNotesEnabled(isPageNotesEnabled.value);
  annotationStore.setCurrentPage(newPath);
  activeAsideTab.value = 'outline';
  isMobileChapterPanelOpen.value = false;
  queueViewportSync();
});

watch(() => annotationStore.selectedAnnotationId, (selectedId) => {
  if (!selectedId || !isPageNotesEnabled.value) {
    return;
  }

  if (window.innerWidth >= 960) {
    activeAsideTab.value = 'annotations';
    return;
  }

  activeAsideTab.value = 'outline';
});

watch(activeAsideTab, () => {
  if (activeAsideTab.value === 'annotations') {
    if (!isPageNotesEnabled.value) {
      activeAsideTab.value = 'outline';
      return;
    }

    closeMobileChapterPanelIfOpen();
  }
});

watch(isPageNotesEnabled, (enabled) => {
  annotationStore.setPageNotesEnabled(enabled);

  if (enabled) {
    return;
  }

  if (activeAsideTab.value === 'annotations') {
    activeAsideTab.value = 'outline';
  }

  annotationStore.selectAnnotation(null);
});

watch(isCustomPDFOutlineEnabled, (enabled) => {
  if (!enabled) {
    isMobileChapterPanelOpen.value = false;
  }

  queueViewportSync();
});

let isBodyScrollLocked = false;

function lockBodyScroll() {
  if (isBodyScrollLocked) return;
  const scrollY = window.scrollY;
  document.body.style.position = 'fixed';
  document.body.style.top = `-${scrollY}px`;
  document.body.style.left = '0';
  document.body.style.right = '0';
  document.body.style.overflow = 'hidden';
  isBodyScrollLocked = true;
}

function unlockBodyScroll() {
  if (!isBodyScrollLocked) return;
  const scrollY = document.body.style.top;
  document.body.style.position = '';
  document.body.style.top = '';
  document.body.style.left = '';
  document.body.style.right = '';
  document.body.style.overflow = '';
  if (scrollY) {
    window.scrollTo(0, parseInt(scrollY || '0') * -1);
  }
  isBodyScrollLocked = false;
}

const isAnyPanelOpen = computed(() => {
  return (isMobileChapterPanelOpen.value && activeAsideTab.value === 'outline') || 
         (activeAsideTab.value === 'annotations');
});

watch(isAnyPanelOpen, (isOpen) => {
  if (isMobileViewport.value) {
    if (isOpen) {
      lockBodyScroll();
    } else {
      unlockBodyScroll();
    }
  }
});

onUnmounted(() => {
  unlockBodyScroll();
  localNavObserver?.disconnect();
  localNavObserver = null;

  if (mobileViewportSyncRaf) {
    cancelAnimationFrame(mobileViewportSyncRaf);
    mobileViewportSyncRaf = 0;
  }

  window.removeEventListener('resize', queueViewportSync);
  document.removeEventListener('click', handleMobileOutsideClick);
  document.removeEventListener('click', handlePDFSearchResultClick, true);
  document.removeEventListener('click', handleChapterLinkClick, true);
  document.removeEventListener(PDF_OUTLINE_JUMP_EVENT, handlePDFOutlineJump as EventListener, true);

  if (iosCalloutClassApplied) {
    document.documentElement.classList.remove('ios-touch-device');
    iosCalloutClassApplied = false;
  }
});
</script>

<template>
  <Layout :class="['annotation-layout', `aside-tab-${activeAsideTab}`]">
    <template #aside-outline-before>
      <div
        v-if="canShowNotesControls"
        class="aside-controls-row"
      >
        <div
          class="aside-tabs"
          :class="{
            'is-outline': activeAsideTab === 'outline',
            'is-annotations': activeAsideTab === 'annotations'
          }"
          role="tablist"
          aria-label="章节与笔记切换"
        >
          <div
            class="aside-tab"
            role="tab"
            tabindex="0"
            :aria-selected="activeAsideTab === 'outline'"
            :class="{ active: activeAsideTab === 'outline' }"
            @click="switchAsideTab('outline')"
            @keyup.enter="switchAsideTab('outline')"
            @keyup.space.prevent="switchAsideTab('outline')"
          >
            章节
          </div>
          <div
            class="aside-tab"
            role="tab"
            tabindex="0"
            :aria-selected="activeAsideTab === 'annotations'"
            :class="{ active: activeAsideTab === 'annotations', disabled: !isPageNotesEnabled }"
            :aria-disabled="!isPageNotesEnabled"
            @click="switchAsideTab('annotations')"
            @keyup.enter="switchAsideTab('annotations')"
            @keyup.space.prevent="switchAsideTab('annotations')"
          >
            <span class="aside-tab-note-label">
              <span>笔记</span>
            </span>
          </div>
        </div>

        <button
          class="note-toggle-inline note-toggle-inline-external"
          type="button"
          :class="{ active: isPageNotesEnabled }"
          :title="noteToggleTooltip"
          :aria-label="noteToggleTooltip"
          :aria-pressed="isPageNotesEnabled"
          @click.stop="togglePageNotesEnabled"
        >
          <span class="cloud-status-dot" :class="effectiveNoteDotClass" :title="noteIndicatorTooltip || undefined"></span>
        </button>
      </div>
    </template>
    <template #aside-outline-after>
      <div v-if="isEnabledForCurrentPage && isCustomPDFOutlineEnabled" class="pdf-outline-panel">
        <PDFOutlineAside
          :items="customPDFOutlineItems"
          :viewer-id="customPDFOutlineViewerId"
        />
      </div>
      <div v-if="isPageNotesEnabled" class="annotation-panel">
        <AnnotationSidebar />
      </div>
    </template>
    <template #doc-after>
      <TextAnnotator v-if="isPageNotesEnabled" />

      <Teleport
        v-if="isEnabledForCurrentPage && isMobileViewport && mobileLocalNavContainerTarget"
        :to="mobileLocalNavContainerTarget"
      >
        <div class="mobile-localnav-tabs">
          <div
            class="mobile-notes-controls"
            :class="{ disabled: !isPageNotesEnabled }"
            data-mobile-tab="annotations"
          >
            <button
              class="mobile-localnav-tab mobile-notes-main-btn"
              type="button"
              :class="{ active: activeAsideTab === 'annotations', disabled: !isPageNotesEnabled }"
              :aria-disabled="!isPageNotesEnabled"
              @click="handleMobileNotesClick"
            >
              <span class="mobile-localnav-note-label">
                <span>笔记</span>
              </span>
            </button>
            <button
              class="note-toggle-inline mobile-note-toggle-btn"
              type="button"
              :class="{ active: isPageNotesEnabled }"
              :title="noteToggleTooltip"
              :aria-label="noteToggleTooltip"
              :aria-pressed="isPageNotesEnabled"
              @click.stop="togglePageNotesEnabled"
            >
              <span class="cloud-status-dot" :class="effectiveNoteDotClass" :title="noteIndicatorTooltip || undefined"></span>
            </button>
          </div>
          <button class="mobile-localnav-tab" type="button" @click="handleMobileBackToTop">
            顶部↑
          </button>
        </div>
      </Teleport>

      <Teleport
        v-if="isPageNotesEnabled && isMobileViewport && mobileLocalNavPanelTarget && activeAsideTab === 'annotations'"
        :to="mobileLocalNavPanelTarget"
      >
        <div
          class="mobile-localnav-notes"
        >
          <AnnotationSidebar :is-mobile-panel="true" @request-close-panel="handleMobileNotesClose" />
        </div>
      </Teleport>

      <Teleport
        v-if="isEnabledForCurrentPage && isMobileViewport && mobileLocalNavPanelTarget && activeAsideTab === 'outline' && isCustomPDFOutlineEnabled && isMobileChapterPanelOpen"
        :to="mobileLocalNavPanelTarget"
      >
        <div class="mobile-localnav-pdf-outline">
          <PDFOutlineAside
            :items="customPDFOutlineItems"
            :viewer-id="customPDFOutlineViewerId"
          />
        </div>
      </Teleport>
    </template>
  </Layout>
</template>
