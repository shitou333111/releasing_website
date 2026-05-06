<script setup lang="ts">
import DefaultTheme from 'vitepress/theme';
import { computed, onMounted, onUnmounted, ref, watch, nextTick } from 'vue';
import { useData, useRoute } from 'vitepress';
import { useUserStore } from './stores/userStore';
import { useAnnotationStore } from './stores/annotationStore';
import AnnotationSidebar from './components/AnnotationSidebar.vue';
import AuthModal from './treehole/AuthModal.vue';
import TextAnnotator from './components/TextAnnotator.vue';
import PDFOutlineAside from './components/PDFOutlineAside.vue';
import ArticleReadAloud from './components/ArticleReadAloud.vue';
import { useAnnotationConfig } from './utils/useAnnotationConfig';
import './custom.css';

const isTreeHolePage = computed(() => {
  const rawPath = route.path || '';
  let decodedPath = rawPath;

  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch (e) {
    decodedPath = rawPath;
  }

  return decodedPath.startsWith('/树洞/')
    || rawPath.startsWith('/树洞/')
    || decodedPath.startsWith('/tree-hole/')
    || rawPath.startsWith('/tree-hole/');
});

const isHomePage = computed(() => {
  const rawPath = route.path || '';
  return rawPath === '/' || rawPath === '/index' || rawPath === '';
});

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
  shownPage: number;
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

  const quotedMatch = raw.match(/^["“](.+?)["”]\s+(\d+)(?:\s+(\d+))?(?:\s+(\d+))?$/);
  const plainMatch = raw.match(/^(.+?)\s+(\d+)(?:\s+(\d+))?(?:\s+(\d+))?$/);
  const matched = quotedMatch ?? plainMatch;

  if (!matched) {
    return null;
  }

  const title = matched[1]?.trim();
  const page = Number(matched[2]);
  const shownPage = Number(matched[3] ?? page);
  const level = Number(matched[4] ?? 1);

  if (!title || !Number.isFinite(page) || page <= 0) {
    return null;
  }

  return {
    title,
    page,
    level: clampOutlineLevel(level),
    shownPage
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
    const shownPageRaw = Number(record.shownPage ?? page);

    list.push({
      title: titleRaw || `第 ${page} 页`,
      page,
      level: clampOutlineLevel(levelRaw),
      shownPage: Number.isFinite(shownPageRaw) && shownPageRaw > 0 ? shownPageRaw : page
    });

    return list;
  }, []);
}

const customPDFOutlineItems = computed(() => normalizePDFOutlineItems(frontmatter.value?.pdfOutline));
// removed pdfViewerId handling — single-PDF-per-page assumption
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
  return parseFrontmatterNoteEnabled(frontmatter.value?.notesEnabledInit);
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

const contentMaxWidth = computed(() => {
  const value = frontmatter.value?.contentMaxWidth;
  if (typeof value === 'number' && value > 0) {
    return `${value}px`;
  }
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return undefined;
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
  if (!isMobileViewport.value) {
    return;
  }

  const chapterToggle = getMobileChapterToggleButton();
  const fallbackChapterToggle = (mobileLocalNavContainerTarget.value?.querySelector('.VPLocalNav .menu') as HTMLElement | null)
    || document.querySelector('.VPLocalNav .menu') as HTMLElement | null;
  const chapterToggleElement = (chapterToggle as HTMLElement | null) || fallbackChapterToggle;

  if (!chapterToggleElement) {
    return;
  }

  if (isTreeHolePage.value) return;

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
  // If a custom PDF outline is enabled, we handle the mobile chapter toggle
  // ourselves (prevent native behavior and open the custom panel). Otherwise
  // allow VitePress's native chapter toggle to run so regular markdown pages
  // still open their built-in outline on mobile.

  if (isCustomPDFOutlineEnabled.value) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    activeAsideTab.value = 'outline';

    if (!isMobileViewport.value) {
      return;
    }

    isMobileChapterPanelOpen.value = !isMobileChapterPanelOpen.value;
    syncMobileChapterToggleState();
    return false;
  }

  // Not a custom PDF outline: don't prevent native behavior — but keep the
  // aside state consistent so UI reflects that 'outline' is the active tab.
  activeAsideTab.value = 'outline';
}

function syncMobileViewportState() {
  isMobileViewport.value = window.innerWidth < 960;
  mobileLocalNavContainerTarget.value = document.querySelector('.VPLocalNav .container') as HTMLElement | null;
  mobileLocalNavPanelTarget.value = document.querySelector('.VPLocalNav') as HTMLElement | null;

  if (isTreeHolePage.value) {
    mobileLocalNavContainerTarget.value = null;
    mobileLocalNavPanelTarget.value = null;
    isMobileChapterPanelOpen.value = false;
    return;
  }

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
  const link = target.closest('a[href^="/content-for-search/pdf-content/"]') as HTMLAnchorElement | null;
  
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
  
  const targetPath = href.split('#')[0].replace('/content-for-search/pdf-content/', '/').replace(/\.html$/, '');
  
  sessionStorage.setItem('pdf_page_number', pageNumber.toString());
  
  window.location.replace(targetPath);
}

function handleHTMLSearchResultClick(event: MouseEvent) {
  const target = event.target as HTMLElement;
  const link = target.closest('a[href^="/content-for-search/html-content/"]') as HTMLAnchorElement | null;
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

  const targetPath = href.split('#')[0].replace('/content-for-search/html-content/', '/').replace(/\.html$/, '');

  sessionStorage.setItem('external_html_page_number', pageNumber.toString());

  window.location.replace(targetPath);
}

function handleTreeHoleSearchResultClick(event: MouseEvent) {
  const target = event.target as HTMLElement;
  const link = target.closest('a[href^="/content-for-search/treehole-content/"]') as HTMLAnchorElement | null;
  if (!link) return;

  event.preventDefault();
  event.stopPropagation();

  const href = link.getAttribute('href') || '';
  const rawPath = href.split('#')[0];
  const prefix = '/content-for-search/treehole-content/';
  const rest = rawPath.startsWith(prefix) ? rawPath.slice(prefix.length) : '';
  const threadId = rest.split('/')[0];
  if (!threadId) return;

  sessionStorage.setItem('treehole_search_thread_id', threadId);
  window.location.replace('/树洞/');
}

function hideTreeHolePageElements() {
  if (!isTreeHolePage.value) return;

  // 隐藏所有可能的上一页/下一页相关元素
  const selectors = [
    '.VPFooter',
    '.VPDocFooter',
    '.VPDocFooter-content',
    '.VPDocFooter-prev-next',
    '.VPDocFooter-prev',
    '.VPDocFooter-next',
    '.vp-doc-footer',
    '.vp-doc-footer-prev-next',
    '.prev-next',
    '[data-vp-doc-footer]',
    'doc-footer',
    '.VPLink.pager-link',
    '.pager-link',
    'a.pager-link',
    '.pager-link.prev',
    '.pager-link.next',
    '[class*="pager"]',
    '[class*="Pager"]'
  ];

  selectors.forEach(selector => {
    const elements = document.querySelectorAll(selector);
    elements.forEach(el => {
      try {
        // record hide attempt
        (window as any).__treehole_logs = (window as any).__treehole_logs || [];
        (window as any).__treehole_logs.push({
          ts: Date.now(),
          action: 'hideTreeHoleElement',
          selector,
          outer: (el as HTMLElement).outerHTML.slice(0,1000),
          route: route.path
        });
      } catch (e) {
        // ignore
      }
      (el as HTMLElement).style.display = 'none';
      (el as HTMLElement).style.visibility = 'hidden';
      (el as HTMLElement).style.opacity = '0';
      (el as HTMLElement).style.pointerEvents = 'none';
      (el as HTMLElement).style.height = '0';
      (el as HTMLElement).style.margin = '0';
      (el as HTMLElement).style.padding = '0';
    });
  });
}

function removeSidebarNodes() {
  // Remove or hide core sidebar/aside nodes that may be rendered
  // by the theme outside of our component tree.
  const sidebarSelectors = [
    '.VPSidebar',
    '.VPDocAside',
    '.VPDoc .aside',
    '.VPDocAside .content',
    '.VPSidebar .curtain'
  ];

  sidebarSelectors.forEach(sel => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return;

    try {
      try {
        (window as any).__treehole_logs = (window as any).__treehole_logs || [];
        (window as any).__treehole_logs.push({ ts: Date.now(), action: 'removeSidebarNode', selector: sel, outer: el.outerHTML.slice(0,1000), route: route.path });
      } catch (e) { }
      // Prefer non-destructive hiding: add class instead of removing
      el.classList.add('vp-treehole-hidden');
      el.setAttribute('data-removed-by', 'treehole-hide-sidebar');
    } catch (e) {
      // fallback to hiding if remove not allowed
      try {
        (window as any).__treehole_logs = (window as any).__treehole_logs || [];
        (window as any).__treehole_logs.push({ ts: Date.now(), action: 'hideSidebarNodeFallback', selector: sel, outer: el.outerHTML.slice(0,1000), route: route.path });
      } catch (e) {}
      el.style.display = 'none';
      el.style.visibility = 'hidden';
      el.style.opacity = '0';
      el.style.pointerEvents = 'none';
    }
  });
}

function removeLocalNavAndChapterNodes() {
  // Hide known local-nav and mobile-localnav containers via a CSS class.
  // This avoids destructive DOM removals and prevents accidental removal
  // of shared ancestors that the theme may rely on.
  const selectors = [
    '.VPLocalNav',
    '.VPLocalNav .container',
    '.VPLocalNav .menu',
    '.VPLocalNavOutlineDropdown',
    '.mobile-localnav-tabs'
  ];

  selectors.forEach(sel => {
    const els = document.querySelectorAll(sel);
    els.forEach(el => {
      // Never touch elements that live inside the main site nav
      if (el.closest('.VPNavBar, .VPNav, .VPNavBarMenu')) return;
      try {
        el.classList.add('vp-treehole-hidden');
        el.setAttribute('data-removed-by', 'treehole-hide-chapter');
        try { (window as any).__treehole_logs = (window as any).__treehole_logs || []; (window as any).__treehole_logs.push({ ts: Date.now(), action: 'class-hide', selector: sel, outer: el.outerHTML.slice(0,1000), route: route.path }); } catch (e) {}
      } catch (e) {
        try { (el as HTMLElement).style.display = 'none'; } catch (__) { /* ignore */ }
      }
    });
  });
}

let treeHoleObserver: MutationObserver | null = null;

function updateHomePageClass() {
  if (isHomePage.value) {
    document.documentElement.classList.add('home');
    document.body.classList.add('home');
  } else {
    document.documentElement.classList.remove('home');
    document.body.classList.remove('home');
  }
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
  document.addEventListener('click', handleHTMLSearchResultClick, true);
  document.addEventListener('click', handleTreeHoleSearchResultClick, true);
  document.addEventListener('click', handleChapterLinkClick, true);
  document.addEventListener(PDF_OUTLINE_JUMP_EVENT, handlePDFOutlineJump as EventListener, true);

  nextTick(() => {
    updateHomePageClass();
    hideTreeHolePageElements();
    
    // 高亮侧边栏选中项
    highlightActiveSidebarItem();

    // 为树洞页面添加专门的 MutationObserver，确保动态加载的元素也被隐藏
    // Push a diagnostic snapshot for TreeHole pages to help debugging.
    try {
      if (isTreeHolePage.value) {
        (window as any).__treehole_logs = (window as any).__treehole_logs || [];
        const nav = document.querySelector('.VPNavBar, .VPNav');
        const localNav = document.querySelector('.VPLocalNav, .mobile-localnav-tabs, .VPLocalNavOutlineDropdown');
        (window as any).__treehole_logs.push({
          ts: Date.now(),
          action: 'diagnostic-snapshot',
          route: route.path,
          navOuter: nav ? (nav as HTMLElement).outerHTML.slice(0,2000) : null,
          localNavOuter: localNav ? (localNav as HTMLElement).outerHTML.slice(0,2000) : null,
          docClass: document.documentElement.className
        });
      }
    } catch (e) {
      // ignore
    }
    if (isTreeHolePage.value) {
      treeHoleObserver = new MutationObserver(() => {
          hideTreeHolePageElements();
          removeSidebarNodes();
          removeLocalNavAndChapterNodes();
      });

      treeHoleObserver.observe(document.body, {
        subtree: true,
        childList: true
      });
    }
    // Also proactively remove theme-rendered sidebar/localnav nodes if present.
    if (isTreeHolePage.value) {
      removeSidebarNodes();
      removeLocalNavAndChapterNodes();
    }
    // Ensure global document root reflects TreeHole page state so CSS
    // selectors targeting top-level nav/aside can reliably hide elements.
    try {
      if (isTreeHolePage.value) {
        document.documentElement.classList.add('is-treehole-page');
      } else {
        document.documentElement.classList.remove('is-treehole-page');
      }
    } catch (e) {
      // ignore in SSR or restricted environments
    }
    
    // 监听侧边栏的变化，确保动态加载时也能高亮
    const sidebarObserver = new MutationObserver(() => {
      highlightActiveSidebarItem();
    });
    
    const sidebarNav = document.getElementById('VPSidebarNav');
    if (sidebarNav) {
      sidebarObserver.observe(sidebarNav, {
        subtree: true,
        childList: true
      });
    }
  });
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

function highlightActiveSidebarItem() {
  // 清除之前的选中样式
  const previousItems = document.querySelectorAll('.VPSidebarItem.custom-active');
  previousItems.forEach(item => {
    item.classList.remove('custom-active');
  });
  
  const previousLinks = document.querySelectorAll('#VPSidebarNav a.custom-active');
  previousLinks.forEach(link => {
    link.classList.remove('custom-active');
  });
  
  const previousTexts = document.querySelectorAll('#VPSidebarNav .text.custom-active');
  previousTexts.forEach(text => {
    text.classList.remove('custom-active');
  });

  // 获取当前路径
  let currentPath = route.path || '';
  
  // 找到匹配的侧边栏链接
  const allSidebarLinks = document.querySelectorAll('#VPSidebarNav a');
  let matchedLink: HTMLAnchorElement | null = null;
  
  allSidebarLinks.forEach(link => {
    const linkEl = link as HTMLAnchorElement;
    const linkPath = new URL(linkEl.href).pathname;
    
    if (linkPath === currentPath || 
        linkPath === currentPath + 'index' || 
        currentPath === linkPath + '/') {
      matchedLink = linkEl;
    }
  });
  
  if (matchedLink) {
    // 找到最近的 VPSidebarItem
    const sidebarItem = matchedLink.closest('.VPSidebarItem');
    if (sidebarItem) {
      sidebarItem.classList.add('custom-active');
    }
    
    // 给链接添加 active 类
    matchedLink.classList.add('custom-active');
    
    // 给文字添加 active 类
    const textEl = matchedLink.querySelector('.text');
    if (textEl) {
      textEl.classList.add('custom-active');
    }
  }
}

watch(() => route.path, (newPath) => {
  pageNotesEnabledOverride.value = null;
  annotationStore.setPageNotesEnabled(isPageNotesEnabled.value);
  annotationStore.setCurrentPage(newPath);
  activeAsideTab.value = 'outline';
  isMobileChapterPanelOpen.value = false;
  queueViewportSync();

  // 路由变化时，先清理旧的 observer
  if (treeHoleObserver) {
    treeHoleObserver.disconnect();
    treeHoleObserver = null;
  }

  nextTick(() => {
    updateHomePageClass();
    hideTreeHolePageElements();
    
    // 高亮侧边栏选中项
    highlightActiveSidebarItem();

    // 新页面如果是树洞页面，重新设置 observer
    if (isTreeHolePage.value) {
      treeHoleObserver = new MutationObserver(() => {
        hideTreeHolePageElements();
      });

      treeHoleObserver.observe(document.body, {
        subtree: true,
        childList: true
      });
    }
    // Keep a global document class in sync too so CSS outside the
    // Layout tree can detect TreeHole pages and hide sidebars/localnavs.
    try {
      if (isTreeHolePage.value) {
        document.documentElement.classList.add('is-treehole-page');
      } else {
        document.documentElement.classList.remove('is-treehole-page');
      }
    } catch (e) {
      // ignore
    }
  });
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
  treeHoleObserver?.disconnect();
  treeHoleObserver = null;

  if (mobileViewportSyncRaf) {
    cancelAnimationFrame(mobileViewportSyncRaf);
    mobileViewportSyncRaf = 0;
  }

  window.removeEventListener('resize', queueViewportSync);
  document.removeEventListener('click', handleMobileOutsideClick);
  document.removeEventListener('click', handlePDFSearchResultClick, true);
  document.removeEventListener('click', handleHTMLSearchResultClick, true);
  document.removeEventListener('click', handleTreeHoleSearchResultClick, true);
  document.removeEventListener('click', handleChapterLinkClick, true);
  document.removeEventListener(PDF_OUTLINE_JUMP_EVENT, handlePDFOutlineJump as EventListener, true);

  if (iosCalloutClassApplied) {
    document.documentElement.classList.remove('ios-touch-device');
    iosCalloutClassApplied = false;
  }
  try {
    document.documentElement.classList.remove('is-treehole-page');
  } catch (e) {
    // ignore
  }
});
</script>

<template>
  <Layout :class="['annotation-layout', `aside-tab-${activeAsideTab}`, isTreeHolePage ? 'is-treehole-page' : '', isHomePage ? 'home' : '']" :style="contentMaxWidth ? { '--content-max-width': contentMaxWidth } : undefined">
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
            v-if="!isTreeHolePage"
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
      <div v-if="isCustomPDFOutlineEnabled" class="pdf-outline-panel">
        <PDFOutlineAside
          :items="customPDFOutlineItems"
        />
      </div>
      <div v-if="isPageNotesEnabled" class="annotation-panel">
        <AnnotationSidebar />
      </div>
    </template>
    <template #doc-after>
      <ClientOnly>
        <ArticleReadAloud />
      </ClientOnly>
      <TextAnnotator v-if="isPageNotesEnabled" />
      <AuthModal />

      <Teleport
        v-if="!isTreeHolePage && isEnabledForCurrentPage && isMobileViewport && mobileLocalNavContainerTarget"
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
        v-if="!isTreeHolePage && isPageNotesEnabled && isMobileViewport && mobileLocalNavPanelTarget && activeAsideTab === 'annotations'"
        :to="mobileLocalNavPanelTarget"
      >
        <div
          class="mobile-localnav-notes"
        >
          <AnnotationSidebar :is-mobile-panel="true" @request-close-panel="handleMobileNotesClose" />
        </div>
      </Teleport>

      <Teleport
        v-if="!isTreeHolePage && isMobileViewport && mobileLocalNavPanelTarget && activeAsideTab === 'outline' && isCustomPDFOutlineEnabled && isMobileChapterPanelOpen"
        :to="mobileLocalNavPanelTarget"
      >
        <div class="mobile-localnav-pdf-outline">
          <PDFOutlineAside
            :items="customPDFOutlineItems"
          />
        </div>
      </Teleport>
    </template>
  </Layout>
</template>
