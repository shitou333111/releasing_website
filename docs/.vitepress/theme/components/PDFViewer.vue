<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { useUserStore } from '../stores/userStore';
import { useAnnotationStore } from '../stores/annotationStore';
import { useAnnotationConfig } from '../utils/useAnnotationConfig';
import { DEFAULT_TAG_COLORS } from '../utils/types';
import { copyTextToClipboard } from '../utils/clipboard';

type CropInsets = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

type PDFOutlineJumpDetail = {
  page?: number;
  viewerId?: string;
  source?: string;
};

const PDF_OUTLINE_JUMP_EVENT = 'pdf-outline-jump';

const props = withDefaults(defineProps<{
  src: string;
  embedMode?: 'contained' | 'fullpage';
  height?: string;
  background?: string;
  trimX?: number;
  enableCrop?: boolean;
  showPageSeparators?: boolean;
  showCropGuides?: boolean;
  showBorder?: boolean;
  cropOdd?: Partial<CropInsets>;
  cropEven?: Partial<CropInsets>;
  lazyPageBuffer?: number;
  lazyRootMargin?: string;
}>(), {
  embedMode: 'contained',
  height: '72vh',
  background: '#ffffff',
  trimX: 0,
  enableCrop: true,
  showPageSeparators: false,
  showCropGuides: false,
  showBorder: true,
  cropOdd: () => ({}),
  cropEven: () => ({}),
  lazyPageBuffer: 2,
  lazyRootMargin: '180% 0px'
});

const userStore = useUserStore();
const annotationStore = useAnnotationStore();
const { config, isEnabledForCurrentPage } = useAnnotationConfig();
const isNoteSystemActive = computed(() => {
  return isEnabledForCurrentPage.value
    && config.value.features.pdfAnnotation
    && annotationStore.pageNotesEnabled;
});

const cropFrameRef = ref<HTMLElement | null>(null);
const containerRef = ref<HTMLElement | null>(null);
const showQuickBubble = ref(false);
const quickBubblePosition = ref({ x: 0, y: 0 });
const quickBubbleAnchorRect = ref<{ left: number; top: number; width: number; height: number } | null>(null);
const activeAnnotationId = ref<string | null>(null);
const pendingSelection = ref<any>(null);
const previewAnnotation = ref<{ id: string; target: { selector: any[] }; color: string } | null>(null);
const quickComment = ref('');
const quickCommentFocused = ref(false);
const selectedColor = ref(DEFAULT_TAG_COLORS[0]);
const privacy = ref<'public' | 'private'>('public');
const copyFeedbackVisible = ref(false);
const fullPageHeight = ref('120vh');
const resolvedPDFSource = ref<string | null>(null);
const pageMetrics = ref<Record<number, { width: number; height: number }>>({});
const pdfPageWidth = ref<number | undefined>(undefined);
const VuePDFComponent = shallowRef<any>(null);
const pdf = ref<any>(null);
const pages = ref<number>(0);
const viewportAnchorPages = ref<number[]>([1]);
let stopPDFSyncWatch: (() => void) | null = null;
let stopPagesSyncWatch: (() => void) | null = null;
let pageWidthObserver: ResizeObserver | null = null;
let pageIntersectionObserver: IntersectionObserver | null = null;
let intersectingPages = new Set<number>();
const pageShellRefs = new Map<number, HTMLElement>();
const DEFAULT_PAGE_ASPECT_RATIO = Math.SQRT2;
const MIN_VISIBLE_PAGE_SIZE = 16;
const RESPONSIVE_CROP_BASE_WIDTH = 768;
const RESPONSIVE_CROP_MIN_SCALE = 0.55;

const pdfSource = computed(() => {
  if (!resolvedPDFSource.value) return undefined;

  return {
    url: resolvedPDFSource.value,
    cMapUrl: '/cmaps/',
    cMapPacked: true,
    wasmUrl: '/wasm/'
  };
});

const pageNumbers = computed(() => {
  const count = Number(pages.value || 0);
  if (!Number.isFinite(count) || count <= 0) return [] as number[];
  return Array.from({ length: count }, (_, index) => index + 1);
});

function normalizePositiveNumber(value: unknown, fallback = 0): number {
  const normalized = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(0, normalized);
}

function normalizeCropInsets(input: Partial<CropInsets> | undefined, fallbackHorizontal = 0): CropInsets {
  return {
    top: normalizePositiveNumber(input?.top, 0),
    right: normalizePositiveNumber(input?.right, fallbackHorizontal),
    bottom: normalizePositiveNumber(input?.bottom, 0),
    left: normalizePositiveNumber(input?.left, fallbackHorizontal)
  };
}

function getRawCropInsetsForPage(pageNumber: number): CropInsets {
  if (!props.enableCrop) {
    return { top: 0, right: 0, bottom: 0, left: 0 };
  }

  const legacyTrim = normalizePositiveNumber(props.trimX, 0);
  const source = pageNumber % 2 === 0 ? props.cropEven : props.cropOdd;
  return normalizeCropInsets(source, legacyTrim);
}

function getResponsiveCropInsetsForViewport(pageNumber: number, viewportWidth: number): CropInsets {
  const raw = getRawCropInsetsForPage(pageNumber);
  if (!props.enableCrop) {
    return raw;
  }

  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0 || viewportWidth >= RESPONSIVE_CROP_BASE_WIDTH) {
    return raw;
  }

  const scale = Math.max(RESPONSIVE_CROP_MIN_SCALE, viewportWidth / RESPONSIVE_CROP_BASE_WIDTH);
  return {
    top: round2(raw.top * scale),
    right: round2(raw.right * scale),
    bottom: round2(raw.bottom * scale),
    left: round2(raw.left * scale)
  };
}

function getCropSignature(): string {
  const odd = getRawCropInsetsForPage(1);
  const even = getRawCropInsetsForPage(2);
  return [odd.top, odd.right, odd.bottom, odd.left, even.top, even.right, even.bottom, even.left].join('|');
}

const estimatedPageAspectRatio = computed(() => {
  const metrics = Object.values(pageMetrics.value).find(item => item.width > 0 && item.height > 0);
  if (!metrics) {
    return DEFAULT_PAGE_ASPECT_RATIO;
  }

  return metrics.height / metrics.width;
});

const currentQuickAnnotation = computed(() => {
  if (!activeAnnotationId.value) return null;
  return annotationStore.annotations.find(annotation => annotation.id === activeAnnotationId.value) || null;
});

const isQuickBubbleReadonly = computed(() => {
  if (!currentQuickAnnotation.value?.creator?.id) return false;
  return currentQuickAnnotation.value.creator.id !== userStore.currentUser?.id;
});

let fullPageObserver: ResizeObserver | null = null;
let fullPageSyncRaf = 0;
let fullPageSyncTimeout = 0;
let lastFullPageSyncAt = 0;
let lastFullPageHeightPx = 0;
let resolvedPDFObjectURL: string | null = null;
let copyFeedbackTimeout = 0;
let copyAutoCloseTimeout = 0;
let deselectTimeout = 0;
let suppressDeselectUntil = 0;
let suppressBubbleCloseUntil = 0;
let resolveSourceToken = 0;
let suppressAutoBubbleForSidebarSelectionUntil = 0;
let suppressAutoBubbleForSidebarSelectionId: string | null = null;
const QUICK_BUBBLE_REPOSITION_MIN_INTERVAL = 48;
let quickBubbleRepositionRaf = 0;
let quickBubbleRepositionLastAt = 0;

function buildPdfAnnotationSignature(): string {
  return annotationStore.filteredAnnotations
    .filter(annotation => annotation.type === 'pdf')
    .map(annotation => {
      const selectorCount = Array.isArray(annotation.target?.selector) ? annotation.target.selector.length : 0;
      return `${annotation.id}:${annotation.modified || annotation.created}:${selectorCount}`;
    })
    .join('|');
}

function isValidPdfSelector(selector: any): boolean {
  if (!selector || typeof selector !== 'object') return false;

  const pageNumberValid = typeof selector.pageNumber === 'number' && Number.isFinite(selector.pageNumber);
  const quadpointsValid = Array.isArray(selector.quadpoints)
    && selector.quadpoints.length >= 8
    && selector.quadpoints.every((point: unknown) => typeof point === 'number' && Number.isFinite(point));

  return pageNumberValid && quadpointsValid;
}

function sanitizePdfTarget(target: any): { selector: any[] } | null {
  if (!target || !Array.isArray(target.selector)) return null;

  const selectors = target.selector
    .filter((selector: any) => isValidPdfSelector(selector))
    .map((selector: any) => ({
      pageNumber: selector.pageNumber,
      quadpoints: selector.quadpoints,
      quote: typeof selector.quote === 'string' ? selector.quote : undefined
    }));

  if (!selectors.length) return null;

  return { selector: selectors };
}

function collectPageNumbersFromTarget(target: any, output: Set<number>) {
  if (!target || !Array.isArray(target.selector)) {
    return;
  }

  target.selector.forEach((selector: any) => {
    const pageNumber = Number(selector?.pageNumber || 0);
    if (Number.isFinite(pageNumber) && pageNumber > 0) {
      output.add(pageNumber);
    }
  });
}

const forcedVisiblePages = computed(() => {
  const forced = new Set<number>([1]);

  if (pendingSelection.value?.target) {
    collectPageNumbersFromTarget(pendingSelection.value.target, forced);
  }

  if (previewAnnotation.value?.target) {
    collectPageNumbersFromTarget(previewAnnotation.value.target, forced);
  }

  if (annotationStore.selectedAnnotationId) {
    const selected = annotationStore.annotations.find(annotation => annotation.id === annotationStore.selectedAnnotationId);
    if (selected?.type === 'pdf') {
      collectPageNumbersFromTarget(selected.target, forced);
    }
  }

  return forced;
});

const shouldLazyRender = computed(() => pageNumbers.value.length > 8);

const activePageNumberSet = computed(() => {
  const allPages = pageNumbers.value;
  if (!shouldLazyRender.value) {
    return new Set(allPages);
  }

  const buffer = Math.max(1, Math.floor(Number(props.lazyPageBuffer || 2)));
  const totalPages = allPages.length;
  const anchors = viewportAnchorPages.value.length ? viewportAnchorPages.value : [1];
  const active = new Set<number>();

  anchors.forEach(anchor => {
    for (let page = anchor - buffer; page <= anchor + buffer; page += 1) {
      if (page >= 1 && page <= totalPages) {
        active.add(page);
      }
    }
  });

  forcedVisiblePages.value.forEach(pageNumber => {
    if (pageNumber >= 1 && pageNumber <= totalPages) {
      active.add(pageNumber);
    }
  });

  return active;
});

function shouldRenderPage(pageNumber: number): boolean {
  return activePageNumberSet.value.has(pageNumber);
}

function updateViewportAnchors(anchors: number[]) {
  const totalPages = pageNumbers.value.length;
  const normalized = anchors
    .map(page => Number(page || 0))
    .filter(page => Number.isFinite(page) && page >= 1 && page <= totalPages)
    .sort((a, b) => a - b);

  const deduped = Array.from(new Set(normalized));
  const next = deduped.length ? deduped : [1];

  if (next.length === viewportAnchorPages.value.length
    && next.every((page, index) => page === viewportAnchorPages.value[index])) {
    return;
  }

  viewportAnchorPages.value = next;
}

function teardownPageIntersectionObserver() {
  if (pageIntersectionObserver) {
    pageIntersectionObserver.disconnect();
    pageIntersectionObserver = null;
  }

  intersectingPages = new Set<number>();
}

function setupPageIntersectionObserver() {
  teardownPageIntersectionObserver();

  if (!shouldLazyRender.value || !containerRef.value || typeof IntersectionObserver === 'undefined') {
    updateViewportAnchors([1]);
    return;
  }

  const root = props.embedMode === 'contained' ? containerRef.value : null;

  pageIntersectionObserver = new IntersectionObserver((entries) => {
    let changed = false;

    entries.forEach(entry => {
      const pageNumber = Number((entry.target as HTMLElement).dataset.pageNumber || 0);
      if (!Number.isFinite(pageNumber) || pageNumber <= 0) {
        return;
      }

      if (entry.isIntersecting) {
        if (!intersectingPages.has(pageNumber)) {
          intersectingPages.add(pageNumber);
          changed = true;
        }
      } else if (intersectingPages.delete(pageNumber)) {
        changed = true;
      }
    });

    if (!changed) {
      return;
    }

    updateViewportAnchors(Array.from(intersectingPages).sort((a, b) => a - b));
  }, {
    root,
    rootMargin: props.lazyRootMargin,
    threshold: 0.01
  });

  pageShellRefs.forEach(element => {
    pageIntersectionObserver?.observe(element);
  });
}

function setPageShellRef(pageNumber: number, element: Element | null) {
  const previous = pageShellRefs.get(pageNumber);
  if (previous && previous !== element) {
    pageIntersectionObserver?.unobserve(previous);
  }

  if (element instanceof HTMLElement) {
    pageShellRefs.set(pageNumber, element);
    pageIntersectionObserver?.observe(element);
  } else {
    pageShellRefs.delete(pageNumber);
    intersectingPages.delete(pageNumber);
  }
}

function selectKnownAnnotation(annotationId: string | null) {
  if (!annotationId) {
    annotationStore.selectAnnotation(null);
    return;
  }

  annotationStore.selectAnnotation(annotationId);
}

function markSelectionInteraction() {
  suppressDeselectUntil = Date.now() + 520;
  if (deselectTimeout) {
    window.clearTimeout(deselectTimeout);
    deselectTimeout = 0;
  }
}

function queueDeselectAnnotation() {
  if (deselectTimeout) {
    window.clearTimeout(deselectTimeout);
  }

  deselectTimeout = window.setTimeout(() => {
    deselectTimeout = 0;
    if (Date.now() < suppressDeselectUntil) {
      return;
    }

    if (showQuickBubble.value) {
      return;
    }

    if (activeAnnotationId.value && annotationStore.selectedAnnotationId === activeAnnotationId.value) {
      return;
    }

    annotationStore.selectAnnotation(null);
  }, 180);
}

function isIOSTouchDevice(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }

  const userAgent = navigator.userAgent || '';
  return /iP(hone|od|ad)/.test(userAgent)
    || (userAgent.includes('Mac') && navigator.maxTouchPoints > 1);
}

function handleMobileContextMenu(event: Event) {
  if (!isIOSTouchDevice()) return;

  const target = event.target as Element | null;
  if (target?.closest('input, textarea, [contenteditable="true"]')) {
    return;
  }

  event.preventDefault();
}

function getSelectedQuoteText() {
  const quote = pendingSelection.value?.target?.selector?.[0]?.quote?.trim();
  if (quote) {
    return quote;
  }

  const pageNumber = pendingSelection.value?.target?.selector?.[0]?.pageNumber;
  return pageNumber ? `PDF 选区（第 ${pageNumber} 页）` : '';
}

async function copySelectedQuote() {
  const quote = getSelectedQuoteText();
  if (!quote) return;

  try {
    const copied = await copyTextToClipboard(quote);
    if (!copied) {
      throw new Error('clipboard copy fallback failed');
    }

    copyFeedbackVisible.value = true;
    suppressBubbleCloseUntil = Date.now() + 1500;

    if (copyFeedbackTimeout) {
      window.clearTimeout(copyFeedbackTimeout);
    }

    if (copyAutoCloseTimeout) {
      window.clearTimeout(copyAutoCloseTimeout);
      copyAutoCloseTimeout = 0;
    }

    copyFeedbackTimeout = window.setTimeout(() => {
      copyFeedbackVisible.value = false;
      copyFeedbackTimeout = 0;

      if (window.innerWidth < 960 && showQuickBubble.value) {
        copyAutoCloseTimeout = window.setTimeout(() => {
          copyAutoCloseTimeout = 0;
          if (showQuickBubble.value) {
            cancelQuickBubble();
          }
        }, 180);
      }
    }, 1100);
  } catch (error) {
    console.error('Failed to copy selected PDF quote:', error);
  }
}

function getCurrentSelectionRect(): DOMRect | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  const rects = range.getClientRects();
  if (rects.length > 0) {
    return rects[rects.length - 1] as DOMRect;
  }

  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return rect;
}

function setQuickBubbleAnchorFromViewportRect(rect: { left: number; top: number; width: number; height: number }) {
  quickBubbleAnchorRect.value = {
    left: rect.left + window.scrollX,
    top: rect.top + window.scrollY,
    width: rect.width,
    height: rect.height
  };
}

function captureQuickBubbleAnchor() {
  const rect = getCurrentSelectionRect();
  if (!rect) return;

  setQuickBubbleAnchorFromViewportRect(rect);
}

function captureQuickBubbleAnchorFromElement(element: Element | null) {
  if (!element) return;

  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;

  setQuickBubbleAnchorFromViewportRect(rect);
}

function positionQuickBubble() {
  if (!getCurrentSelectionRect() && activeAnnotationId.value) {
    captureQuickBubbleAnchorFromElement(collectPDFAnnotationElement(activeAnnotationId.value));
  }

  const liveRect = getCurrentSelectionRect();
  const anchor = liveRect || (quickBubbleAnchorRect.value
    ? {
        left: quickBubbleAnchorRect.value.left - window.scrollX,
        top: quickBubbleAnchorRect.value.top - window.scrollY,
        width: quickBubbleAnchorRect.value.width,
        height: quickBubbleAnchorRect.value.height,
        right: quickBubbleAnchorRect.value.left - window.scrollX + quickBubbleAnchorRect.value.width,
        bottom: quickBubbleAnchorRect.value.top - window.scrollY + quickBubbleAnchorRect.value.height
      }
    : null);

  if (!anchor) return;

  const verticalHideMargin = window.innerHeight * 2;
  const horizontalHideMargin = 24;
  const isOutOfViewport = anchor.bottom < -verticalHideMargin
    || anchor.top > window.innerHeight + verticalHideMargin
    || anchor.right < -horizontalHideMargin
    || anchor.left > window.innerWidth + horizontalHideMargin;

  if (isOutOfViewport) {
    cancelQuickBubble();
    return;
  }

  const viewportPadding = 8;
  const bubbleWidth = Math.min(284, window.innerWidth - viewportPadding * 2);
  const estimatedHeight = 206;

  let x = anchor.left + anchor.width / 2 - bubbleWidth / 2;
  let y = anchor.bottom + 10;

  if (y + estimatedHeight > window.innerHeight - viewportPadding) {
    y = Math.max(viewportPadding, anchor.top - estimatedHeight - 10);
  }

  if (window.innerWidth <= 768) {
    x = Math.max(viewportPadding, (window.innerWidth - bubbleWidth) / 2);
  } else {
    x = Math.min(window.innerWidth - bubbleWidth - viewportPadding, Math.max(viewportPadding, x));
  }

  quickBubblePosition.value = { x, y };
}

function scheduleQuickBubblePosition() {
  if (!showQuickBubble.value) return;
  if (quickBubbleRepositionRaf) return;

  quickBubbleRepositionRaf = requestAnimationFrame((timestamp) => {
    quickBubbleRepositionRaf = 0;

    if (!showQuickBubble.value) return;

    if (timestamp - quickBubbleRepositionLastAt < QUICK_BUBBLE_REPOSITION_MIN_INTERVAL) {
      scheduleQuickBubblePosition();
      return;
    }

    quickBubbleRepositionLastAt = timestamp;
    positionQuickBubble();
  });
}

function resetQuickBubbleDraft() {
  activeAnnotationId.value = null;
  quickComment.value = '';
  quickCommentFocused.value = false;
  privacy.value = 'public';
}

function collectPDFAnnotationElement(annotationId: string): Element | null {
  const selectors = [
    `.pdf-viewer-container .pdf-annotation-highlight[data-annotation-id="${annotationId}"]`,
    `.pdf-viewer-container .pdf-annotation-highlight[data-id="${annotationId}"]`,
    `.pdf-viewer-container [data-annotation-id="${annotationId}"]`,
    `.pdf-viewer-container [data-id="${annotationId}"]`,
    `.r6o-annotation[data-annotation-id="${annotationId}"]`,
    `.r6o-annotation[data-id="${annotationId}"]`
  ];

  for (const selector of selectors) {
    const found = document.querySelector(selector);
    if (found) return found;
  }

  return null;
}

function openQuickBubbleForExistingAnnotation(annotationId: string) {
  const annotation = annotationStore.annotations.find(a => a.id === annotationId && a.type === 'pdf');
  if (!annotation) {
    return;
  }

  const sanitizedTarget = sanitizePdfTarget(annotation.target);
  if (!sanitizedTarget) {
    return;
  }

  activeAnnotationId.value = annotation.id;
  pendingSelection.value = {
    target: JSON.parse(JSON.stringify(sanitizedTarget))
  };
  previewAnnotation.value = null;
  selectedColor.value = annotation.color || DEFAULT_TAG_COLORS[0];
  quickComment.value = annotation.bodies[0]?.value || '';
  privacy.value = annotation.privacy || 'public';
  quickCommentFocused.value = false;

  captureQuickBubbleAnchorFromElement(collectPDFAnnotationElement(annotationId));
  showQuickBubble.value = true;
  requestAnimationFrame(() => positionQuickBubble());
}

function getCurrentAnnotationComment() {
  const active = activeAnnotationId.value
    ? annotationStore.annotations.find(a => a.id === activeAnnotationId.value)
    : null;

  return active?.bodies[0]?.value || '';
}

function updateExistingAnnotationFromQuickBubble(mode: 'highlight' | 'comment') {
  if (!activeAnnotationId.value) {
    return;
  }

  const current = annotationStore.annotations.find(a => a.id === activeAnnotationId.value);
  if (!current) {
    return;
  }

  const now = new Date().toISOString();
  const nextComment = mode === 'comment' ? quickComment.value.trim() : getCurrentAnnotationComment();
  const createdAt = current.bodies[0]?.created || now;

  const sanitizedTarget = sanitizePdfTarget(pendingSelection.value?.target || current.target);
  if (!sanitizedTarget) {
    return;
  }

  annotationStore.updateAnnotation(current.id, {
    target: JSON.parse(JSON.stringify(sanitizedTarget)),
    color: selectedColor.value,
    privacy: config.value.features.privacy ? privacy.value : 'public',
    bodies: [
      {
        type: 'TextualBody',
        value: nextComment,
        purpose: 'commenting',
        created: createdAt,
        modified: now
      }
    ]
  });
}

function createAnnotationFromQuickBubble(mode: 'highlight' | 'comment') {
  if (!pendingSelection.value?.target || !userStore.currentUser) {
    return;
  }

  const sanitizedTarget = sanitizePdfTarget(pendingSelection.value.target);
  if (!sanitizedTarget) {
    return;
  }

  annotationStore.addAnnotation(
    'pdf',
    sanitizedTarget,
    mode === 'comment' ? quickComment.value.trim() : '',
    userStore.currentUser,
    selectedColor.value,
    config.value.features.privacy ? privacy.value : 'public'
  );
}

function persistQuickAction(mode: 'highlight' | 'comment') {
  if (!pendingSelection.value?.target) {
    return;
  }

  if (!userStore.currentUser || !userStore.isLoggedIn) {
    userStore.setAuthError('请先注册/登录后再创建标注');
    userStore.openAuthModal();
    return;
  }

  if (activeAnnotationId.value) {
    updateExistingAnnotationFromQuickBubble(mode);
  } else {
    createAnnotationFromQuickBubble(mode);
  }

  showQuickBubble.value = false;
  pendingSelection.value = null;
  previewAnnotation.value = null;
  quickBubbleAnchorRect.value = null;
  resetQuickBubbleDraft();
}

function teardownFullPageObserver() {
  if (fullPageObserver) {
    fullPageObserver.disconnect();
    fullPageObserver = null;
  }

  if (fullPageSyncRaf) {
    cancelAnimationFrame(fullPageSyncRaf);
    fullPageSyncRaf = 0;
  }

  if (fullPageSyncTimeout) {
    window.clearTimeout(fullPageSyncTimeout);
    fullPageSyncTimeout = 0;
  }
}

function getIntrinsicFullPageContentHeight(stage: HTMLElement): number {
  const pagesRoot = stage.querySelector('.pdf-vue-pages') as HTMLElement | null;
  if (!pagesRoot) {
    return Math.ceil(stage.scrollHeight);
  }

  // Measure the pages container directly to avoid a feedback loop where
  // container height itself becomes the next measurement baseline.
  return Math.ceil(pagesRoot.scrollHeight);
}

function syncFullPageHeight(force = false) {
  if (props.embedMode !== 'fullpage' || !containerRef.value) return;

  const now = Date.now();
  if (!force && now - lastFullPageSyncAt < 220) {
    return;
  }

  const stage = containerRef.value;
  const contentBased = getIntrinsicFullPageContentHeight(stage);
  const nextHeight = Math.max(contentBased, window.innerHeight);

  if (Math.abs(nextHeight - lastFullPageHeightPx) >= 4 || force) {
    lastFullPageHeightPx = nextHeight;
    fullPageHeight.value = `${nextHeight}px`;
  }

  lastFullPageSyncAt = now;
}

function scheduleFullPageHeightSync(force = false) {
  if (props.embedMode !== 'fullpage') return;

  if (fullPageSyncTimeout) {
    window.clearTimeout(fullPageSyncTimeout);
    fullPageSyncTimeout = 0;
  }

  const delay = force ? 0 : 120;
  fullPageSyncTimeout = window.setTimeout(() => {
    fullPageSyncTimeout = 0;

    if (fullPageSyncRaf) {
      if (!force) return;
      cancelAnimationFrame(fullPageSyncRaf);
      fullPageSyncRaf = 0;
    }

    fullPageSyncRaf = requestAnimationFrame(() => {
      fullPageSyncRaf = 0;
      syncFullPageHeight(force);
    });
  }, delay);
}

function setupFullPageObserver() {
  teardownFullPageObserver();
  if (props.embedMode !== 'fullpage' || !containerRef.value) return;

  fullPageObserver = new ResizeObserver(() => {
    scheduleFullPageHeightSync();
  });

  fullPageObserver.observe(containerRef.value);
  scheduleFullPageHeightSync(true);
}

function syncPdfPageWidth(force = false) {
  const frame = cropFrameRef.value;
  if (!frame) return;

  const frameWidth = frame.getBoundingClientRect().width;
  let horizontalPadding = 0;
  if (props.enableCrop) {
    const oddCrop = getResponsiveCropInsetsForViewport(1, frameWidth);
    const evenCrop = getResponsiveCropInsetsForViewport(2, frameWidth);
    horizontalPadding = Math.max(oddCrop.left + oddCrop.right, evenCrop.left + evenCrop.right);
  }

  const measured = frameWidth + horizontalPadding;
  if (!Number.isFinite(measured) || measured <= 120) return;

  if (!force && pdfPageWidth.value && Math.abs(pdfPageWidth.value - measured) < 0.25) {
    return;
  }

  pdfPageWidth.value = round2(measured);
}

function teardownPageWidthObserver() {
  if (pageWidthObserver) {
    pageWidthObserver.disconnect();
    pageWidthObserver = null;
  }
}

function setupPageWidthObserver() {
  teardownPageWidthObserver();

  if (!cropFrameRef.value) {
    return;
  }

  pageWidthObserver = new ResizeObserver(() => {
    syncPdfPageWidth();
  });

  pageWidthObserver.observe(cropFrameRef.value);
  syncPdfPageWidth(true);
}

function getPageElementFromNode(node: Node | null): HTMLElement | null {
  if (!node) return null;

  const pageSelector = '.pdf-vue-page[data-page-number], .page[data-page-number]';

  if (node instanceof HTMLElement) {
    return node.closest(pageSelector) as HTMLElement | null;
  }

  return node.parentElement?.closest(pageSelector) as HTMLElement | null;
}

function getOrderedPages(): HTMLElement[] {
  if (!containerRef.value) return [];
  const pages = Array.from(
    containerRef.value.querySelectorAll('.pdf-vue-page[data-page-number], .page[data-page-number]')
  ) as HTMLElement[];

  // If wrappers are present, prefer them to avoid duplicate ordering with inner vue-pdf pages.
  if (pages.some(page => page.classList.contains('pdf-vue-page'))) {
    return pages.filter(page => page.classList.contains('pdf-vue-page'));
  }

  return pages;
}

function splitRangeByPage(range: Range): Array<{ range: Range; page: HTMLElement; quote: string }> {
  const startPage = getPageElementFromNode(range.startContainer);
  const endPage = getPageElementFromNode(range.endContainer);
  if (!startPage || !endPage) return [];

  if (startPage === endPage) {
    const quote = range.toString().trim();
    return quote ? [{ range: range.cloneRange(), page: startPage, quote }] : [];
  }

  const pagesInOrder = getOrderedPages();
  const startIndex = pagesInOrder.indexOf(startPage);
  const endIndex = pagesInOrder.indexOf(endPage);
  if (startIndex < 0 || endIndex < 0 || startIndex > endIndex) return [];

  const chunks: Array<{ range: Range; page: HTMLElement; quote: string }> = [];

  for (let i = startIndex; i <= endIndex; i += 1) {
    const page = pagesInOrder[i];
    const part = document.createRange();
    const first = page.firstChild;
    const last = page.lastChild;
    if (!first || !last) continue;

    if (i === startIndex) {
      part.setStart(range.startContainer, range.startOffset);
    } else {
      part.setStartBefore(first);
    }

    if (i === endIndex) {
      part.setEnd(range.endContainer, range.endOffset);
    } else {
      part.setEndAfter(last);
    }

    if (part.collapsed) continue;
    const quote = part.toString().trim();
    if (!quote) continue;

    chunks.push({ range: part, page, quote });
  }

  return chunks;
}

function getPrimaryPageCanvas(pageElement: HTMLElement): HTMLCanvasElement | null {
  return pageElement.querySelector('.canvasWrapper canvas')
    || pageElement.querySelector('canvas[role="main"]')
    || pageElement.querySelector('canvas');
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

type RectFragment = {
  left: number;
  top: number;
  width: number;
  height: number;
};

function toRectFragment(input: { left: number; top: number; width: number; height: number }): RectFragment {
  return {
    left: input.left,
    top: input.top,
    width: input.width,
    height: input.height
  };
}

function getRectRight(rect: RectFragment): number {
  return rect.left + rect.width;
}

function getRectBottom(rect: RectFragment): number {
  return rect.top + rect.height;
}

function mergeRectFragmentsByRows(rects: RectFragment[]): RectFragment[] {
  if (!rects.length) {
    return [];
  }

  const normalized = rects
    .filter(rect => rect.width > 0.04 && rect.height > 0.04)
    .map(rect => ({ ...rect }))
    .sort((a, b) => (Math.abs(a.top - b.top) < 0.001 ? a.left - b.left : a.top - b.top));

  const merged: RectFragment[] = [];

  normalized.forEach(rect => {
    const rowTolerance = Math.max(0.65, Math.min(rect.height * 0.42, 8));
    const horizontalGap = Math.max(0.3, Math.min(rect.height * 0.34, 12));

    let target: RectFragment | null = null;
    for (let index = merged.length - 1; index >= 0; index -= 1) {
      const existing = merged[index];
      const existingBottom = getRectBottom(existing);
      const rectBottom = getRectBottom(rect);
      const verticalOverlap = Math.min(existingBottom, rectBottom) - Math.max(existing.top, rect.top);

      if (verticalOverlap <= 0) {
        continue;
      }

      const minHeight = Math.max(1e-6, Math.min(existing.height, rect.height));
      const overlapRatio = verticalOverlap / minHeight;
      const sameRow = Math.abs(existing.top - rect.top) <= rowTolerance || overlapRatio >= 0.42;
      if (!sameRow) {
        continue;
      }

      if (rect.left <= getRectRight(existing) + horizontalGap) {
        target = existing;
        break;
      }
    }

    if (!target) {
      merged.push(rect);
      return;
    }

    const nextLeft = Math.min(target.left, rect.left);
    const nextTop = Math.min(target.top, rect.top);
    const nextRight = Math.max(getRectRight(target), getRectRight(rect));
    const nextBottom = Math.max(getRectBottom(target), getRectBottom(rect));
    target.left = nextLeft;
    target.top = nextTop;
    target.width = nextRight - nextLeft;
    target.height = nextBottom - nextTop;
  });

  return merged.filter((rect, index, all) => {
    const right = getRectRight(rect);
    const bottom = getRectBottom(rect);

    return !all.some((other, otherIndex) => {
      if (otherIndex === index) {
        return false;
      }

      const otherRight = getRectRight(other);
      const otherBottom = getRectBottom(other);
      const withinHorizontal = rect.left >= other.left - 0.08 && right <= otherRight + 0.08;
      const withinVertical = rect.top >= other.top - 0.08 && bottom <= otherBottom + 0.08;
      return withinHorizontal && withinVertical;
    });
  });
}

function getRenderedPageSize(pageNumber: number): { width: number; height: number } {
  const measuredWidth = Number(pdfPageWidth.value || 0);
  const fallbackFrameWidth = Number(cropFrameRef.value?.clientWidth || 0);
  const width = Math.max(220, measuredWidth || fallbackFrameWidth || 820);

  const metrics = pageMetrics.value[pageNumber];
  const ratio = metrics && metrics.width > 0 && metrics.height > 0
    ? metrics.height / metrics.width
    : estimatedPageAspectRatio.value;

  return {
    width,
    height: Math.max(220, width * ratio)
  };
}

function getPageCropLayout(pageNumber: number) {
  const pageSize = getRenderedPageSize(pageNumber);
  const viewportWidth = Number(cropFrameRef.value?.getBoundingClientRect().width || pageSize.width || 0);
  const rawCrop = getResponsiveCropInsetsForViewport(pageNumber, viewportWidth);

  const maxLeft = Math.max(0, pageSize.width - MIN_VISIBLE_PAGE_SIZE);
  const left = Math.min(rawCrop.left, maxLeft);
  const maxRight = Math.max(0, pageSize.width - left - MIN_VISIBLE_PAGE_SIZE);
  const right = Math.min(rawCrop.right, maxRight);

  const maxTop = Math.max(0, pageSize.height - MIN_VISIBLE_PAGE_SIZE);
  const top = Math.min(rawCrop.top, maxTop);
  const maxBottom = Math.max(0, pageSize.height - top - MIN_VISIBLE_PAGE_SIZE);
  const bottom = Math.min(rawCrop.bottom, maxBottom);

  const croppedWidth = Math.max(MIN_VISIBLE_PAGE_SIZE, pageSize.width - left - right);
  const croppedHeight = Math.max(MIN_VISIBLE_PAGE_SIZE, pageSize.height - top - bottom);

  return {
    pageSize,
    crop: { top, right, bottom, left },
    croppedWidth,
    croppedHeight
  };
}

function getPageMaskStyle(pageNumber: number): Record<string, string> {
  const layout = getPageCropLayout(pageNumber);
  return {
    width: `${round2(layout.croppedWidth)}px`,
    height: `${round2(layout.croppedHeight)}px`
  };
}

function getPageContentOffsetStyle(pageNumber: number): Record<string, string> {
  const layout = getPageCropLayout(pageNumber);
  return {
    width: `${round2(layout.pageSize.width)}px`,
    height: `${round2(layout.pageSize.height)}px`,
    transform: `translate(${-round2(layout.crop.left)}px, ${-round2(layout.crop.top)}px)`
  };
}

function getBasePageMetrics(pageNumber: number, pageElement: HTMLElement, canvas: HTMLCanvasElement | null) {
  const existing = pageMetrics.value[pageNumber];
  if (existing) return existing;

  if (canvas && canvas.offsetWidth > 0 && canvas.offsetHeight > 0) {
    return {
      width: canvas.offsetWidth,
      height: canvas.offsetHeight
    };
  }

  const rect = pageElement.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    return {
      width: rect.width,
      height: rect.height
    };
  }

  return null;
}

function rectToQuadpoints(
  rect: { left: number; top: number; width: number; height: number; right?: number; bottom?: number },
  canvasRect: DOMRect,
  metrics: { width: number; height: number }
) {
  if (canvasRect.width <= 0 || canvasRect.height <= 0 || metrics.width <= 0 || metrics.height <= 0) {
    return [] as number[];
  }

  const rectRightPx = typeof rect.right === 'number' ? rect.right : rect.left + rect.width;
  const rectBottomPx = typeof rect.bottom === 'number' ? rect.bottom : rect.top + rect.height;

  const leftRatio = clamp01((rect.left - canvasRect.left) / canvasRect.width);
  const rightRatio = clamp01((rectRightPx - canvasRect.left) / canvasRect.width);
  const topRatio = clamp01((rect.top - canvasRect.top) / canvasRect.height);
  const bottomRatio = clamp01((rectBottomPx - canvasRect.top) / canvasRect.height);

  const leftPoint = round2(metrics.width * leftRatio);
  const rightPoint = round2(metrics.width * rightRatio);
  const bottomPoint = round2(metrics.height * (1 - bottomRatio));
  const topPoint = round2(metrics.height * (1 - topRatio));

  // Keep Recogito-compatible point ordering: BL, BR, TL, TR.
  return [leftPoint, bottomPoint, rightPoint, bottomPoint, leftPoint, topPoint, rightPoint, topPoint];
}

function clearWindowSelection() {
  const selection = window.getSelection();
  selection?.removeAllRanges();
}

const PDF_PUNCTUATION_MAP: Record<string, string> = {
  '﹐': '，',
  '︐': '，',
  '﹑': '、',
  '︑': '、',
  '﹒': '。',
  '．': '。',
  '︒': '。',
  '﹔': '；',
  '︔': '；',
  '﹕': '：',
  '︓': '：',
  '︰': '：',
  '﹖': '？',
  '︖': '？',
  '﹗': '！',
  '︕': '！'
};

function normalizePDFPunctuationForSearch(text: string): string {
  return text.replace(/[﹐︐﹑︑﹒．︒﹔︔﹕︓︰﹖︖﹗︕]/g, (char) => PDF_PUNCTUATION_MAP[char] || char);
}

function normalizePDFTextLayerForSearch(pageNumber: number) {
  const shell = pageShellRefs.get(pageNumber)
    || containerRef.value?.querySelector(`.pdf-vue-page[data-page-number="${pageNumber}"]`) as HTMLElement | null;
  if (!shell) return;

  shell.querySelectorAll('.pdf-search-normalized-alias').forEach((node) => node.remove());

  shell.querySelectorAll('.textLayer span, .textLayer div').forEach((node) => {
    const element = node as HTMLElement;
    const firstTextNode = Array.from(element.childNodes).find((child) => child.nodeType === Node.TEXT_NODE) as Text | undefined;
    const text = firstTextNode?.textContent;
    if (!text) return;

    const normalized = normalizePDFPunctuationForSearch(text);
    if (normalized !== text) {
      firstTextNode.textContent = normalized;
    }
  });
}

function buildSelectionTargetFromCurrentSelection(): { selector: any[] } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;

  const range = selection.getRangeAt(0);
  const common = range.commonAncestorContainer;
  const commonElement = common instanceof Element ? common : common.parentElement;
  if (!commonElement || !containerRef.value?.contains(commonElement)) return null;

  const chunks = splitRangeByPage(range);
  if (!chunks.length) return null;

  const selectors = chunks.map((chunk) => {
    const pageNumber = Number.parseInt(chunk.page.dataset.pageNumber || '0', 10);
    if (!Number.isFinite(pageNumber) || pageNumber <= 0) return null;

    const canvas = getPrimaryPageCanvas(chunk.page);
    if (!canvas) return null;

    const canvasRect = canvas.getBoundingClientRect();
    if (canvasRect.width <= 0 || canvasRect.height <= 0) return null;

    const metrics = getBasePageMetrics(pageNumber, chunk.page, canvas);
    if (!metrics) return null;

    const rawRects = Array.from(chunk.range.getClientRects())
      .filter(rect => rect.width > 0.5 && rect.height > 0.5)
      .map(rect => toRectFragment(rect));

    const mergedRects = mergeRectFragmentsByRows(rawRects);
    const quadpoints = mergedRects.flatMap((rect) => rectToQuadpoints(rect, canvasRect, metrics));
    if (quadpoints.length < 8) return null;

    return {
      pageNumber,
      quadpoints,
      quote: chunk.quote
    };
  }).filter(Boolean) as any[];

  if (!selectors.length) return null;
  return { selector: selectors };
}

function quadpointsToPercentRects(
  quadpoints: number[],
  metrics: { width: number; height: number }
): Array<{ left: number; top: number; width: number; height: number }> {
  const rects: Array<{ left: number; top: number; width: number; height: number }> = [];
  if (!Array.isArray(quadpoints) || quadpoints.length < 8) return rects;
  if (!metrics.width || !metrics.height) return rects;

  for (let i = 0; i + 7 < quadpoints.length; i += 8) {
    const points = quadpoints.slice(i, i + 8);
    if (points.some(point => !Number.isFinite(point))) continue;

    const xs = [points[0], points[2], points[4], points[6]];
    const ys = [points[1], points[3], points[5], points[7]];
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    const left = clamp01(minX / metrics.width) * 100;
    const width = clamp01((maxX - minX) / metrics.width) * 100;
    const top = clamp01(1 - maxY / metrics.height) * 100;
    const height = clamp01((maxY - minY) / metrics.height) * 100;

    if (width <= 0 || height <= 0) continue;
    rects.push({ left, top, width, height });
  }

  return mergeRectFragmentsByRows(rects)
    .map(rect => ({
      left: round2(rect.left),
      top: round2(rect.top),
      width: round2(rect.width),
      height: round2(rect.height)
    }));
}

const renderablePdfAnnotations = computed(() => {
  if (!isNoteSystemActive.value) {
    return [] as Array<{ id: string; color: string; target: { selector: any[] } }>;
  }

  const fromStore = annotationStore.filteredAnnotations
    .filter(annotation => annotation.type === 'pdf')
    .map(annotation => {
      const target = sanitizePdfTarget(annotation.target);
      if (!target) return null;

      return {
        id: annotation.id,
        color: annotation.color || DEFAULT_TAG_COLORS[0],
        target
      };
    })
    .filter(Boolean) as Array<{ id: string; color: string; target: { selector: any[] } }>;

  if (previewAnnotation.value) {
    const previewTarget = sanitizePdfTarget(previewAnnotation.value.target);
    if (previewTarget) {
      fromStore.push({
        id: previewAnnotation.value.id,
        color: previewAnnotation.value.color,
        target: previewTarget
      });
    }
  }

  return fromStore;
});

const pageHighlightMap = computed(() => {
  const map: Record<number, Array<{
    key: string;
    annotationId: string;
    isSelected: boolean;
    kind: 'fill' | 'outline';
    style: Record<string, string>;
  }>> = {};
  const selectedOutlineBuckets = new Map<string, {
    annotationId: string;
    pageNumber: number;
    rects: Array<{ left: number; top: number; width: number; height: number }>;
  }>();

  renderablePdfAnnotations.value.forEach((annotation) => {
    const isSelected = annotationStore.selectedAnnotationId === annotation.id;

    annotation.target.selector.forEach((selector: any, selectorIndex: number) => {
      const pageNumber = selector.pageNumber;
      if (!Number.isFinite(pageNumber) || pageNumber <= 0) return;

      const metrics = pageMetrics.value[pageNumber];
      if (!metrics) return;

      const rects = quadpointsToPercentRects(selector.quadpoints, metrics);
      if (!rects.length) return;

      if (!map[pageNumber]) {
        map[pageNumber] = [];
      }

      rects.forEach((rect, rectIndex) => {
        map[pageNumber].push({
          key: `${annotation.id}-${selectorIndex}-${rectIndex}-fill`,
          annotationId: annotation.id,
          isSelected,
          kind: 'fill',
          style: {
            left: `${rect.left}%`,
            top: `${rect.top}%`,
            width: `${rect.width}%`,
            height: `${rect.height}%`,
            backgroundColor: annotation.color,
            opacity: '1',
            pointerEvents: 'auto'
          }
        });
      });

      if (isSelected && rects.length) {
        const bucketKey = `${annotation.id}@${pageNumber}`;
        const existingBucket = selectedOutlineBuckets.get(bucketKey);
        if (existingBucket) {
          existingBucket.rects.push(...rects);
        } else {
          selectedOutlineBuckets.set(bucketKey, {
            annotationId: annotation.id,
            pageNumber,
            rects: [...rects]
          });
        }
      }
    });
  });

  selectedOutlineBuckets.forEach((bucket) => {
    const { annotationId, pageNumber, rects } = bucket;
    if (!map[pageNumber] || !rects.length) {
      return;
    }

    const minLeft = Math.min(...rects.map(rect => rect.left));
    const minTop = Math.min(...rects.map(rect => rect.top));
    const maxRight = Math.max(...rects.map(rect => rect.left + rect.width));
    const maxBottom = Math.max(...rects.map(rect => rect.top + rect.height));

    map[pageNumber].push({
      key: `${annotationId}-${pageNumber}-outline`,
      annotationId,
      isSelected: true,
      kind: 'outline',
      style: {
        left: `${round2(minLeft)}%`,
        top: `${round2(minTop)}%`,
        width: `${round2(Math.max(0, maxRight - minLeft))}%`,
        height: `${round2(Math.max(0, maxBottom - minTop))}%`,
        backgroundColor: 'transparent',
        pointerEvents: 'none'
      }
    });
  });

  return map;
});

function getHighlightsForPage(pageNumber: number) {
  return pageHighlightMap.value[pageNumber] || [];
}

function handleHighlightClick(annotationId: string, event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();

  if (!isNoteSystemActive.value) {
    return;
  }

  markSelectionInteraction();
  selectKnownAnnotation(annotationId);
  openQuickBubbleForExistingAnnotation(annotationId);
}

function handlePageLoaded(pageNumber: number, viewport: { width?: number; height?: number; scale?: number }) {
  const scale = Number(viewport?.scale || 1);
  const width = Number(viewport?.width || 0);
  const height = Number(viewport?.height || 0);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;

  const baseWidth = scale ? width / scale : width;
  const baseHeight = scale ? height / scale : height;

  const prev = pageMetrics.value[pageNumber];
  if (prev && Math.abs(prev.width - baseWidth) < 0.5 && Math.abs(prev.height - baseHeight) < 0.5) {
    return;
  }

  pageMetrics.value = {
    ...pageMetrics.value,
    [pageNumber]: {
      width: baseWidth,
      height: baseHeight
    }
  };

  scheduleFullPageHeightSync();

  // Normalize punctuation variants in textLayer so browser find can match CJK punctuation reliably.
  requestAnimationFrame(() => normalizePDFTextLayerForSearch(pageNumber));
  window.setTimeout(() => normalizePDFTextLayerForSearch(pageNumber), 80);
}

function handleStageMouseUp(event: MouseEvent) {
  if (!isNoteSystemActive.value) {
    return;
  }

  const target = event.target as Element | null;
  if (target?.closest('.quick-bubble, .pdf-annotation-highlight')) {
    return;
  }

  window.setTimeout(() => {
    const selectionTarget = buildSelectionTargetFromCurrentSelection();
    if (!selectionTarget) {
      return;
    }

    activeAnnotationId.value = null;
    pendingSelection.value = { target: selectionTarget };
    previewAnnotation.value = {
      id: `preview_pdf_${Date.now()}`,
      target: selectionTarget,
      color: selectedColor.value
    };
    quickComment.value = '';
    quickCommentFocused.value = false;
    privacy.value = 'public';

    captureQuickBubbleAnchor();
    positionQuickBubble();
    showQuickBubble.value = true;
    markSelectionInteraction();
    clearWindowSelection();
  }, 0);
}

function handleInternalPDFLinkClick(event: MouseEvent) {
  const target = event.target as Element | null;
  const anchor = target?.closest('.annotationLayer .linkAnnotation a') as HTMLAnchorElement | null;
  if (!anchor) {
    return;
  }

  const href = (anchor.getAttribute('href') || '').trim();
  const isHashOnly = href === '#' || /^https?:\/\/[^#]+#$/i.test(href);
  if (isHashOnly) {
    event.preventDefault();
  }
}

function readReferencedPageFromAnnotationPayload(payload: any): number | null {
  const candidates = [
    payload?.data?.referencedPage,
    payload?.referencedPage,
    payload?.data?.destination?.page,
    payload?.data?.destination?.pageNumber,
    payload?.destination?.page,
    payload?.destination?.pageNumber
  ];

  for (const candidate of candidates) {
    const pageNumber = Number(candidate || 0);
    if (Number.isFinite(pageNumber) && pageNumber > 0) {
      return pageNumber;
    }
  }

  return null;
}

function navigateToPDFPage(pageNumber: number) {
  updateViewportAnchors([pageNumber]);

  requestAnimationFrame(() => {
    const pageShell = pageShellRefs.get(pageNumber);
    if (!pageShell) {
      return;
    }

    if (props.embedMode === 'contained' && containerRef.value) {
      const scroller = containerRef.value;
      const shellRect = pageShell.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      const targetTop = shellRect.top - scrollerRect.top + scroller.scrollTop - 12;
      scroller.scrollTo({
        top: Math.max(0, targetTop),
        behavior: 'smooth'
      });
      return;
    }

    pageShell.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function handleOutlineJump(event: Event) {
  const detail = (event as CustomEvent<PDFOutlineJumpDetail>).detail;
  if (!detail || typeof detail !== 'object') {
    return;
  }

  const nextPage = Number(detail.page || 0);
  if (!Number.isFinite(nextPage) || nextPage <= 0) {
    return;
  }
  navigateToPDFPage(nextPage);
}

function handlePDFAnnotationEvent(currentPageNumber: number, payload: any) {
  if (!payload || typeof payload !== 'object') {
    return;
  }

  const type = String(payload.type || '').toLowerCase();
  if (type && !type.includes('link')) {
    return;
  }

  const referencedPage = readReferencedPageFromAnnotationPayload(payload);
  if (!referencedPage) {
    return;
  }

  if (referencedPage === currentPageNumber) {
    return;
  }

  navigateToPDFPage(referencedPage);
}

function handleStageClick(event: MouseEvent) {
  if (!isNoteSystemActive.value) {
    return;
  }

  const target = event.target as Element | null;
  if (!target) return;

  if (target.closest('.quick-bubble')) return;
  if (target.closest('.pdf-annotation-highlight, [data-annotation-id], [data-id]')) return;

  queueDeselectAnnotation();
}

function handleViewportChange(event?: Event) {
  const isScrollEvent = event?.type === 'scroll';

  if (!event || event.type !== 'scroll') {
    syncPdfPageWidth();
  }

  if (showQuickBubble.value) {
    scheduleQuickBubblePosition();
  }

  // During active scrolling, avoid forcing height updates every frame,
  // otherwise the bottom boundary can keep shifting and feel like "rebound".
  scheduleFullPageHeightSync(!isScrollEvent);
}

function revokeResolvedPDFObjectURL() {
  if (resolvedPDFObjectURL) {
    URL.revokeObjectURL(resolvedPDFObjectURL);
    resolvedPDFObjectURL = null;
  }
}

function buildPDFSourceCandidates(inputSrc: string): string[] {
  const trimmed = inputSrc.trim();
  if (!trimmed) return [];

  const candidates = new Set<string>();
  candidates.add(trimmed);

  if (!/^https?:\/\//i.test(trimmed)) {
    const normalized = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    candidates.add(normalized);

    if (/^\/pdfs\//i.test(normalized)) {
      candidates.add(normalized.replace(/^\/pdfs\//i, '/PDFs/'));
      candidates.add(normalized.replace(/^\/pdfs\//i, '/'));
    } else if (/^\/PDFs\//.test(normalized)) {
      candidates.add(normalized.replace(/^\/PDFs\//, '/'));
      candidates.add(normalized.replace(/^\/PDFs\//, '/pdfs/'));
    } else {
      candidates.add(`/PDFs${normalized}`);
    }
  }

  return Array.from(candidates);
}

async function resolvePdfSourceForAnnotator(): Promise<string> {
  const candidates = buildPDFSourceCandidates(props.src);
  const diagnostics: string[] = [];

  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, { credentials: 'same-origin' });
      if (!response.ok) {
        diagnostics.push(`${candidate} -> HTTP ${response.status}`);
        continue;
      }

      const contentType = response.headers.get('content-type') || '';
      const blob = await response.blob();

      if (!blob.size) {
        diagnostics.push(`${candidate} -> empty response body`);
        continue;
      }

      const headerBuffer = await blob.slice(0, 5).arrayBuffer();
      const header = new TextDecoder('ascii').decode(headerBuffer);

      if (!header.startsWith('%PDF-')) {
        diagnostics.push(`${candidate} -> invalid header ${header} (content-type: ${contentType || 'unknown'})`);
        continue;
      }

      revokeResolvedPDFObjectURL();
      resolvedPDFObjectURL = URL.createObjectURL(blob);
      return resolvedPDFObjectURL;
    } catch (error: any) {
      diagnostics.push(`${candidate} -> ${error?.message || String(error)}`);
    }
  }

  throw new Error(`No valid PDF found. Tried: ${diagnostics.join(' | ')}`);
}

async function refreshPDFSource() {
  const token = ++resolveSourceToken;

  if (!props.src?.trim()) {
    resolvedPDFSource.value = null;
    pageMetrics.value = {};
    return;
  }

  try {
    const source = await resolvePdfSourceForAnnotator();
    if (token !== resolveSourceToken) {
      return;
    }

    pageMetrics.value = {};
    resolvedPDFSource.value = source;
    scheduleFullPageHeightSync(true);
  } catch (e) {
    if (token !== resolveSourceToken) {
      return;
    }

    resolvedPDFSource.value = null;
    pageMetrics.value = {};
    console.error('Failed to resolve PDF source:', e);
  }
}

async function initializeVuePDFClientOnly() {
  if (typeof window === 'undefined') {
    return;
  }

  const module = await import('@tato30/vue-pdf');
  await import('@tato30/vue-pdf/style.css');

  VuePDFComponent.value = module.VuePDF;

  const pdfState = module.usePDF(pdfSource, {
    onError: (error) => {
      console.error('Failed to load PDF document:', error);
    }
  });

  stopPDFSyncWatch?.();
  stopPagesSyncWatch?.();

  stopPDFSyncWatch = watch(pdfState.pdf, (nextPDF) => {
    pdf.value = nextPDF;
  }, { immediate: true });

  stopPagesSyncWatch = watch(pdfState.pages, (nextPages) => {
    pages.value = Number(nextPages || 0);
  }, { immediate: true });
}

function quickHighlight() {
  if (isQuickBubbleReadonly.value) return;
  persistQuickAction('highlight');
}

function submitQuickComment() {
  if (isQuickBubbleReadonly.value) return;
  persistQuickAction('comment');
}

function deleteCurrentAnnotationOrSelection() {
  if (isQuickBubbleReadonly.value) return;

  if (activeAnnotationId.value) {
    annotationStore.deleteAnnotation(activeAnnotationId.value);
  }

  cancelQuickBubble();
}

function setSelectedColor(color: string) {
  if (isQuickBubbleReadonly.value) return;
  selectedColor.value = color;
}

function setQuickPrivacy(nextPrivacy: 'public' | 'private') {
  if (isQuickBubbleReadonly.value) return;
  privacy.value = nextPrivacy;
}

function cancelQuickBubble() {
  if (quickBubbleRepositionRaf) {
    cancelAnimationFrame(quickBubbleRepositionRaf);
    quickBubbleRepositionRaf = 0;
  }

  quickBubbleRepositionLastAt = 0;
  showQuickBubble.value = false;
  pendingSelection.value = null;
  previewAnnotation.value = null;
  quickBubbleAnchorRect.value = null;
  resetQuickBubbleDraft();

  if (copyAutoCloseTimeout) {
    window.clearTimeout(copyAutoCloseTimeout);
    copyAutoCloseTimeout = 0;
  }

  suppressBubbleCloseUntil = 0;
}

function handleDocumentClick(e: MouseEvent) {
  if (!isNoteSystemActive.value) {
    if (showQuickBubble.value) {
      cancelQuickBubble();
    }

    return;
  }

  if (!showQuickBubble.value) return;
  if (Date.now() < suppressBubbleCloseUntil) return;

  const target = e.target as Element | null;
  if (target?.closest('.annotation-item')) {
    cancelQuickBubble();
    return;
  }

  if (target?.closest('.pdf-annotation-highlight, .r6o-annotation, [data-annotation-id], [data-id]')) {
    return;
  }

  const bubble = document.querySelector('.quick-bubble');
  if (bubble && !bubble.contains(e.target as Node)) {
    cancelQuickBubble();
  }
}

function handleSidebarAnnotationCardSelect(event: Event) {
  const detail = (event as CustomEvent<{ annotationId?: string; source?: string }>).detail;
  if (!detail || detail.source !== 'sidebar-card' || !detail.annotationId) {
    return;
  }

  suppressAutoBubbleForSidebarSelectionId = detail.annotationId;
  suppressAutoBubbleForSidebarSelectionUntil = Date.now() + 1200;
}

function handleDocumentKeydown(event: KeyboardEvent) {
  if (!isNoteSystemActive.value || !showQuickBubble.value) {
    return;
  }

  const hasPdfSelection = !!pendingSelection.value?.target?.selector?.some(
    (selector: any) => Number(selector?.pageNumber || 0) > 0
  );
  if (!hasPdfSelection) {
    return;
  }

  const target = event.target as Element | null;
  if (target?.closest('input, textarea, [contenteditable="true"]')) {
    return;
  }

  const isCopyShortcut = (event.ctrlKey || event.metaKey)
    && !event.altKey
    && event.key.toLowerCase() === 'c';

  if (!isCopyShortcut) {
    return;
  }

  event.preventDefault();
  void copySelectedQuote();
}

onMounted(() => {
  void initializeVuePDFClientOnly();
  
  const storedPageNumber = sessionStorage.getItem('pdf_page_number');
  
  if (storedPageNumber) {
    const pageNumber = parseInt(storedPageNumber, 10);
    if (Number.isFinite(pageNumber) && pageNumber > 0) {
      watch(pages, (newPages) => {
        if (newPages >= pageNumber) {
          window.setTimeout(() => {
            navigateToPDFPage(pageNumber);
          }, 500);
          sessionStorage.removeItem('pdf_page_number');
        }
      }, { immediate: true });
    }
  }
  
  void refreshPDFSource();
  
  setupFullPageObserver();
  setupPageWidthObserver();
  requestAnimationFrame(() => {
    setupPageIntersectionObserver();
  });

  document.addEventListener('click', handleDocumentClick);
  document.addEventListener('keydown', handleDocumentKeydown, true);
  document.addEventListener('annotation-card-select', handleSidebarAnnotationCardSelect as EventListener);
  document.addEventListener(PDF_OUTLINE_JUMP_EVENT, handleOutlineJump as EventListener);
  window.addEventListener('resize', handleViewportChange);
  window.addEventListener('scroll', handleViewportChange, true);
  containerRef.value?.addEventListener('click', handleInternalPDFLinkClick, true);
  containerRef.value?.addEventListener('mouseup', handleStageMouseUp, true);
  containerRef.value?.addEventListener('click', handleStageClick, true);
  if (isIOSTouchDevice()) {
    containerRef.value?.addEventListener('contextmenu', handleMobileContextMenu, true);
  }
});

watch(() => buildPdfAnnotationSignature(), () => {
  if (!isNoteSystemActive.value) {
    return;
  }

  scheduleFullPageHeightSync();
});

watch(() => annotationStore.selectedAnnotationId, (selectedId, previousId) => {
  if (!isNoteSystemActive.value) {
    return;
  }

  if (selectedId === previousId) return;
  if (!selectedId) return;

  const selected = annotationStore.annotations.find(annotation => annotation.id === selectedId);
  if (!selected || selected.type !== 'pdf') return;

  const shouldSuppressAutoOpen =
    suppressAutoBubbleForSidebarSelectionId === selectedId
    && Date.now() < suppressAutoBubbleForSidebarSelectionUntil;

  if (shouldSuppressAutoOpen) {
    suppressAutoBubbleForSidebarSelectionId = null;
  }

  requestAnimationFrame(() => {
    const match = collectPDFAnnotationElement(selectedId);
    if (match) {
      match.scrollIntoView({ behavior: 'smooth', block: 'center' });
      captureQuickBubbleAnchorFromElement(match);
    } else {
      const firstPage = Number(selected.target?.selector?.[0]?.pageNumber || 0);
      if (Number.isFinite(firstPage) && firstPage > 0) {
        navigateToPDFPage(firstPage);
      }
    }

    if (shouldSuppressAutoOpen) {
      return;
    }

    if (!showQuickBubble.value || activeAnnotationId.value !== selectedId) {
      openQuickBubbleForExistingAnnotation(selectedId);
    }
  });
});

watch(() => selectedColor.value, () => {
  if (!isNoteSystemActive.value) {
    return;
  }

  if (previewAnnotation.value) {
    previewAnnotation.value = {
      ...previewAnnotation.value,
      color: selectedColor.value
    };
  }
});

watch(() => annotationStore.pageNotesEnabled, (enabled) => {
  if (enabled) {
    return;
  }

  cancelQuickBubble();
  clearWindowSelection();
  previewAnnotation.value = null;
  pendingSelection.value = null;
  activeAnnotationId.value = null;
});

watch(() => props.embedMode, () => {
  if (props.embedMode === 'fullpage') {
    setupFullPageObserver();
  } else {
    teardownFullPageObserver();
  }

  scheduleFullPageHeightSync(true);
  syncPdfPageWidth(true);
  requestAnimationFrame(() => {
    setupPageIntersectionObserver();
  });
});

watch(() => getCropSignature(), () => {
  syncPdfPageWidth(true);
  scheduleFullPageHeightSync(true);
});

watch(() => `${props.lazyRootMargin}|${props.lazyPageBuffer}`, () => {
  requestAnimationFrame(() => {
    setupPageIntersectionObserver();
  });
});

watch(() => props.src, async () => {
  cancelQuickBubble();
  clearWindowSelection();
  revokeResolvedPDFObjectURL();
  await refreshPDFSource();
});

watch(() => pageNumbers.value.length, () => {
  updateViewportAnchors([1]);
  scheduleFullPageHeightSync(true);
  requestAnimationFrame(() => {
    setupPageIntersectionObserver();
  });
});

onUnmounted(() => {
  document.removeEventListener('click', handleDocumentClick);
  document.removeEventListener('keydown', handleDocumentKeydown, true);
  document.removeEventListener('annotation-card-select', handleSidebarAnnotationCardSelect as EventListener);
  document.removeEventListener(PDF_OUTLINE_JUMP_EVENT, handleOutlineJump as EventListener);
  window.removeEventListener('resize', handleViewportChange);
  window.removeEventListener('scroll', handleViewportChange, true);
  containerRef.value?.removeEventListener('click', handleInternalPDFLinkClick, true);
  containerRef.value?.removeEventListener('mouseup', handleStageMouseUp, true);
  containerRef.value?.removeEventListener('click', handleStageClick, true);
  if (isIOSTouchDevice()) {
    containerRef.value?.removeEventListener('contextmenu', handleMobileContextMenu, true);
  }
  teardownFullPageObserver();
  teardownPageWidthObserver();
  teardownPageIntersectionObserver();
  pageShellRefs.clear();

  if (copyFeedbackTimeout) {
    window.clearTimeout(copyFeedbackTimeout);
    copyFeedbackTimeout = 0;
  }

  if (copyAutoCloseTimeout) {
    window.clearTimeout(copyAutoCloseTimeout);
    copyAutoCloseTimeout = 0;
  }

  if (deselectTimeout) {
    window.clearTimeout(deselectTimeout);
    deselectTimeout = 0;
  }

  stopPDFSyncWatch?.();
  stopPagesSyncWatch?.();
  stopPDFSyncWatch = null;
  stopPagesSyncWatch = null;

  if (quickBubbleRepositionRaf) {
    cancelAnimationFrame(quickBubbleRepositionRaf);
    quickBubbleRepositionRaf = 0;
  }

  revokeResolvedPDFObjectURL();
});
</script>

<template>
  <div
    class="pdf-viewer-container not-annotatable"
    :class="[
      `pdf-mode-${props.embedMode}`,
      {
        'show-crop-guides': props.showCropGuides,
        'show-page-separators': props.showPageSeparators,
        'hide-border': !props.showBorder
      }
    ]"
    :style="props.embedMode === 'contained'
      ? { '--pdf-embed-height': props.height, '--pdf-page-background': props.background, '--annotation-selection-color': selectedColor }
      : { '--pdf-full-height': fullPageHeight, '--pdf-page-background': props.background, '--annotation-selection-color': selectedColor }"
  >
    <div ref="cropFrameRef" class="pdf-crop-frame">
      <div ref="containerRef" class="pdf-annotator-stage">
        <div class="pdf-vue-pages">
          <div
            v-for="pageNumber in pageNumbers"
            :key="`pdf-page-${pageNumber}`"
            class="pdf-vue-page"
            :data-page-number="pageNumber"
            :data-page-parity="pageNumber % 2 === 0 ? 'even' : 'odd'"
            :ref="(el) => setPageShellRef(pageNumber, el as Element | null)"
          >
            <div class="pdf-page-crop-mask" :style="getPageMaskStyle(pageNumber)">
              <div class="pdf-page-crop-content" :style="getPageContentOffsetStyle(pageNumber)">
                <component
                  :is="VuePDFComponent"
                  v-if="VuePDFComponent && shouldRenderPage(pageNumber)"
                  :pdf="pdf"
                  :page="pageNumber"
                  :width="pdfPageWidth"
                  text-layer
                  annotation-layer
                  @annotation="(payload) => handlePDFAnnotationEvent(pageNumber, payload)"
                  @loaded="(viewport) => handlePageLoaded(pageNumber, viewport)"
                />

                <div v-else class="pdf-page-lazy-placeholder" aria-hidden="true">
                  <span>第 {{ pageNumber }} 页按需加载中</span>
                </div>

                <div v-if="shouldRenderPage(pageNumber) && isNoteSystemActive" class="pdf-page-highlight-layer" aria-hidden="true">
                  <div
                    v-for="highlight in getHighlightsForPage(pageNumber)"
                    :key="highlight.key"
                    class="pdf-annotation-highlight"
                    :class="{
                      'pdf-annotation-highlight-outline': highlight.kind === 'outline' && highlight.isSelected,
                      'annotation-selected-outline-box': highlight.kind === 'outline' && highlight.isSelected
                    }"
                    :data-annotation-id="highlight.annotationId"
                    :data-id="highlight.annotationId"
                    :style="highlight.style"
                    @mousedown.prevent
                    @click="(event) => handleHighlightClick(highlight.annotationId, event)"
                  ></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div
    v-if="showQuickBubble && isNoteSystemActive"
    class="quick-bubble"
    :class="{ 'readonly-note': isQuickBubbleReadonly }"
    :style="{ left: quickBubblePosition.x + 'px', top: quickBubblePosition.y + 'px' }"
  >
    <div class="quick-bubble-row quick-bubble-row-primary">
      <button class="quick-bubble-btn highlight" @mousedown.prevent @click="quickHighlight">
        高亮
      </button>

      <div class="quick-bubble-colors">
        <div
          v-for="color in DEFAULT_TAG_COLORS"
          :key="color"
          class="quick-bubble-color"
          :class="{ selected: selectedColor === color }"
          :style="{ backgroundColor: color }"
          @mousedown.prevent
          @click="setSelectedColor(color)"
        ></div>
      </div>

      <button class="quick-bubble-btn copy" :class="{ copied: copyFeedbackVisible }" @mousedown.prevent @click="copySelectedQuote">
        <span class="copy-icon" aria-hidden="true">{{ copyFeedbackVisible ? '✓' : '⧉' }}</span>
        <span v-if="!copyFeedbackVisible">复制</span>
      </button>
    </div>

    <div class="quick-bubble-divider"></div>

    <div class="quick-bubble-row quick-bubble-row-secondary">
      <button class="quick-bubble-btn comment" @mousedown.prevent @click="submitQuickComment">
        笔记
      </button>

      <div class="quick-privacy-toggle" :class="{ 'is-private': privacy === 'private' }">
        <button
          class="quick-privacy-btn"
          :class="{ active: privacy === 'public' }"
          @mousedown.prevent
          @click="setQuickPrivacy('public')"
        >
          公开
        </button>
        <button
          class="quick-privacy-btn"
          :class="{ active: privacy === 'private' }"
          @mousedown.prevent
          @click="setQuickPrivacy('private')"
        >
          私密
        </button>
      </div>

      <button class="quick-bubble-icon-btn" aria-label="删除当前标注" title="删除" @mousedown.prevent @click="deleteCurrentAnnotationOrSelection">
        <svg class="trash-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M9 3.5h6m-9 3h12m-1 0-.8 11.1a1.5 1.5 0 0 1-1.5 1.4H9.3a1.5 1.5 0 0 1-1.5-1.4L7 6.5m3 3.5v5.2m4-5.2v5.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
      </button>
    </div>
    <div class="quick-bubble-comment" :class="{ expanded: quickCommentFocused || !!quickComment.trim() }">
      <textarea
        v-model="quickComment"
        class="quick-bubble-comment-input"
        placeholder="请输入笔记（可选）"
        :disabled="isQuickBubbleReadonly"
        @focus="quickCommentFocused = true"
        @blur="quickCommentFocused = false"
      ></textarea>
    </div>
  </div>
</template>
