<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch, nextTick, computed } from 'vue';
import { useRoute } from 'vitepress';
import { useUserStore } from '../stores/userStore';
import { useAnnotationStore } from '../stores/annotationStore';
import { useAnnotationConfig } from '../utils/useAnnotationConfig';
import { DEFAULT_TAG_COLORS } from '../utils/types';
import type { Annotation } from '../utils/types';
import { copyTextToClipboard } from '../utils/clipboard';
import '@recogito/text-annotator/text-annotator.css';

function debounce<T extends (...args: any[]) => any>(fn: T, delay: number): (...args: Parameters<T>) => void {
  let timer: number | null = null;
  return (...args: Parameters<T>) => {
    if (timer !== null) {
      window.clearTimeout(timer);
    }
    timer = window.setTimeout(() => {
      fn(...args);
      timer = null;
    }, delay);
  };
}

function throttle<T extends (...args: any[]) => any>(fn: T, delay: number): (...args: Parameters<T>) => void {
  let lastTime = 0;
  let timer: number | null = null;
  return (...args: Parameters<T>) => {
    const now = Date.now();
    if (now - lastTime >= delay) {
      lastTime = now;
      fn(...args);
    } else if (timer === null) {
      timer = window.setTimeout(() => {
        lastTime = Date.now();
        fn(...args);
        timer = null;
      }, delay - (now - lastTime));
    }
  };
}

const route = useRoute();
const userStore = useUserStore();
const annotationStore = useAnnotationStore();
const { config } = useAnnotationConfig();

let annotator: any = null;
const showQuickBubble = ref(false);
const quickBubblePosition = ref({ x: 0, y: 0 });
const pendingSelection = ref<{ target: Annotation['target'] } | null>(null);
const activeAnnotationId = ref<string | null>(null);
const selectedColor = ref(DEFAULT_TAG_COLORS[0]);
const quickBubbleAnchorRect = ref<{ left: number; top: number; width: number; height: number } | null>(null);
const copyFeedbackVisible = ref(false);
let copyFeedbackTimeout = 0;
let copyAutoCloseTimeout = 0;
const quickComment = ref('');
const quickCommentFocused = ref(false);
let selectedVisualSyncRaf = 0;
const QUICK_BUBBLE_REPOSITION_MIN_INTERVAL = 48;
let quickBubbleRepositionRaf = 0;
let quickBubbleRepositionLastAt = 0;

function scheduleSelectedVisualSync() {
  if (selectedVisualSyncRaf) {
    return;
  }

  selectedVisualSyncRaf = requestAnimationFrame(() => {
    selectedVisualSyncRaf = 0;
    syncSelectedAnnotationVisual(annotationStore.selectedAnnotationId);
  });
}
const privacy = ref<'public' | 'private'>('public');
const ACTIVE_ANNOTATION_CLASS = 'annotation-selected-highlight';
const LAST_SELECTION_COLOR_STORAGE_KEY = 'annotation:last-selected-color';

function isKnownTagColor(color: string | null | undefined): color is string {
  return !!color && DEFAULT_TAG_COLORS.includes(color);
}

function readStoredSelectionColor(): string | null {
  if (typeof window === 'undefined') return null;

  try {
    const raw = window.localStorage.getItem(LAST_SELECTION_COLOR_STORAGE_KEY);
    return isKnownTagColor(raw) ? raw : null;
  } catch {
    return null;
  }
}

function persistSelectionColor(color: string) {
  if (typeof window === 'undefined' || !isKnownTagColor(color)) return;

  try {
    window.localStorage.setItem(LAST_SELECTION_COLOR_STORAGE_KEY, color);
  } catch {
    // Ignore storage write failures (e.g. privacy mode).
  }
}

const currentQuickAnnotation = computed(() => {
  if (!activeAnnotationId.value) return null;
  return annotationStore.annotations.find(annotation => annotation.id === activeAnnotationId.value) || null;
});

const isQuickBubbleReadonly = computed(() => {
  if (!currentQuickAnnotation.value?.creator?.id) return false;
  return currentQuickAnnotation.value.creator.id !== userStore.currentUser?.id;
});

let contentRoot: HTMLElement | null = null;
let contentObserver: MutationObserver | null = null;
let contentSyncTimeout = 0;
let initRetryTimeout = 0;
let loadReplayTimeouts: number[] = [];
let deselectTimeout = 0;
let suppressDeselectUntil = 0;
let suppressBubbleCloseUntil = 0;
let selectedOutlineBoxEl: HTMLDivElement | null = null;

function applyTextSelectionColorVariable(color: string) {
  const root = (contentRoot || document.querySelector('.vp-doc')) as HTMLElement | null;
  if (!root) return;
  root.style.setProperty('--text-selection-color', color);
}

function clearTextSelectionColorVariable() {
  const root = (contentRoot || document.querySelector('.vp-doc')) as HTMLElement | null;
  root?.style.removeProperty('--text-selection-color');
}

function isInsidePDFRegion(node: Node | null): boolean {
  if (!node) return false;

  if (node instanceof Element) {
    return !!node.closest('.pdf-viewer-container, .pdf-annotator-stage');
  }

  return !!node.parentElement?.closest('.pdf-viewer-container, .pdf-annotator-stage');
}

function isInsideRecogitoLayer(node: Node | null): boolean {
  if (!node) return false;

  if (node instanceof Element) {
    return !!node.closest('.r6o-span-highlight-layer, .r6o-annotation, .r6o-presence-layer, .r6o-canvas-highlight-layer');
  }

  return !!node.parentElement?.closest('.r6o-span-highlight-layer, .r6o-annotation, .r6o-presence-layer, .r6o-canvas-highlight-layer');
}

function isSelectionInsidePDFRegion(): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;

  const range = selection.getRangeAt(0);
  return isInsidePDFRegion(range.commonAncestorContainer)
    || isInsidePDFRegion(selection.anchorNode)
    || isInsidePDFRegion(selection.focusNode);
}

function getCurrentPageTextWithoutPDF(): string {
  const root = document.querySelector('.vp-doc');
  if (!root) return '';

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = '';
  let current = walker.nextNode();

  while (current) {
    if (!isInsidePDFRegion(current)) {
      text += current.nodeValue || '';
    }
    current = walker.nextNode();
  }

  return text;
}

function clearLoadReplayTimeouts() {
  loadReplayTimeouts.forEach(id => window.clearTimeout(id));
  loadReplayTimeouts = [];
}

function teardownAnnotatorInstance() {
  clearTextSelectionColorVariable();
  contentRoot?.removeEventListener('click', handleContentAnnotationClick, true);
  contentRoot?.removeEventListener('contextmenu', handleMobileContextMenu, true);
  contentRoot?.removeEventListener('pointermove', handleRecogitoPointerMove, true);
  contentRoot?.classList.remove('native-selection-active');
  contentRoot = null;

  if (annotator) {
    annotator.destroy();
    annotator = null;
  }

  teardownContentObserver();
  clearLoadReplayTimeouts();

  showQuickBubble.value = false;
  pendingSelection.value = null;
  quickBubbleAnchorRect.value = null;
  resetQuickBubbleDraft();
}

function scheduleLoadReplays() {
  if (!annotator) return;

  clearLoadReplayTimeouts();
  const timeoutId = window.setTimeout(() => {
    loadAnnotationsToRecogito();
  }, 90);
  loadReplayTimeouts.push(timeoutId);
}

function teardownContentObserver() {
  if (contentObserver) {
    contentObserver.disconnect();
    contentObserver = null;
  }

  if (contentSyncTimeout) {
    window.clearTimeout(contentSyncTimeout);
    contentSyncTimeout = 0;
  }
}

function setupContentObserver() {
  teardownContentObserver();
  if (!contentRoot) return;

  contentObserver = new MutationObserver((mutations) => {
    const hasRecogitoMutation = mutations.some((mutation) => {
      const changedNodes: Node[] = [
        mutation.target,
        ...Array.from(mutation.addedNodes),
        ...Array.from(mutation.removedNodes)
      ];

      return changedNodes.some((node) => !isInsidePDFRegion(node) && isInsideRecogitoLayer(node));
    });

    const hasRelevantMutation = mutations.some((mutation) => {
      const changedNodes: Node[] = [
        mutation.target,
        ...Array.from(mutation.addedNodes),
        ...Array.from(mutation.removedNodes)
      ];

      return changedNodes.some((node) => !isInsidePDFRegion(node) && !isInsideRecogitoLayer(node));
    });

    if (!hasRelevantMutation) {
      if (hasRecogitoMutation && annotationStore.selectedAnnotationId) {
        scheduleSelectedVisualSync();
      }

      return;
    }

    if (contentSyncTimeout) {
      window.clearTimeout(contentSyncTimeout);
    }
    contentSyncTimeout = window.setTimeout(() => {
      loadAnnotationsToRecogito();
      contentSyncTimeout = 0;
    }, 140);
  });

  contentObserver.observe(contentRoot, {
    subtree: true,
    childList: true,
    characterData: true
  });
}

function deepCopyTarget<T>(target: T): T {
  return JSON.parse(JSON.stringify(target));
}

function resolveAnnotationId(payload: any): string | null {
  if (!payload) return null;
  if (typeof payload === 'string') return payload;
  if (Array.isArray(payload)) return resolveAnnotationId(payload[0]);
  if (typeof payload.id === 'string') return payload.id;
  if (typeof payload.annotation?.id === 'string') return payload.annotation.id;
  return null;
}

function resolveAnnotationIdFromElement(element: Element | null): string | null {
  if (!element) return null;

  const directId = element.getAttribute('data-annotation-id')
    || element.getAttribute('data-id')
    || element.getAttribute('data-annotation');
  if (directId) return directId;

  const ancestor = element.closest('[data-annotation-id], [data-id], [data-annotation]');
  const ancestorId = ancestor?.getAttribute('data-annotation-id')
    || ancestor?.getAttribute('data-id')
    || ancestor?.getAttribute('data-annotation');
  if (ancestorId) return ancestorId;

  const nested = element.querySelector('[data-annotation-id], [data-id], [data-annotation]');
  const nestedId = nested?.getAttribute('data-annotation-id')
    || nested?.getAttribute('data-id')
    || nested?.getAttribute('data-annotation');
  if (nestedId) return nestedId;

  return null;
}

function collectAnnotationElements(annotationId: string): Element[] {
  const selectors = [
    `.vp-doc [data-annotation-id="${annotationId}"]`,
    `.vp-doc [data-id="${annotationId}"]`,
    `.vp-doc [data-annotation="${annotationId}"]`,
    `.r6o-annotation[data-annotation-id="${annotationId}"]`,
    `.r6o-annotation[data-id="${annotationId}"]`,
    `.r6o-annotation[data-annotation="${annotationId}"]`,
    `.r6o-annotation [data-annotation-id="${annotationId}"]`,
    `.r6o-annotation [data-id="${annotationId}"]`,
    `.r6o-annotation [data-annotation="${annotationId}"]`
  ];

  const seen = new Set<Element>();
  selectors.forEach(selector => {
    document.querySelectorAll(selector).forEach(el => seen.add(el));
  });

  // Recogito structures can differ across browsers/builds; resolve IDs dynamically too.
  document.querySelectorAll('.r6o-annotation').forEach((el) => {
    if (!isInsidePDFRegion(el) && resolveAnnotationIdFromElement(el) === annotationId) {
      seen.add(el);
    }
  });

  document
    .querySelectorAll('.r6o-annotation [data-annotation-id], .r6o-annotation [data-id], .r6o-annotation [data-annotation]')
    .forEach((el) => {
      if (!isInsidePDFRegion(el) && resolveAnnotationIdFromElement(el) === annotationId) {
        seen.add(el);
        const host = el.closest('.r6o-annotation');
        if (host && !isInsidePDFRegion(host)) {
          seen.add(host);
        }
      }
    });

  const all = Array.from(seen);

  // Keep only top-level matched elements so we do not paint duplicate selected frames.
  return all.filter((element) => {
    return !all.some((candidate) => candidate !== element && candidate.contains(element));
  });
}

function clearSelectedAnnotationVisual() {
  document
    .querySelectorAll(`.${ACTIVE_ANNOTATION_CLASS}`)
    .forEach(el => el.classList.remove(ACTIVE_ANNOTATION_CLASS));

  if (selectedOutlineBoxEl) {
    selectedOutlineBoxEl.remove();
    selectedOutlineBoxEl = null;
  }
}

function renderSelectedAnnotationOutline(elements: Element[]) {
  const rects = elements
    .map((element) => element.getBoundingClientRect())
    .filter((rect) => rect.width > 0.5 && rect.height > 0.5);

  if (!rects.length) {
    if (selectedOutlineBoxEl) {
      selectedOutlineBoxEl.remove();
      selectedOutlineBoxEl = null;
    }
    return;
  }

  const minLeft = Math.min(...rects.map((rect) => rect.left));
  const minTop = Math.min(...rects.map((rect) => rect.top));
  const maxRight = Math.max(...rects.map((rect) => rect.right));
  const maxBottom = Math.max(...rects.map((rect) => rect.bottom));

  if (!selectedOutlineBoxEl) {
    selectedOutlineBoxEl = document.createElement('div');
    selectedOutlineBoxEl.className = 'annotation-selected-outline-box text-annotation-selected-outline-box';
    document.body.appendChild(selectedOutlineBoxEl);
  }

  selectedOutlineBoxEl.style.left = `${minLeft}px`;
  selectedOutlineBoxEl.style.top = `${minTop}px`;
  selectedOutlineBoxEl.style.width = `${Math.max(0, maxRight - minLeft)}px`;
  selectedOutlineBoxEl.style.height = `${Math.max(0, maxBottom - minTop)}px`;
}

function syncSelectedAnnotationVisual(annotationId: string | null) {
  const currentlySelected = new Set(
    Array.from(document.querySelectorAll(`.${ACTIVE_ANNOTATION_CLASS}`))
  );

  const shouldHideSelectionOutline = contentRoot?.classList.contains('native-selection-active')
    || (!!pendingSelection.value && !activeAnnotationId.value);

  if (shouldHideSelectionOutline) {
    currentlySelected.forEach((el) => el.classList.remove(ACTIVE_ANNOTATION_CLASS));
    if (selectedOutlineBoxEl) {
      selectedOutlineBoxEl.remove();
      selectedOutlineBoxEl = null;
    }
    return;
  }

  if (!annotationId) {
    currentlySelected.forEach((el) => el.classList.remove(ACTIVE_ANNOTATION_CLASS));
    if (selectedOutlineBoxEl) {
      selectedOutlineBoxEl.remove();
      selectedOutlineBoxEl = null;
    }
    return;
  }

  const nextSelected = new Set(collectAnnotationElements(annotationId));

  currentlySelected.forEach((el) => {
    if (!nextSelected.has(el)) {
      el.classList.remove(ACTIVE_ANNOTATION_CLASS);
    }
  });

  nextSelected.forEach((el) => {
    if (!el.classList.contains(ACTIVE_ANNOTATION_CLASS)) {
      el.classList.add(ACTIVE_ANNOTATION_CLASS);
    }
  });

  renderSelectedAnnotationOutline(Array.from(nextSelected));
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

function clearNativeSelection() {
  window.getSelection()?.removeAllRanges();
  updateNativeSelectionActiveState();
}

function updateNativeSelectionActiveState() {
  const selection = window.getSelection();
  const hasSelection = !!selection && selection.rangeCount > 0 && !selection.isCollapsed;

  if (!contentRoot) {
    return;
  }

  if (!hasSelection) {
    contentRoot.classList.remove('native-selection-active');
    return;
  }

  const range = selection!.getRangeAt(0);
  const relatedNodes: Array<Node | null> = [
    selection!.anchorNode,
    selection!.focusNode,
    range.commonAncestorContainer
  ];

  const insideDoc = relatedNodes.some((node) => {
    if (!node) return false;
    if (node instanceof Element) {
      return !!node.closest('.vp-doc');
    }
    return !!node.parentElement?.closest('.vp-doc');
  });

  const insidePdf = relatedNodes.some((node) => isInsidePDFRegion(node));
  const nativeSelectingInDoc = insideDoc && !insidePdf;
  contentRoot.classList.toggle('native-selection-active', nativeSelectingInDoc);

  // While creating a new text selection, clear prior selected annotation frame.
  if (nativeSelectingInDoc && annotationStore.selectedAnnotationId) {
    annotationStore.selectAnnotation(null);
  }
}

function handleSelectionChange() {
  updateNativeSelectionActiveState();
}

function handleRecogitoPointerMove(event: Event) {
  if (!annotationStore.selectedAnnotationId) {
    return;
  }

  const target = event.target as Element | null;
  if (!target) {
    return;
  }

  if (!target.closest('.r6o-span-highlight-layer, .r6o-annotation')) {
    return;
  }

  scheduleSelectedVisualSync();
}

function getSelectedQuoteText() {
  return pendingSelection.value?.target?.selector?.[0]?.quote?.trim() || '';
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
    console.error('Failed to copy selected quote:', error);
  }
}

function handleContentAnnotationClick(event: MouseEvent) {
  const target = event.target as Element | null;
  if (!target) return;
  if (target.closest('.pdf-viewer-container, .pdf-annotator-stage')) return;

  const marker = target.closest('[data-annotation-id], [data-id], .r6o-annotation');
  const annotationId = resolveAnnotationIdFromElement(marker);
  if (!annotationId) return;

  markSelectionInteraction();
  selectKnownAnnotation(annotationId);
  openQuickBubbleForExistingAnnotation(annotationId, marker as Element | null);
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
    const anchorElement = collectAnnotationElements(activeAnnotationId.value)[0] || null;
    captureQuickBubbleAnchorFromElement(anchorElement);
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

  quickBubblePosition.value = {
    x,
    y
  };
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

function openQuickBubbleForExistingAnnotation(annotationId: string, anchorElement: Element | null = null) {
  const annotation = annotationStore.annotations.find(a => a.id === annotationId && a.type === 'text');
  if (!annotation) {
    return;
  }

  activeAnnotationId.value = annotation.id;
  pendingSelection.value = {
    target: deepCopyTarget(annotation.target)
  };
  selectedColor.value = annotation.color || DEFAULT_TAG_COLORS[0];
  quickComment.value = annotation.bodies[0]?.value || '';
  privacy.value = annotation.privacy || 'public';
  quickCommentFocused.value = false;

  if (anchorElement) {
    captureQuickBubbleAnchorFromElement(anchorElement);
  } else {
    captureQuickBubbleAnchorFromElement(collectAnnotationElements(annotationId)[0] || null);
  }

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

  annotationStore.updateAnnotation(current.id, {
    target: deepCopyTarget(pendingSelection.value?.target || current.target),
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

  annotationStore.addAnnotation(
    'text',
    pendingSelection.value.target,
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
  quickBubbleAnchorRect.value = null;
  clearNativeSelection();
  resetQuickBubbleDraft();

  setTimeout(() => {
    loadAnnotationsToRecogito();
  }, 0);
}

function resolveTextTargetWithFuzzy(target: Annotation['target'], pageText: string) {
  if (!target?.selector || !Array.isArray(target.selector) || !pageText) {
    return { target, changed: false };
  }

  const quoteSelector = target.selector.find(s => typeof s.quote === 'string' && s.quote.trim().length > 0);
  const quote = quoteSelector?.quote?.trim();
  if (!quote) {
    return { target, changed: false };
  }

  const positionSelector = target.selector.find(s => typeof s.start === 'number' && typeof s.end === 'number');
  const oldStart = typeof positionSelector?.start === 'number' ? positionSelector.start : null;
  const oldEnd = typeof positionSelector?.end === 'number' ? positionSelector.end : null;

  if (oldStart !== null && oldEnd !== null && pageText.slice(oldStart, oldEnd) === quote) {
    return { target, changed: false };
  }

  let nextStart = -1;

  if (oldStart !== null) {
    const windowStart = Math.max(0, oldStart - 2500);
    const windowEnd = Math.min(pageText.length, oldStart + quote.length + 2500);
    const windowText = pageText.slice(windowStart, windowEnd);
    const nearbyIndex = windowText.indexOf(quote);

    if (nearbyIndex !== -1) {
      nextStart = windowStart + nearbyIndex;
    }
  }

  if (nextStart === -1) {
    const exactIndex = pageText.indexOf(quote);
    if (exactIndex !== -1) {
      nextStart = exactIndex;
    }
  }

  // Fuzzy matching is intentionally disabled for performance/stability.
  // Keep this block commented for potential future re-enable.
  // if (nextStart === -1) {
  //   const fuzzyMatch = findBestMatchWithDMP(pageText, quote, 0.72);
  //   if (fuzzyMatch) {
  //     nextStart = fuzzyMatch.start;
  //   }
  // }

  if (nextStart === -1) {
    return { target, changed: false };
  }

  const nextEnd = nextStart + quote.length;
  const nextTarget = deepCopyTarget(target);

  if (!Array.isArray(nextTarget.selector)) {
    nextTarget.selector = [];
  }

  let hasPositionSelector = false;

  nextTarget.selector = nextTarget.selector.map(selector => {
    const nextSelector = { ...selector };
    if (typeof nextSelector.start === 'number' || typeof nextSelector.end === 'number') {
      nextSelector.start = nextStart;
      nextSelector.end = nextEnd;
      hasPositionSelector = true;
    }
    return nextSelector;
  });

  if (!hasPositionSelector) {
    nextTarget.selector.push({
      quote,
      start: nextStart,
      end: nextEnd
    });
  }

  const changed = oldStart !== nextStart || oldEnd !== nextEnd;
  return { target: nextTarget, changed };
}

async function initAnnotator() {
  const content = document.querySelector('.vp-doc');
  if (!content) return;

  applyTextSelectionColorVariable(selectedColor.value);

  try {
    const { createTextAnnotator } = await import('@recogito/text-annotator');

    annotator = createTextAnnotator(content, {
      renderer: 'SPANS',
      style: (annotation: any) => {
        const ourAnnotation = annotationStore.annotations.find(a => a.id === annotation.id);
        return {
          fill: ourAnnotation?.color || selectedColor.value,
          fillOpacity: 1,
          stroke: 'transparent',
          strokeWidth: 0,
          strokeDasharray: 'none'
        };
      },
      dismissOnNotAnnotatable: (event: Event) => {
        const target = event.target as Element | null;
        return !!target?.closest('.pdf-viewer-container, .pdf-annotator-stage');
      }
    });

    contentRoot?.removeEventListener('click', handleContentAnnotationClick, true);
    contentRoot?.removeEventListener('contextmenu', handleMobileContextMenu, true);
    contentRoot?.removeEventListener('pointermove', handleRecogitoPointerMove, true);
    contentRoot = content as HTMLElement;
    contentRoot.addEventListener('click', handleContentAnnotationClick, true);
    if (isIOSTouchDevice()) {
      contentRoot.addEventListener('contextmenu', handleMobileContextMenu, true);
    }
    contentRoot.addEventListener('pointermove', handleRecogitoPointerMove, true);
    setupContentObserver();

    annotator.on('createAnnotation', async (selection: any) => {
      if (!selection?.target) return;

      if (isSelectionInsidePDFRegion()) {
        annotator.cancelSelected();
        return;
      }

      activeAnnotationId.value = null;
      pendingSelection.value = {
        target: deepCopyTarget(selection.target)
      };
      quickComment.value = '';
      quickCommentFocused.value = false;
      privacy.value = 'public';

      captureQuickBubbleAnchor();
      clearNativeSelection();
      await nextTick();
      positionQuickBubble();

      if (annotator?.cancelSelected) {
        annotator.cancelSelected();
      }

      showQuickBubble.value = true;
    });

    annotator.on('selectAnnotation', (payload: any) => {
      const selectedId = resolveAnnotationId(payload);
      if (!selectedId) return;
      markSelectionInteraction();
      selectKnownAnnotation(selectedId);
      openQuickBubbleForExistingAnnotation(selectedId);
    });

    annotator.on('clickAnnotation', (payload: any) => {
      const selectedId = resolveAnnotationId(payload);
      if (!selectedId) return;
      markSelectionInteraction();
      selectKnownAnnotation(selectedId);
      openQuickBubbleForExistingAnnotation(selectedId);
    });

    annotator.on('selectionChanged', (payload: any) => {
      const selectedId = resolveAnnotationId(payload);
      if (selectedId) {
        markSelectionInteraction();
        selectKnownAnnotation(selectedId);
      } else {
        queueDeselectAnnotation();
      }
    });

    annotator.on('deselectAnnotation', () => {
      queueDeselectAnnotation();
    });

    scheduleLoadReplays();
  } catch (e) {
    console.error('Failed to initialize annotator:', e);
  }
}

function scheduleAnnotatorInit() {
  if (initRetryTimeout) {
    window.clearTimeout(initRetryTimeout);
    initRetryTimeout = 0;
  }

  let tries = 0;
  const maxTries = 12;

  const attemptInit = () => {
    tries += 1;

    const content = document.querySelector('.vp-doc') as HTMLElement | null;

    if (content) {
      void initAnnotator();
      return;
    }

    if (tries < maxTries) {
      initRetryTimeout = window.setTimeout(attemptInit, 120);
    }
  };

  attemptInit();
}

function loadAnnotationsToRecogito() {
  if (!annotator) return;

  const currentPageText = getCurrentPageTextWithoutPDF();

  const annotationsToLoad = annotationStore.filteredAnnotations
    .filter(a => a.type === 'text')
    .map(a => {
      const resolved = resolveTextTargetWithFuzzy(a.target, currentPageText);
      if (resolved.changed) {
        annotationStore.updateAnnotation(a.id, { target: resolved.target });
      }

      return {
        id: a.id,
        ...a,
        target: resolved.target
      };
    })
    .filter(annotation => Array.isArray(annotation.target?.selector) && annotation.target.selector.length > 0);

  annotator.setAnnotations(annotationsToLoad);
  requestAnimationFrame(() => {
    syncSelectedAnnotationVisual(annotationStore.selectedAnnotationId);
  });
}

let viewportChangeRaf = 0;
function handleViewportChange() {
  if (viewportChangeRaf) return;
  
  viewportChangeRaf = requestAnimationFrame(() => {
    viewportChangeRaf = 0;
    if (annotationStore.selectedAnnotationId) {
      syncSelectedAnnotationVisual(annotationStore.selectedAnnotationId);
    }
    if (showQuickBubble.value) {
      positionQuickBubble();
    }
  });
}

const debouncedHandleSelectionChange = debounce(handleSelectionChange, 100);

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
  const hadActiveAnnotation = !!activeAnnotationId.value;

  if (quickBubbleRepositionRaf) {
    cancelAnimationFrame(quickBubbleRepositionRaf);
    quickBubbleRepositionRaf = 0;
  }

  quickBubbleRepositionLastAt = 0;
  showQuickBubble.value = false;
  pendingSelection.value = null;
  quickBubbleAnchorRect.value = null;
  resetQuickBubbleDraft();
  loadAnnotationsToRecogito();
  if (annotator && !hadActiveAnnotation) {
    annotator.cancelSelected();
  }

  if (copyAutoCloseTimeout) {
    window.clearTimeout(copyAutoCloseTimeout);
    copyAutoCloseTimeout = 0;
  }

  suppressBubbleCloseUntil = 0;
}

function handleDocumentClick(e: MouseEvent) {
  if (!showQuickBubble.value) {
    const target = e.target as Element | null;
    if (!target) return;
    if (target.closest('.annotation-item, .r6o-annotation, [data-annotation-id], [data-id]')) return;
    annotationStore.selectAnnotation(null);
    return;
  }

  if (Date.now() < suppressBubbleCloseUntil) return;

  const target = e.target as Element | null;
  if (target?.closest('.annotation-item')) {
    cancelQuickBubble();
    return;
  }

  if (target?.closest('.r6o-annotation, [data-annotation-id], [data-id]')) {
    return;
  }

  const bubble = document.querySelector('.quick-bubble');
  if (bubble && !bubble.contains(e.target as Node)) {
    cancelQuickBubble();
    annotationStore.selectAnnotation(null);
  }
}

onMounted(() => {
  const storedColor = readStoredSelectionColor();
  if (storedColor) {
    selectedColor.value = storedColor;
  }

  scheduleAnnotatorInit();

  document.addEventListener('click', handleDocumentClick);
  document.addEventListener('selectionchange', debouncedHandleSelectionChange, true);
  if (isIOSTouchDevice()) {
    document.addEventListener('contextmenu', handleMobileContextMenu, true);
  }
  window.addEventListener('resize', handleViewportChange);
  window.addEventListener('scroll', handleViewportChange, true);
});

watch(() => route.path, () => {
  teardownAnnotatorInstance();
  scheduleAnnotatorInit();
});

watch(
  () => annotationStore.annotations.map(a => `${a.id}:${a.modified || a.created}`).join('|'),
  () => {
    scheduleLoadReplays();
  }
);

watch(() => annotationStore.filterUser, () => {
  scheduleLoadReplays();
});

watch(() => annotationStore.currentPagePath, () => {
  scheduleLoadReplays();
});

watch(() => userStore.currentUser?.id, () => {
  scheduleLoadReplays();
});

watch(() => annotationStore.selectedAnnotationId, (selectedId) => {
  syncSelectedAnnotationVisual(selectedId);
});

watch(() => selectedColor.value, (color) => {
  applyTextSelectionColorVariable(color);
  persistSelectionColor(color);
});

onUnmounted(() => {
  teardownAnnotatorInstance();

  if (initRetryTimeout) {
    window.clearTimeout(initRetryTimeout);
    initRetryTimeout = 0;
  }

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

  if (selectedVisualSyncRaf) {
    cancelAnimationFrame(selectedVisualSyncRaf);
    selectedVisualSyncRaf = 0;
  }

  if (quickBubbleRepositionRaf) {
    cancelAnimationFrame(quickBubbleRepositionRaf);
    quickBubbleRepositionRaf = 0;
  }

  if (viewportChangeRaf) {
    cancelAnimationFrame(viewportChangeRaf);
    viewportChangeRaf = 0;
  }

  clearSelectedAnnotationVisual();
  clearTextSelectionColorVariable();

  document.removeEventListener('click', handleDocumentClick);
  document.removeEventListener('selectionchange', debouncedHandleSelectionChange, true);
  if (isIOSTouchDevice()) {
    document.removeEventListener('contextmenu', handleMobileContextMenu, true);
  }
  window.removeEventListener('resize', handleViewportChange);
  window.removeEventListener('scroll', handleViewportChange, true);
});
</script>

<template>
  <div>
    <div 
      v-if="showQuickBubble" 
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
  </div>
</template>
