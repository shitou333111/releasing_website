<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useAnnotationStore } from '../stores/annotationStore';

const PDF_OUTLINE_JUMP_EVENT = 'pdf-outline-jump';

type EmbedMode = 'contained' | 'fullpage';

type CropInsets = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

type DimensionClassMaps = {
  widthByClass: Map<string, number>;
  heightByClass: Map<string, number>;
};

type PageStructure = {
  mask: HTMLElement;
  inner: HTMLElement;
};

type HtmlPageRecord = {
  pageNumber: number;
  html: string;
  shell: HTMLElement;
  naturalWidth: number;
  naturalHeight: number;
  loaded: boolean;
  pageEl: HTMLElement | null;
  maskEl: HTMLElement | null;
  innerEl: HTMLElement | null;
};

type ScaledPageEntry = {
  record: HtmlPageRecord;
  page: HTMLElement | null;
  mask: HTMLElement | null;
  inner: HTMLElement | null;
  naturalWidth: number;
  naturalHeight: number;
};

const props = withDefaults(defineProps<{
  src: string;
  embedMode?: EmbedMode;
  height?: string;
  loadingText?: string;
  errorText?: string;
  pageSelector?: string;
  fitToWidth?: boolean;
  hideSidebar?: boolean;
  virtualizePages?: boolean;
  lazyPageBuffer?: number;
  lazyRootMargin?: string;
  trimX?: number;
  enableCrop?: boolean;
  showCropGuides?: boolean;
  background?: string;
  showBorder?: boolean;
  showPageSeparators?: boolean;
  cropOdd?: Partial<CropInsets>;
  cropEven?: Partial<CropInsets>;
}>(), {
  embedMode: 'fullpage',
  height: '72vh',
  loadingText: 'HTML 内容加载中...',
  errorText: 'HTML 内容加载失败',
  pageSelector: '.pf',
  fitToWidth: true,
  hideSidebar: true,
  virtualizePages: false,
  lazyPageBuffer: 2,
  lazyRootMargin: '180% 0px',
  trimX: 0,
  enableCrop: false,
  showCropGuides: false,
  background: '#ffffff',
  showBorder: true,
  showPageSeparators: true,
  cropOdd: () => ({}),
  cropEven: () => ({})
});

const annotationStore = useAnnotationStore();
const contentRef = ref<HTMLElement | null>(null);
const containerRef = ref<HTMLElement | null>(null);
const isLoading = ref(false);
const errorMessage = ref('');

const containerStyle = computed(() => {
  const base = {
    '--external-html-background': props.background
  };
  
  if (props.embedMode !== 'contained') {
    return base;
  }

  return {
    ...base,
    '--external-html-height': props.height
  };
});

let requestToken = 0;
let activeFetchController: AbortController | null = null;
let resizeObserver: ResizeObserver | null = null;
let pageIntersectionObserver: IntersectionObserver | null = null;
let relayoutRaf = 0;
const scaledPages: ScaledPageEntry[] = [];
const pageRecords: HtmlPageRecord[] = [];
let viewportAnchorPages: number[] = [1];
let intersectingPages = new Set<number>();

const htmlCache = new Map<string, string>();
let suppressAutoBubbleForSidebarSelectionId: string | null = null;
let suppressAutoBubbleForSidebarSelectionUntil = 0;

function normalizePositiveNumber(value: unknown, fallback = 0): number {
  const normalized = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(0, normalized);
}

async function scrollToAnnotationById(annotationId: string | null, options?: { maxAttempts?: number; delayMs?: number }) {
  if (!annotationId) return;

  const maxAttempts = options?.maxAttempts ?? 5;
  const delayMs = options?.delayMs ?? 120;

  // Try a few times because activation, insertion and relayout can be async
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // Try to find the annotated element inside any loaded page shell.
    for (const record of pageRecords) {
      if (!record.shell) continue;

      const selector = `[data-annotation-id="${annotationId}"], [data-id="${annotationId}"]`;
      let el = record.shell.querySelector(selector) as HTMLElement | null;

      // If element not found but page not yet loaded, activate and try again after layout
      if (!el && !record.loaded) {
        activatePageRecord(record);
        await nextTick();
        // allow a frame for the DOM to settle
        await new Promise((r) => requestAnimationFrame(r));
        el = record.shell.querySelector(selector) as HTMLElement | null;
      }

      if (!el) continue;

      // Defer actual scrolling until DOM/layout stabilizes
      await nextTick();
      await new Promise((r) => requestAnimationFrame(r));

      const mount = contentRef.value;
      try {
        if (props.embedMode === 'contained' && mount) {
          const rect = el.getBoundingClientRect();
          const mountRect = mount.getBoundingClientRect();
          const targetTop = rect.top - mountRect.top + mount.scrollTop - (mountRect.height / 2) + (rect.height / 2);
          mount.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
        } else {
          // Full-page mode: prefer center block for better UX
          el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        }
      } catch (e) {
        // Best-effort fallback: scroll the shell into view
        try {
          record.shell?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } catch (err) {
          // ignore
        }
      }

      return;
    }

    // Not found this attempt — wait a bit before retrying
    // If this was the last attempt, break and log
    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  // Not found after retries
  console.debug('scrollToAnnotationById: element not found for', annotationId);
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

function parsePxValue(raw: string | null | undefined): number {
  if (!raw) return 0;
  const normalized = String(raw).trim();
  const match = normalized.match(/^(-?\d+(?:\.\d+)?)px$/i) || normalized.match(/^(-?\d+(?:\.\d+)?)$/);
  if (!match) return 0;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function parseInlineStyleDimension(styleText: string | null, dimension: 'width' | 'height'): number {
  if (!styleText) return 0;
  const match = styleText.match(new RegExp(`${dimension}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)px`, 'i'));
  if (!match) return 0;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function parseCssDimension(rawValue: string, unit: string): number {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }

  const normalizedUnit = unit.toLowerCase();
  if (normalizedUnit === 'px') {
    return parsed;
  }

  if (normalizedUnit === 'pt') {
    return parsed * (96 / 72);
  }

  return 0;
}

function extractClassDimensionMapFromCss(cssText: string, dimension: 'width' | 'height'): Map<string, number> {
  const map = new Map<string, number>();
  const regex = new RegExp(`\\.([A-Za-z0-9_-]+)\\s*\\{[^}]*?${dimension}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)(px|pt)\\s*;[^}]*?\\}`, 'gi');

  let match: RegExpExecArray | null;
  while ((match = regex.exec(cssText)) !== null) {
    const className = match[1];
    const value = parseCssDimension(match[2], match[3]);
    if (value > 0) {
      map.set(className, value);
    }
  }

  return map;
}

function extractDimensionClassMaps(parsedDoc: Document): DimensionClassMaps {
  const widthByClass = new Map<string, number>();
  const heightByClass = new Map<string, number>();

  parsedDoc.querySelectorAll('style').forEach((styleNode) => {
    const cssText = styleNode.textContent || '';
    if (!cssText.trim()) {
      return;
    }

    const widthMap = extractClassDimensionMapFromCss(cssText, 'width');
    widthMap.forEach((value, className) => {
      widthByClass.set(className, value);
    });

    const heightMap = extractClassDimensionMapFromCss(cssText, 'height');
    heightMap.forEach((value, className) => {
      heightByClass.set(className, value);
    });
  });

  return { widthByClass, heightByClass };
}

function resolveDimensionFromClassMap(page: HTMLElement, map: Map<string, number>): number {
  for (const className of page.classList) {
    const value = map.get(className);
    if (value && value > 0) {
      return value;
    }
  }

  const primaryChild = page.querySelector(':scope > .pc') as HTMLElement | null;
  if (primaryChild) {
    for (const className of primaryChild.classList) {
      const value = map.get(className);
      if (value && value > 0) {
        return value;
      }
    }
  }

  return 0;
}

function deriveNaturalDimension(page: HTMLElement, dimension: 'width' | 'height', classMaps: DimensionClassMaps): number {
  const directStyle = parsePxValue(dimension === 'width' ? page.style.width : page.style.height);
  if (directStyle > 0) return directStyle;

  const inlineStyle = parseInlineStyleDimension(page.getAttribute('style'), dimension);
  if (inlineStyle > 0) return inlineStyle;

  const attrValue = parsePxValue(page.getAttribute(dimension));
  if (attrValue > 0) return attrValue;

  const datasetValue = parsePxValue(page.dataset[dimension === 'width' ? 'externalHtmlNaturalWidth' : 'externalHtmlNaturalHeight']);
  if (datasetValue > 0) return datasetValue;

  const map = dimension === 'width' ? classMaps.widthByClass : classMaps.heightByClass;
  const classMapValue = resolveDimensionFromClassMap(page, map);
  if (classMapValue > 0) return classMapValue;

  return 1;
}

function clearScaledPages() {
  scaledPages.splice(0, scaledPages.length);
}

function clearPageRecords() {
  pageRecords.splice(0, pageRecords.length);
  viewportAnchorPages = [1];
  intersectingPages = new Set<number>();
}

function teardownPageIntersectionObserver() {
  if (pageIntersectionObserver) {
    pageIntersectionObserver.disconnect();
    pageIntersectionObserver = null;
  }

  intersectingPages = new Set<number>();
}

function clearContent() {
  const mount = contentRef.value;
  if (!mount) return;

  teardownPageIntersectionObserver();
  clearScaledPages();
  clearPageRecords();
  mount.innerHTML = '';
}

function buildBaseUrl(sourceUrl: string, parsedDoc: Document): URL {
  const origin = window.location.origin;
  const sourceBase = new URL(sourceUrl, origin);
  const docBaseHref = parsedDoc.querySelector('base[href]')?.getAttribute('href')?.trim();

  if (!docBaseHref) {
    return sourceBase;
  }

  try {
    return new URL(docBaseHref, sourceBase);
  } catch {
    return sourceBase;
  }
}

function isExternalHtmlUnsafeUrl(rawUrl: string): boolean {
  const lower = rawUrl.trim().toLowerCase();
  return lower.startsWith('javascript:')
    || lower.startsWith('vbscript:')
    || lower.startsWith('data:text/html');
}

function resolveExternalHtmlUrl(rawUrl: string, baseUrl: URL): string {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.startsWith('#') || isExternalHtmlUnsafeUrl(trimmed)) {
    return rawUrl;
  }

  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return rawUrl;
  }
}

function rewriteSrcset(rawSrcset: string, baseUrl: URL): string {
  return rawSrcset
    .split(',')
    .map((item) => {
      const part = item.trim();
      if (!part) return '';

      const firstSpaceIndex = part.search(/\s/);
      if (firstSpaceIndex === -1) {
        return resolveExternalHtmlUrl(part, baseUrl);
      }

      const urlPart = part.slice(0, firstSpaceIndex);
      const descriptor = part.slice(firstSpaceIndex + 1).trim();
      return `${resolveExternalHtmlUrl(urlPart, baseUrl)}${descriptor ? ` ${descriptor}` : ''}`;
    })
    .filter(Boolean)
    .join(', ');
}

function rewriteCssUrls(cssText: string, baseUrl: URL): string {
  if (!cssText) return cssText;
  const urlRegex = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
  return cssText.replace(urlRegex, (match, quote, rawUrl) => {
    const resolvedUrl = resolveExternalHtmlUrl(rawUrl, baseUrl);
    return `url(${quote}${resolvedUrl}${quote})`;
  });
}

function sanitizeAndRewriteElement(element: Element, baseUrl: URL) {
  Array.from(element.attributes).forEach((attribute) => {
    const attributeName = attribute.name.toLowerCase();

    if (attributeName.startsWith('on')) {
      element.removeAttribute(attribute.name);
      return;
    }

    if (attributeName === 'href' || attributeName === 'src' || attributeName === 'poster' || attributeName === 'xlink:href') {
      element.setAttribute(attribute.name, resolveExternalHtmlUrl(attribute.value, baseUrl));
      return;
    }

    if (attributeName === 'srcset') {
      element.setAttribute(attribute.name, rewriteSrcset(attribute.value, baseUrl));
      return;
    }

    if (attributeName === 'style') {
      element.setAttribute(attribute.name, rewriteCssUrls(attribute.value, baseUrl));
    }
  });
}

function createSanitizedDocument(markup: string, sourceUrl: string): Document {
  const parser = new DOMParser();
  const parsedDoc = parser.parseFromString(markup, 'text/html');
  const baseUrl = buildBaseUrl(sourceUrl, parsedDoc);

  parsedDoc.querySelectorAll('script, noscript').forEach((node) => node.remove());
  parsedDoc.querySelectorAll('style').forEach((styleNode) => {
    styleNode.textContent = rewriteCssUrls(styleNode.textContent || '', baseUrl);
  });
  parsedDoc.querySelectorAll('*').forEach((element) => {
    sanitizeAndRewriteElement(element, baseUrl);
  });

  return parsedDoc;
}

function createStyleFragment(parsedDoc: Document): DocumentFragment {
  const fragment = document.createDocumentFragment();

  parsedDoc.querySelectorAll('style, link[rel="stylesheet"]').forEach((node) => {
    const clonedNode = node.cloneNode(true) as Element;
    fragment.appendChild(clonedNode);
  });

  return fragment;
}

function ensurePageInnerStructure(page: HTMLElement): PageStructure {
  let mask = page.querySelector(':scope > .external-html-page-mask') as HTMLElement | null;
  let inner = page.querySelector(':scope > .external-html-page-inner') as HTMLElement | null;

  if (!mask) {
    mask = document.createElement('div');
    mask.className = 'external-html-page-mask';
  }

  if (!inner) {
    inner = document.createElement('div');
    inner.className = 'external-html-page-inner';

    // Move existing content into inner, avoiding the new mask/inner elements
    Array.from(page.childNodes).forEach((child) => {
      if (child !== mask && child !== inner) {
        inner!.appendChild(child);
      }
    });
  }

  if (inner.parentElement !== mask) {
    mask.appendChild(inner);
  }

  if (mask.parentElement !== page) {
    page.appendChild(mask);
  }

  page.classList.add('external-html-page');

  return { mask, inner };
}

function createPageShell(pageNumber: number, naturalHeight: number): HTMLElement {
  const shell = document.createElement('div');
  shell.className = 'external-html-page-shell is-placeholder';
  shell.dataset.pageNumber = String(pageNumber);
  shell.style.height = `${Math.max(64, Math.round(naturalHeight))}px`;
  return shell;
}

function parseComputedPx(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Number(String(value).replace('px', '').trim());
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function updateRecordNaturalDimensionsFromDom(record: HtmlPageRecord, pageElement: HTMLElement) {
  const computed = window.getComputedStyle(pageElement);
  const measuredWidth = parseComputedPx(computed.width) || pageElement.getBoundingClientRect().width;
  const measuredHeight = parseComputedPx(computed.height) || pageElement.getBoundingClientRect().height;

  if (Number.isFinite(measuredWidth) && measuredWidth > 1) {
    record.naturalWidth = measuredWidth;
  }

  if (Number.isFinite(measuredHeight) && measuredHeight > 1) {
    record.naturalHeight = measuredHeight;
  }
}

function activatePageRecord(record: HtmlPageRecord) {
  if (record.loaded) return;

  const template = document.createElement('template');
  template.innerHTML = record.html.trim();
  const pageElement = template.content.firstElementChild as HTMLElement | null;
  if (!pageElement) return;

  const structure = ensurePageInnerStructure(pageElement);
  pageElement.dataset.pageNumber = String(record.pageNumber);

  // 处理背景色和背景图片问题
  pageElement.style.background = props.background || '#ffffff';
  pageElement.style.backgroundColor = props.background || '#ffffff';
  
  // 移除可能存在的背景图片样式
  const elementsWithBg = pageElement.querySelectorAll('[style*="background"]');
  elementsWithBg.forEach(el => {
    const styleEl = el as HTMLElement;
    const computedBg = styleEl.style.background || '';
    if (computedBg.includes('url(') && !computedBg.includes('data:')) {
      // 保留data URI的背景，移除其他背景图片
      styleEl.style.backgroundImage = 'none';
    }
  });

  // Measure natural dimensions in an unconstrained off-screen container 
  // before moving it into the potentially scale-constrained shell.
  const offscreen = document.createElement('div');
  offscreen.style.position = 'absolute';
  offscreen.style.visibility = 'hidden';
  offscreen.style.pointerEvents = 'none';
  offscreen.style.width = 'max-content';
  offscreen.style.height = 'max-content';
  document.body.appendChild(offscreen);
  offscreen.appendChild(pageElement);

  // Read the real CSS-computed page size after insertion.
  // This avoids ambiguity when class dimensions are declared multiple times.
  updateRecordNaturalDimensionsFromDom(record, pageElement);

  record.shell.appendChild(pageElement);
  document.body.removeChild(offscreen);

  record.loaded = true;
  record.pageEl = pageElement;
  record.maskEl = structure.mask;
  record.innerEl = structure.inner;
  record.shell.classList.remove('is-placeholder');
}

function deactivatePageRecord(record: HtmlPageRecord) {
  if (!record.loaded) return;

  record.shell.innerHTML = '';
  record.loaded = false;
  record.pageEl = null;
  record.maskEl = null;
  record.innerEl = null;
  record.shell.classList.add('is-placeholder');
}

function updateContentModeClasses() {
  const mount = contentRef.value;
  const container = containerRef.value;
  if (!container) return;

  const lazyEnabled = props.virtualizePages && pageRecords.length > 6;
  mount?.classList.toggle('is-virtualized', lazyEnabled);
  
  container.classList.toggle('hide-border', !props.showBorder);
  container.classList.toggle('show-page-separators', !!props.showPageSeparators);
  container.classList.toggle('show-crop-guides', !!(props.showCropGuides && props.enableCrop));
}

function getActivationSet(): Set<number> {
  const allPages = pageRecords.map(record => record.pageNumber);
  const active = new Set<number>();
  const lazyEnabled = props.virtualizePages && pageRecords.length > 6;

  if (!lazyEnabled) {
    allPages.forEach(page => active.add(page));
    return active;
  }

  const buffer = Math.max(1, Math.floor(Number(props.lazyPageBuffer || 2)));
  const totalPages = pageRecords.length;
  const anchors = viewportAnchorPages.length ? viewportAnchorPages : [1];

  anchors.forEach(anchor => {
    for (let page = anchor - buffer; page <= anchor + buffer; page += 1) {
      if (page >= 1 && page <= totalPages) {
        active.add(page);
      }
    }
  });

  return active;
}

function applyPageActivation() {
  const activeSet = getActivationSet();

  pageRecords.forEach((record) => {
    if (activeSet.has(record.pageNumber)) {
      activatePageRecord(record);
    } else {
      deactivatePageRecord(record);
    }
  });

  scheduleRelayout();
}

function updateViewportAnchors(anchors: number[]) {
  const totalPages = pageRecords.length;
  const normalized = anchors
    .map(page => Number(page || 0))
    .filter(page => Number.isFinite(page) && page >= 1 && page <= totalPages)
    .sort((a, b) => a - b);

  const deduped = Array.from(new Set(normalized));
  const nextAnchors = deduped.length ? deduped : [1];

  if (nextAnchors.length === viewportAnchorPages.length
    && nextAnchors.every((page, index) => page === viewportAnchorPages[index])) {
    return;
  }

  viewportAnchorPages = nextAnchors;
  applyPageActivation();
}

function setupPageIntersectionObserver() {
  teardownPageIntersectionObserver();

  if (!pageRecords.length) {
    viewportAnchorPages = [1];
    return;
  }

  const lazyEnabled = props.virtualizePages && pageRecords.length > 6;
  if (!lazyEnabled || typeof IntersectionObserver === 'undefined') {
    viewportAnchorPages = [1];
    applyPageActivation();
    return;
  }

  const root = props.embedMode === 'contained' ? contentRef.value : null;

  pageIntersectionObserver = new IntersectionObserver((entries) => {
    let changed = false;

    entries.forEach((entry) => {
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

  pageRecords.forEach((record) => {
    pageIntersectionObserver?.observe(record.shell);
  });

  applyPageActivation();
}

function clampCropInsets(raw: CropInsets, width: number, height: number): CropInsets {
  const maxLeft = Math.max(0, width - 1);
  const maxRight = Math.max(0, width - 1);
  const maxTop = Math.max(0, height - 1);
  const maxBottom = Math.max(0, height - 1);

  const left = Math.min(raw.left, maxLeft);
  const right = Math.min(raw.right, Math.max(0, width - left - 1));
  const top = Math.min(raw.top, maxTop);
  const bottom = Math.min(raw.bottom, Math.max(0, height - top - 1));

  return { top, right, bottom, left };
}

function relayoutPages() {
  relayoutRaf = 0;

  const mount = contentRef.value;
  if (!mount || !pageRecords.length) {
    return;
  }

  const measuredWidth = mount.getBoundingClientRect().width || mount.clientWidth;
  const viewportWidth = window.innerWidth || measuredWidth;
  const availableWidth = Math.max(1, Math.min(measuredWidth, viewportWidth) - 8);
  clearScaledPages();

  pageRecords.forEach((record) => {
    const rawCrop = getRawCropInsetsForPage(record.pageNumber);
    const crop = clampCropInsets(rawCrop, record.naturalWidth, record.naturalHeight);

    const visibleWidth = Math.max(1, record.naturalWidth - crop.left - crop.right);
    const visibleHeight = Math.max(1, record.naturalHeight - crop.top - crop.bottom);

    let scale: number;
    let shellWidth: number;
    let shellHeight: number;

    if (props.enableCrop && props.fitToWidth) {
      // 启用裁剪时，让可见内容区域放大填充到可用宽度
      scale = availableWidth / visibleWidth;
      shellWidth = availableWidth;
      shellHeight = Math.round(visibleHeight * scale);
    } else {
      // 普通模式
      scale = props.fitToWidth
        ? Math.min(1, availableWidth / visibleWidth)
        : 1;
      shellWidth = Math.max(1, Math.round(visibleWidth * scale));
      shellHeight = Math.max(1, Math.round(visibleHeight * scale));
    }

    const parity = record.pageNumber % 2 === 0 ? 'even' : 'odd';
    record.shell.dataset.pageParity = parity;
    record.shell.style.width = `${shellWidth}px`;
    record.shell.style.height = `${Math.max(64, shellHeight)}px`;

    if (record.pageEl && record.maskEl && record.innerEl) {
      record.pageEl.style.width = `${shellWidth}px`;
      record.pageEl.style.height = `${shellHeight}px`;
      record.pageEl.style.overflow = 'hidden';

      record.maskEl.style.width = `${shellWidth}px`;
      record.maskEl.style.height = `${shellHeight}px`;
      record.maskEl.style.overflow = 'hidden';
      record.maskEl.style.position = 'relative';

      record.innerEl.style.width = `${record.naturalWidth}px`;
      record.innerEl.style.height = `${record.naturalHeight}px`;
      record.innerEl.style.position = 'absolute';
      record.innerEl.style.left = `${Math.round(-crop.left * scale)}px`;
      record.innerEl.style.top = `${Math.round(-crop.top * scale)}px`;
      record.innerEl.style.transformOrigin = 'top left';
      record.innerEl.style.transform = `scale(${scale})`;

      scaledPages.push({
        record,
        page: record.pageEl,
        mask: record.maskEl,
        inner: record.innerEl,
        naturalWidth: record.naturalWidth,
        naturalHeight: record.naturalHeight
      });
    }
  });
}

function createFallbackBodyFragment(parsedDoc: Document): DocumentFragment {
  const fragment = document.createDocumentFragment();

  Array.from(parsedDoc.body.children).forEach((child) => {
    if (child.matches('style, link[rel="stylesheet"], script, noscript')) {
      return;
    }

    const cloned = child.cloneNode(true) as HTMLElement;
    fragment.appendChild(cloned);
  });

  return fragment;
}

function registerPageRecords(renderRoot: HTMLElement, pages: HTMLElement[], classMaps: DimensionClassMaps) {
  clearPageRecords();

  pages.forEach((pageElement, index) => {
    const pageNumber = index + 1;
    const naturalWidth = Math.max(1, deriveNaturalDimension(pageElement, 'width', classMaps));
    const naturalHeight = Math.max(1, deriveNaturalDimension(pageElement, 'height', classMaps));
    const shell = createPageShell(pageNumber, naturalHeight);
    renderRoot.appendChild(shell);

    pageRecords.push({
      pageNumber,
      html: pageElement.outerHTML,
      shell,
      naturalWidth,
      naturalHeight,
      loaded: false,
      pageEl: null,
      maskEl: null,
      innerEl: null
    });
  });
}

function normalizeExternalHtmlLayout(parsedDoc: Document) {
  const mount = contentRef.value;
  if (!mount) return;

  const classMaps = extractDimensionClassMaps(parsedDoc);

  if (props.hideSidebar) {
    parsedDoc.querySelector('#sidebar')?.remove();
  }

  mount.appendChild(createStyleFragment(parsedDoc));

  const sourcePages = Array.from(parsedDoc.querySelectorAll<HTMLElement>(props.pageSelector));
  if (!sourcePages.length) {
    mount.appendChild(createFallbackBodyFragment(parsedDoc));
    updateContentModeClasses();
    return;
  }

  const renderRoot = document.createElement('div');
  renderRoot.className = 'external-html-page-container';
  mount.appendChild(renderRoot);

  registerPageRecords(renderRoot, sourcePages, classMaps);
  updateContentModeClasses();
  setupPageIntersectionObserver();
}

function scheduleRelayout() {
  if (relayoutRaf) {
    return;
  }

  relayoutRaf = window.requestAnimationFrame(() => {
    relayoutPages();
  });
}

async function fetchAndRenderExternalHtml() {
  if (!contentRef.value) return;

  requestToken += 1;
  const localToken = requestToken;

  activeFetchController?.abort();
  const fetchController = new AbortController();
  activeFetchController = fetchController;

  let htmlText = htmlCache.get(props.src);
  const hasCache = !!htmlText;

  if (!hasCache) {
    isLoading.value = true;
    errorMessage.value = '';
    clearContent();
  }

  try {
    if (!htmlText) {
      const response = await fetch(props.src, {
        signal: fetchController.signal
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      htmlText = await response.text();
      htmlCache.set(props.src, htmlText);
    }

    if (localToken !== requestToken) {
      return;
    }

    clearContent();
    const parsedDoc = createSanitizedDocument(htmlText, props.src);
    normalizeExternalHtmlLayout(parsedDoc);

    await nextTick();
    setupPageIntersectionObserver();
    scheduleRelayout();
  } catch (error) {
    if (fetchController.signal.aborted || localToken !== requestToken) {
      return;
    }

    console.error('ExternalHTMLViewer load failed:', error);
    clearContent();
    errorMessage.value = props.errorText;
  } finally {
    if (localToken === requestToken) {
      isLoading.value = false;
    }
  }
}

function setupResizeObserver() {
  if (!contentRef.value) return;

  resizeObserver?.disconnect();
  resizeObserver = new ResizeObserver(() => {
    scheduleRelayout();
  });

  resizeObserver.observe(contentRef.value);
  window.addEventListener('resize', scheduleRelayout);
}

function teardownResizeObserver() {
  resizeObserver?.disconnect();
  resizeObserver = null;
  window.removeEventListener('resize', scheduleRelayout);
}

watch(
  () => [props.src, props.pageSelector, props.hideSidebar],
  () => {
    void fetchAndRenderExternalHtml();
  }
);

watch(
  () => [
    props.fitToWidth,
    props.virtualizePages,
    props.lazyPageBuffer,
    props.lazyRootMargin,
    props.enableCrop,
    props.trimX,
    props.showCropGuides,
    props.background,
    props.showBorder,
    props.showPageSeparators,
    props.embedMode,
    props.height,
    JSON.stringify(props.cropOdd),
    JSON.stringify(props.cropEven)
  ],
  () => {
    updateContentModeClasses();
    setupPageIntersectionObserver();
    applyPageActivation();
    scheduleRelayout();
  }
);

watch(() => annotationStore.selectedAnnotationId, (selectedId, previousId) => {
  if (selectedId === previousId || !selectedId) return;

  const selected = annotationStore.annotations.find(a => a.id === selectedId);
  if (!selected) return;

  const shouldSuppressAutoOpen =
    suppressAutoBubbleForSidebarSelectionId === selectedId
    && Date.now() < suppressAutoBubbleForSidebarSelectionUntil;

  if (shouldSuppressAutoOpen) {
    suppressAutoBubbleForSidebarSelectionId = null;
  }

  requestAnimationFrame(() => {
    const quoteText = selected.target?.selector?.[0]?.quote;
    let firstPage = 0;

    if (quoteText && quoteText.length > 0) {
      const searchText = quoteText.substring(0, Math.min(50, quoteText.length));
      for (let i = 0; i < pageRecords.length; i++) {
        const pageRecord = pageRecords[i];
        if (pageRecord.shell) {
          const pageText = pageRecord.shell.textContent || '';
          if (pageText.includes(searchText)) {
            firstPage = pageRecord.pageNumber;
            break;
          }
        }
      }
    }

    if (Number.isFinite(firstPage) && firstPage > 0) {
        navigateToExternalHTMLPage(firstPage);
    }

      // Try to scroll to the exact annotated element (if present) once the
      // target page is activated. This ensures selecting a comment or clicking
      // a highlight navigates to the highlight location (centered), not the
      // top of the page.
      (async () => {
        await nextTick();
        await scrollToAnnotationById(selectedId, { maxAttempts: 6, delayMs: 120 });
      })();

      if (shouldSuppressAutoOpen) {
        return;
      }
  });
});

function getCurrentViewerId(): string {
  if (props.src?.trim()) {
    return props.src.replace(/[?#].*$/, '');
  }
  return 'external-html-viewer';
}

function navigateToExternalHTMLPage(pageNumber: number) {
  const mount = contentRef.value;
  if (!mount || !pageRecords.length) {
    return;
  }

  const pageRecord = pageRecords.find(r => r.pageNumber === pageNumber);
  if (!pageRecord || !pageRecord.shell) {
    return;
  }

  if (!pageRecord.loaded) {
    activatePageRecord(pageRecord);
  }

    requestAnimationFrame(() => {
    if (props.embedMode === 'contained' && mount) {
      const shellRect = pageRecord.shell!.getBoundingClientRect();
      const mountRect = mount.getBoundingClientRect();
      const targetTop = shellRect.top - mountRect.top + mount.scrollTop - 12;
      mount.scrollTo({
        top: Math.max(0, targetTop),
        behavior: 'smooth'
      });
    } else {
      // Prefer centering the page shell in full-page mode for better context
      pageRecord.shell!.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });
}

function handleOutlineJump(event: Event) {
  const detail = (event as CustomEvent).detail;
  if (!detail || typeof detail !== 'object') {
    return;
  }

  const nextPage = Number(detail.page || 0);
  if (!Number.isFinite(nextPage) || nextPage <= 0) {
    return;
  }

  navigateToExternalHTMLPage(nextPage);
}

function handleAnnotationCardSelect(event: Event) {
  const detail = (event as CustomEvent<{ annotationId?: string; source?: string }>).detail;
  if (!detail || detail.source !== 'sidebar-card' || !detail.annotationId) {
    return;
  }

  suppressAutoBubbleForSidebarSelectionId = detail.annotationId;
  suppressAutoBubbleForSidebarSelectionUntil = Date.now() + 1200;
}

let isSelectingText = false;
let selectionStartTarget: HTMLElement | null = null;

function handleMouseDown(event: MouseEvent) {
  const target = event.target as HTMLElement | null;
  if (!target) return;
  
  const isTextElement = target.closest('.external-html-page .t, .external-html-page .t *');
  const isAnnotationHighlight = target.closest('.annotationHighlight, [data-annotation-id], [data-id], .r6o-annotation');
  
  if (!isTextElement && !isAnnotationHighlight) {
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    isSelectingText = false;
    selectionStartTarget = null;
    return;
  }
  
  isSelectingText = true;
  selectionStartTarget = target;
}

function handleMouseUp() {
  isSelectingText = false;
  selectionStartTarget = null;
}

onMounted(() => {
  setupResizeObserver();
  void fetchAndRenderExternalHtml().then(() => {
    try {
      const stored = sessionStorage.getItem('external_html_page_number');
      if (stored) {
        const n = Number(stored || 0);
        if (Number.isFinite(n) && n > 0) {
          // Ensure content rendered and then navigate
          navigateToExternalHTMLPage(n);
          sessionStorage.removeItem('external_html_page_number');
        }
      }
    } catch (e) {
      // ignore
    }
  });
  document.addEventListener('annotation-card-select', handleAnnotationCardSelect as EventListener);
  document.addEventListener(PDF_OUTLINE_JUMP_EVENT, handleOutlineJump as EventListener);
  document.addEventListener('mouseup', handleMouseUp);
  contentRef.value?.addEventListener('mousedown', handleMouseDown);
});

onUnmounted(() => {
  activeFetchController?.abort();
  teardownResizeObserver();
  teardownPageIntersectionObserver();
  clearContent();

  if (relayoutRaf) {
    window.cancelAnimationFrame(relayoutRaf);
    relayoutRaf = 0;
  }

  document.removeEventListener('annotation-card-select', handleAnnotationCardSelect as EventListener);
  document.removeEventListener(PDF_OUTLINE_JUMP_EVENT, handleOutlineJump as EventListener);
  document.removeEventListener('mouseup', handleMouseUp);
  contentRef.value?.removeEventListener('mousedown', handleMouseDown);
});
</script>

<template>
  <div
    ref="containerRef"
    class="external-html-viewer-container"
    :style="containerStyle"
  >
    <div
      ref="contentRef"
      class="external-html-content"
      :class="{ 'is-loading': isLoading, 'is-virtualized': false }"
    />

    <div
      v-if="isLoading"
      class="external-html-state"
    >
      {{ loadingText }}
    </div>

    <div
      v-else-if="errorMessage"
      class="external-html-state is-error"
    >
      {{ errorMessage }}
    </div>
  </div>
</template>
