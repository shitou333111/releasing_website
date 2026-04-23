<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, onBeforeUnmount, ref, watch } from 'vue';
import { useData, useRoute } from 'vitepress';
import { cleanTextForTTS, createStableFingerprint } from '../../shared/readAloudText.js';

type ReadAloudCue = {
  id: string;
  index: number;
  type: 'heading' | 'paragraph';
  tag: string;
  start: number;
  end: number;
  duration: number;
  fingerprint: string;
  text: string;
  source?: {
    lineStart: number | null;
    lineEnd: number | null;
  };
};

type ManifestEntry = {
  routePath: string;
  source: string;
  audio: string;
  cues: string;
  segments?: string;
  count: number;
  totalDuration: number;
  generatedAt: string;
};

type ManifestFile = {
  generatedAt: string | null;
  entries: Record<string, ManifestEntry>;
};

const route = useRoute();
const { frontmatter } = useData();

const audioRef = ref<HTMLAudioElement | null>(null);
const audioSrc = ref('');
const cues = ref<ReadAloudCue[]>([]);
const loading = ref(false);
const errorMessage = ref('');
const isPlaying = ref(false);
const currentCueId = ref<string | null>(null);
const currentSeconds = ref(0);
const floatStyle = ref<any>({ right: '24px' });
const wavHeader = ref<{
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
  numChannels: number;
  dataStart: number;
  dataSize: number;
} | null>(null);
const partialBlobUrl = ref<string | null>(null);
const prefetchCount = 2; // prefetch next N cues
const playingCueIndex = ref<number | null>(null);
const pendingCueIndex = ref<number | null>(null);
const mp3Offset = ref<number>(0);

async function estimateMp3Offset(url: string, maxBytes = 512000) {
  try {
    const range = `bytes=0-${maxBytes}`;
    const res = await fetch(url, { headers: { Range: range } });
    if (!res.ok) return 0;
    const ab = await res.arrayBuffer();
    // decode with WebAudio to get PCM and find first non-silent frame
    const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return 0;
    const ctx = new AudioCtx();
    try {
      const audioBuf = await ctx.decodeAudioData(ab.slice(0));
      const data = audioBuf.getChannelData(0);
      const sr = audioBuf.sampleRate;
      const win = 1024;
      const threshold = 0.0005;
      for (let i = 0; i < data.length; i += win) {
        let sum = 0;
        const end = Math.min(data.length, i + win);
        for (let j = i; j < end; j++) {
          const v = data[j];
          sum += v * v;
        }
        const rms = Math.sqrt(sum / (end - i));
        if (rms > threshold) {
          const seconds = i / sr;
          try { ctx.close && ctx.close(); } catch (e) {}
          return seconds;
        }
      }
      try { ctx.close && ctx.close(); } catch (e) {}
      return 0;
    } catch (e) {
      try { ctx.close && ctx.close(); } catch (e) {}
      return 0;
    }
  } catch (e) {
    return 0;
  }
}
const activeCueById = new Map<string, ReadAloudCue>();
const paragraphElementByCueId = new Map<string, HTMLElement>();
const cueIdByParagraphEl = new WeakMap<HTMLElement, string>();

let contentRoot: HTMLElement | null = null;
let contentClickHandler: ((event: Event) => void) | null = null;
let mutationObserver: MutationObserver | null = null;
let rescanRaf = 0;
let previousActiveElement: HTMLElement | null = null;

function parseBooleanFrontmatter(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'string') {
    return value.trim().toLowerCase() === 'true';
  }
  return false;
}

const readAloudEnabled = computed(() => parseBooleanFrontmatter(frontmatter.value?.readAloudEnabled));
const hasPlayableAudio = computed(() => !!audioSrc.value && cues.value.length > 0);

const buttonLabel = computed(() => {
  if (!hasPlayableAudio.value) return '朗读不可用';
  return isPlaying.value ? '暂停朗读' : '开始朗读';
});

const statusLabel = computed(() => {
  if (loading.value) return '正在加载朗读资源...';
  if (errorMessage.value) return errorMessage.value;
  if (!readAloudEnabled.value) return '本页未开启朗读';
  if (!hasPlayableAudio.value) return '未找到朗读资源';
  if (isPlaying.value) return '朗读中';
  return '就绪';
});

function normalizeRoutePath(pathValue: string): string {
  const clean = (pathValue || '/').replace(/\.html$/i, '').replace(/\/+$/, '');
  return clean || '/';
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`请求失败: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function clearCueMappings() {
  if (previousActiveElement) {
    previousActiveElement.classList.remove('read-aloud-active');
    previousActiveElement = null;
  }

  paragraphElementByCueId.forEach((element) => {
    element.classList.remove('read-aloud-seekable', 'read-aloud-active');
    element.removeAttribute('data-read-aloud-id');
  });

  paragraphElementByCueId.clear();
  activeCueById.clear();
  currentCueId.value = null;
}

function queueRescanParagraphs() {
  if (rescanRaf) return;

  rescanRaf = window.requestAnimationFrame(() => {
    rescanRaf = 0;
    mapParagraphsToCues();
  });
}

function getReadableParagraphNodes(): HTMLElement[] {
  const root = document.querySelector('.vp-doc') as HTMLElement | null;
  if (!root) return [];

  contentRoot = root;

  const allNodes = Array.from(root.querySelectorAll<HTMLElement>('h2, h3, h4, h5, h6, p'));
  return allNodes.filter((node) => {
    if (!node.textContent?.trim()) return false;
    if (node.closest('blockquote')) return false;
    if (node.closest('figure')) return false;
    if (node.closest('.read-aloud-controller')) return false;
    return true;
  });
}

function getCueByTime(currentTime: number): ReadAloudCue | null {
  if (!cues.value.length) return null;

  let low = 0;
  let high = cues.value.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const cue = cues.value[mid];

    if (currentTime < cue.start) {
      high = mid - 1;
      continue;
    }

    if (currentTime >= cue.end) {
      low = mid + 1;
      continue;
    }

    return cue;
  }

  return null;
}

function applyActiveCue(cueId: string | null) {
  if (cueId === currentCueId.value) return;

  currentCueId.value = cueId;

  if (previousActiveElement) {
    previousActiveElement.classList.remove('read-aloud-active');
    previousActiveElement = null;
  }

  if (!cueId) return;

  const element = paragraphElementByCueId.get(cueId);
  if (!element) return;

  element.classList.add('read-aloud-active');
  previousActiveElement = element;

  // Auto-scroll the currently playing cue into view so the highlighted
  // paragraph stays visible while reading. Only perform during active playback
  // to avoid disturbing user when paused.
  try {
    if (isPlaying.value) {
      const rect = element.getBoundingClientRect();
      const viewH = window.innerHeight || document.documentElement.clientHeight;
      if (rect.top < 0 || rect.bottom > viewH) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  } catch (e) {
    console.error('[TTS] auto-scroll failed', e);
  }
}

function onAudioTimeUpdate() {
  const audio = audioRef.value;
  if (!audio || !cues.value.length) {
    applyActiveCue(null);
    return;
  }
  // When playing partial blobs (blob: URLs), audio.currentTime is relative to the slice.
  if (audio.src && audio.src.startsWith('blob:') && playingCueIndex.value !== null) {
    const cue = cues.value[playingCueIndex.value];
    if (cue) {
      const globalTime = cue.start + audio.currentTime;
      currentSeconds.value = globalTime;
      applyActiveCue(cue.id);
      return;
    }
  }

  // Normal full-audio playback: currentTime is global, but for MP3 subtract encoder delay
  try {
    const src = audio.src || '';
    const isMp3 = typeof src === 'string' && src.toLowerCase().endsWith('.mp3');
    if (isMp3) {
      const adjusted = Math.max(0, audio.currentTime - (mp3Offset.value || 0));
      currentSeconds.value = adjusted;
      const cue = getCueByTime(adjusted);
      applyActiveCue(cue?.id || null);
    } else {
      currentSeconds.value = audio.currentTime;
      const cue = getCueByTime(audio.currentTime);
      applyActiveCue(cue?.id || null);
    }
  } catch (e) {
    currentSeconds.value = audio.currentTime;
    const cue = getCueByTime(audio.currentTime);
    applyActiveCue(cue?.id || null);
  }

  // If playing from a full MP3 (VBR possible), rely on timeupdate to detect cue end
  try {
    const src = audio.src || '';
    const isMp3 = typeof src === 'string' && src.toLowerCase().endsWith('.mp3');
    const realCurrent = audio.currentTime;
    const adjustedCurrent = isMp3 ? Math.max(0, realCurrent - (mp3Offset.value || 0)) : realCurrent;
    if (isMp3 && playingCueIndex.value !== null) {
      const playingIdx = playingCueIndex.value;
      const playingCue = cues.value[playingIdx];
      if (playingCue) {
        const epsilon = 0.08; // seconds tolerance
        if (adjustedCurrent >= (playingCue.end - epsilon)) {
          const next = playingIdx + 1;
          if (next < cues.value.length) {
            // advance to next cue
            // prevent multiple triggers by clearing playingCueIndex temporarily
            playingCueIndex.value = null;
            void loadAndPlayCue(next).catch((e) => {
              console.error('[TTS] auto-advance failed', e);
            });
            return;
          } else {
            // no next cue: stop at end
            try {
              audio.pause();
            } catch (e) {}
            currentSeconds.value = playingCue.end;
            applyActiveCue(playingCue.id);
            playingCueIndex.value = null;
            isPlaying.value = false;
            return;
          }
        }
      }
    }
  } catch (e) {
    // ignore timeupdate-side errors
  }
}

function onAudioPlay() {
  isPlaying.value = true;
}

function onAudioPause() {
  isPlaying.value = false;
}

async function onAudioEnded() {
  // When a partial blob ends, try to auto-advance to the next cue.
  // If advancing fails, keep the current cue active and set the time to cue end
  // instead of resetting to 0. This prevents subsequent Play from restarting
  // the whole article (startIndex 0) when current cue is still relevant.
  const wasPartial = !!partialBlobUrl.value;
  isPlaying.value = false;

  // no-op: previously cleared a setTimeout-based mp3 scheduler

  if (wasPartial && playingCueIndex.value !== null) {
    const curIndex = playingCueIndex.value;
    const nextIndex = curIndex + 1;
    if (nextIndex < cues.value.length) {
      try {
        await loadAndPlayCue(nextIndex);
        return;
      } catch (e) {
        console.error('[TTS] auto-advance failed', e);
        // keep current cue active and set time to its end so UI stays on the cue
        const curCue = cues.value[curIndex];
        if (curCue) {
          currentSeconds.value = curCue.end;
          applyActiveCue(curCue.id);
        }
        playingCueIndex.value = null;
        return;
      }
    }
    // no next cue: keep current cue highlighted at its end
    const curCue = cues.value[curIndex];
    if (curCue) {
      currentSeconds.value = curCue.end;
      applyActiveCue(curCue.id);
    }
    playingCueIndex.value = null;
    return;
  }

  // Non-partial (full audio) ended: set time to total and highlight last cue
  const lastCue = cues.value.length ? cues.value[cues.value.length - 1] : null;
  if (lastCue) {
    currentSeconds.value = lastCue.end;
    applyActiveCue(lastCue.id);
  } else {
    currentSeconds.value = 0;
    applyActiveCue(null);
  }
}

async function parseWavHeaderOnce(url: string) {
  if (wavHeader.value) return wavHeader.value;
  try {
    console.log('[TTS] parseWavHeaderOnce fetching head bytes', url);
    const res = await fetch(url, { headers: { Range: 'bytes=0-2047' } });
    const ab = await res.arrayBuffer();
    const dv = new DataView(ab);
    const sampleRate = dv.getUint32(24, true);
    const byteRate = dv.getUint32(28, true);
    const blockAlign = dv.getUint16(32, true);
    const bitsPerSample = dv.getUint16(34, true);
    const numChannels = dv.getUint16(22, true);

    let dataStart = -1;
    let dataSize = 0;
    for (let i = 12; i < Math.min(ab.byteLength - 8, 1024); i++) {
      if (
        dv.getUint8(i) === 100 &&
        dv.getUint8(i + 1) === 97 &&
        dv.getUint8(i + 2) === 116 &&
        dv.getUint8(i + 3) === 97
      ) {
        dataStart = i + 8;
        dataSize = dv.getUint32(i + 4, true);
        wavHeader.value = { sampleRate, byteRate, blockAlign, bitsPerSample, numChannels, dataStart, dataSize };
        console.log('[TTS] parsed WAV header', wavHeader.value);
        return wavHeader.value;
      }
    }

    wavHeader.value = { sampleRate, byteRate, blockAlign, bitsPerSample, numChannels, dataStart: 44, dataSize: 0 };
    console.log('[TTS] fallback WAV header', wavHeader.value);
    return wavHeader.value;
  } catch (e) {
    console.error('[TTS] parseWavHeaderOnce failed', e);
    return null;
  }
}

function buildWavHeaderForSlice(sampleRate: number, numChannels: number, bitsPerSample: number, dataSize: number) {
  const blockAlign = (numChannels * bitsPerSample) >> 3;
  const byteRate = sampleRate * blockAlign;
  const buffer = new ArrayBuffer(44);
  const dv = new DataView(buffer);
  function writeString(offset: number, str: string) {
    for (let i = 0; i < str.length; i++) dv.setUint8(offset + i, str.charCodeAt(i));
  }
  writeString(0, 'RIFF');
  dv.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, numChannels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, byteRate, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, bitsPerSample, true);
  writeString(36, 'data');
  dv.setUint32(40, dataSize, true);
  return new Uint8Array(buffer);
}

async function fetchWavSliceAsBlob(url: string, startSec: number, endSec: number) {
  const header = await parseWavHeaderOnce(url);
  if (!header) throw new Error('无法解析 WAV 头部');

  // Compute frame-aligned byte offsets to avoid partial-frame boundaries which cause clicks/repeats.
  const { sampleRate, blockAlign, dataStart, dataSize } = header as any;
  const totalFrames = dataSize ? Math.floor(dataSize / blockAlign) : Infinity;

  const frameStart = Math.max(0, Math.floor(startSec * sampleRate));
  const frameEnd = Math.min(totalFrames, Math.ceil(endSec * sampleRate));

  // Ensure at least one frame is requested to avoid zero-length slices
  let adjFrameStart = frameStart;
  let adjFrameEnd = frameEnd;
  if (adjFrameEnd <= adjFrameStart) {
    adjFrameEnd = Math.min(totalFrames, adjFrameStart + 1);
  }

  const byteStart = adjFrameStart * blockAlign;
  const byteEndInclusive = Math.max(0, adjFrameEnd * blockAlign - 1);

  const rangeStart = dataStart + byteStart;
  const rangeEnd = dataStart + Math.min(byteEndInclusive, (dataSize ? dataSize - 1 : byteEndInclusive));

  if (frameEnd <= frameStart) {
    console.warn('[TTS] adjusted zero-length slice to one frame', { url, startSec, endSec, frameStart, frameEnd });
  }
  console.log('[TTS] fetching range (frame-aligned)', { url, rangeStart, rangeEnd, startSec, endSec, frameStart, frameEnd, blockAlign });
  const res = await fetch(url, { headers: { Range: `bytes=${rangeStart}-${rangeEnd}` } });
  console.log('[TTS] range response status', res.status);
  const chunk = await res.arrayBuffer();
  const sliceSize = chunk.byteLength;
  const wavHdr = buildWavHeaderForSlice(header.sampleRate, header.numChannels, header.bitsPerSample, sliceSize);
  const combined = new Uint8Array(wavHdr.byteLength + sliceSize);
  combined.set(wavHdr, 0);
  combined.set(new Uint8Array(chunk), wavHdr.byteLength);
  return new Blob([combined.buffer], { type: 'audio/wav' });
}

async function loadAndPlayCue(cueIndex: number) {
  const entry = cues.value[cueIndex];
  if (!entry) return;
  const url = audioSrc.value;
  if (!url) return;
    const start = entry.start;
    const end = entry.end;
  try {
    loading.value = true;
    console.log('[TTS] loadAndPlayCue', cueIndex, start, end, url);
    const audio = audioRef.value;
    if (!audio) return;
    // If MP3 final file is used, play by seeking the full file instead of slicing WAV
    const isMp3 = typeof url === 'string' && url.toLowerCase().endsWith('.mp3');

    // no-op: timing handled by timeupdate for MP3

    if (isMp3) {
      // revoke any existing partial blob
      if (partialBlobUrl.value) {
        try { URL.revokeObjectURL(partialBlobUrl.value); } catch (e) {}
        partialBlobUrl.value = null;
      }
      // use full mp3 URL and seek to start
      audio.src = url;
      // ensure metadata loaded before seeking
      if (audio.readyState < 1) {
        await new Promise<void>((resolve) => {
          const handler = () => { resolve(); audio.removeEventListener('loadedmetadata', handler); };
          audio.addEventListener('loadedmetadata', handler);
        });
      }
      try {
        audio.currentTime = Math.max(0, start + (mp3Offset.value || 0));
      } catch (e) {
        // some browsers may throw if setting currentTime before ready; ignore
      }
      // set playing index and activate corresponding cue for correct highlighting
      playingCueIndex.value = cueIndex;
      applyActiveCue(entry.id);
      await audio.play();
      isPlaying.value = true;
      pendingCueIndex.value = null;
      try {
        const el = paragraphElementByCueId.get(entry.id);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (e) {
        console.error('[TTS] scroll after play failed', e);
      }
      return;
    }

    // WAV slicing flow (existing behavior)
    if (partialBlobUrl.value) URL.revokeObjectURL(partialBlobUrl.value);
    const blob = await fetchWavSliceAsBlob(url, start, end);
    partialBlobUrl.value = URL.createObjectURL(blob);
    audio.src = partialBlobUrl.value;
    audio.currentTime = 0;
    // set playing index and activate corresponding cue for correct highlighting
    playingCueIndex.value = cueIndex;
    applyActiveCue(entry.id);
    await audio.play();
    isPlaying.value = true;
    // clear any pending cue since we've started playback
    pendingCueIndex.value = null;
    // Ensure the playing paragraph is visible after playback actually starts
    try {
      const el = paragraphElementByCueId.get(entry.id);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (e) {
      console.error('[TTS] scroll after play failed', e);
    }
    for (let i = 1; i <= prefetchCount; i++) {
      const next = cues.value[cueIndex + i];
      if (!next) break;
      fetchWavSliceAsBlob(url, next.start, next.end + 0.5).catch(() => {});
    }
  } finally {
    loading.value = false;
  }
}

function bindAudioEvents() {
  const audio = audioRef.value;
  if (!audio) return;

  audio.addEventListener('timeupdate', onAudioTimeUpdate);
  audio.addEventListener('play', onAudioPlay);
  audio.addEventListener('pause', onAudioPause);
  audio.addEventListener('ended', onAudioEnded);
}

function unbindAudioEvents() {
  const audio = audioRef.value;
  if (!audio) return;

  audio.removeEventListener('timeupdate', onAudioTimeUpdate);
  audio.removeEventListener('play', onAudioPlay);
  audio.removeEventListener('pause', onAudioPause);
  audio.removeEventListener('ended', onAudioEnded);
  // no-op: MP3 timing handled via timeupdate; no scheduled timers to clear
}

function mapParagraphsToCues() {
  clearCueMappings();

  if (!readAloudEnabled.value || !cues.value.length) return;

  const nodes = getReadableParagraphNodes();
  if (!nodes.length) return;

  const runtimeEntries = nodes
    .map((node) => {
      function extractNodeReadableText(n) {
        let text = (n.textContent || '').trim();
        // prefer explicit figcaption if present
        if (!text && n.querySelector) {
          const figcap = n.querySelector('figcaption');
          if (figcap && figcap.textContent) text = figcap.textContent.trim();
        }
        // fallback to image alt/title/aria-label
        if (!text && n.querySelector) {
          const img = n.querySelector('img');
          if (img) {
            text = (img.alt || img.getAttribute('title') || img.getAttribute('aria-label') || '').trim();
            // if still empty, fallback to the markdown-style image token with original src
            if (!text) {
              const src = img.getAttribute('src') || '';
              if (src) text = `![]（${src}）`;
            }
          }
        }
        // fallback to attributes on the node itself
        if (!text && n.getAttribute) {
          text = (n.getAttribute('aria-label') || n.getAttribute('title') || '').trim();
        }
        return cleanTextForTTS(text || '');
      }

      const cleanText = extractNodeReadableText(node);
      if (!cleanText) return null;

      return { node, cleanText, fingerprint: createStableFingerprint(cleanText), altFingerprint: createStableFingerprint(cleanText.replace(/\s+/g, '')) };
    })
    .filter((entry): entry is { node: HTMLElement; cleanText: string; fingerprint: string } => !!entry);

  const usedNodeIndexes = new Set<number>();

  cues.value.forEach((cue, cueIndex) => {
    let matchedIndex = -1;
    const cueCleanText = cleanTextForTTS(cue.text || '');

    function normalizedLevenshtein(a, b) {
      const sa = a || '';
      const sb = b || '';
      const m = sa.length;
      const n = sb.length;
      if (!m || !n) return Math.max(m, n);
      const maxLen = Math.max(m, n);
      const dp = new Array(n + 1);
      for (let j = 0; j <= n; j++) dp[j] = j;
      for (let i = 1; i <= m; i++) {
        let prev = dp[0];
        dp[0] = i;
        let minRow = dp[0];
        for (let j = 1; j <= n; j++) {
          const cur = dp[j];
          const cost = sa.charCodeAt(i - 1) === sb.charCodeAt(j - 1) ? 0 : 1;
          const v = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
          prev = cur;
          dp[j] = v;
          if (v < minRow) minRow = v;
        }
        if (minRow / maxLen > 0.12) return 1.0;
      }
      const dist = dp[n];
      return dist / Math.max(1, Math.max(m, n));
    }

    if (cueIndex < runtimeEntries.length && !usedNodeIndexes.has(cueIndex)) {
      const exact = runtimeEntries[cueIndex];
      if (exact.fingerprint === cue.fingerprint || exact.altFingerprint === cue.fingerprint) {
        matchedIndex = cueIndex;
      } else {
        const sim = normalizedLevenshtein(cueCleanText, exact.cleanText);
        if (sim <= 0.06) matchedIndex = cueIndex;
      }
    }

    if (matchedIndex < 0) {
      const start = Math.max(0, cueIndex - 6);
      const end = Math.min(runtimeEntries.length - 1, cueIndex + 6);
      for (let i = start; i <= end; i++) {
        if (usedNodeIndexes.has(i)) continue;
        const entry = runtimeEntries[i];
        if (entry.fingerprint === cue.fingerprint || entry.altFingerprint === cue.fingerprint) {
          matchedIndex = i;
          break;
        }
        const sim = normalizedLevenshtein(cueCleanText, entry.cleanText);
        if (sim <= 0.06) {
          matchedIndex = i;
          break;
        }
      }
    }

    if (matchedIndex < 0) {
      for (let i = 0; i < runtimeEntries.length; i++) {
        if (usedNodeIndexes.has(i)) continue;
        const entry = runtimeEntries[i];
        if (entry.fingerprint === cue.fingerprint || entry.altFingerprint === cue.fingerprint) {
          matchedIndex = i;
          break;
        }
        const sim = normalizedLevenshtein(cueCleanText, entry.cleanText);
        if (sim <= 0.06) {
          matchedIndex = i;
          break;
        }
      }
    }

    if (matchedIndex < 0) {
      return;
    }

    usedNodeIndexes.add(matchedIndex);
    const element = runtimeEntries[matchedIndex].node;

    element.classList.add('read-aloud-seekable');
    element.dataset.readAloudId = cue.id;

    paragraphElementByCueId.set(cue.id, element);
    cueIdByParagraphEl.set(element, cue.id);
    activeCueById.set(cue.id, cue);
  });

  onAudioTimeUpdate();
  // Diagnostic: report mapping stats and sample fingerprints
  try {
    const sampleRuntime = Array.from(runtimeEntries.slice(0, 6)).map(r => ({fp: r.fingerprint, alt: r.altFingerprint}));
    const sampleCues = Array.from(cues.value.slice(0, 6)).map(c => c.fingerprint || null);
    console.log('[TTS][DEBUG] runtime entries', runtimeEntries.length, 'cues', cues.value.length, 'sampleRuntimeFp', sampleRuntime, 'sampleCuesFp', sampleCues, 'matchedCount', paragraphElementByCueId.size || 0);
  } catch (e) {
    console.error('[TTS][DEBUG] mapping debug failed', e);
  }
}

function handleParagraphClick(event: Event) {
  const mouseEvent = event as MouseEvent;
  if (mouseEvent.defaultPrevented) return;

  const target = mouseEvent.target as HTMLElement | null;
  if (!target) return;

  if (target.closest('a, button, input, textarea, select, summary')) {
    return;
  }

  const selectedText = window.getSelection()?.toString().trim();
  if (selectedText) {
    return;
  }

  const paragraph = target.closest<HTMLElement>('[data-read-aloud-id]');
  if (!paragraph) return;

  const cueId = cueIdByParagraphEl.get(paragraph) || paragraph.dataset.readAloudId;
  if (!cueId) return;

  const cue = activeCueById.get(cueId);
  if (!cue) return;

  // play this cue using partial fetch
  // If currently playing, jump and play. If paused, only seek/highlight and update time.
  if (isPlaying.value) {
    void loadAndPlayCue(cue.index).catch(() => {
      isPlaying.value = false;
    });
  } else {
    // paused: update UI/time/highlight but don't start playback
    currentSeconds.value = cue.start;
    applyActiveCue(cue.id);
    // remember this cue so when user clicks play we start from here
    pendingCueIndex.value = cue.index;
  }
}

function attachParagraphClickHandler() {
  detachParagraphClickHandler();
  if (!contentRoot) return;

  contentClickHandler = handleParagraphClick;
  contentRoot.addEventListener('click', contentClickHandler, true);
}

function detachParagraphClickHandler() {
  if (!contentRoot || !contentClickHandler) return;
  contentRoot.removeEventListener('click', contentClickHandler, true);
  contentClickHandler = null;
}

function attachMutationObserver() {
  detachMutationObserver();
  if (!contentRoot) return;

  mutationObserver = new MutationObserver(() => {
    queueRescanParagraphs();
  });

  mutationObserver.observe(contentRoot, {
    childList: true,
    subtree: true,
    characterData: true
  });
}

function detachMutationObserver() {
  if (!mutationObserver) return;
  mutationObserver.disconnect();
  mutationObserver = null;
}

async function loadReadAloudAssets() {
  loading.value = true;
  errorMessage.value = '';
  audioSrc.value = '';
  cues.value = [];
  clearCueMappings();

  if (!readAloudEnabled.value) {
    loading.value = false;
    return;
  }

  try {
    console.log('[TTS] loadReadAloudAssets: fetching manifest /tts/manifest.json');
    const manifest = await fetchJson<ManifestFile>('/tts/manifest.json');
    console.log('[TTS] manifest loaded', manifest && typeof manifest === 'object' ? Object.keys(manifest.entries || {}) : manifest);
    const rawRoutePath = typeof route.path === 'string' ? decodeURIComponent(route.path) : String(route.path);
    const normalizedRoute = normalizeRoutePath(rawRoutePath);
    console.log('[TTS] route.path raw/decoded', route.path, rawRoutePath, 'normalizedRoute', normalizedRoute);
    const entry = manifest.entries[normalizedRoute] || manifest.entries[`${normalizedRoute}/`];

    console.log('[TTS] manifest entry for route', normalizedRoute, entry);

    if (!entry?.audio || !entry?.cues) {
      throw new Error('本页尚未生成朗读资源');
    }

    console.log('[TTS] fetching cues file', entry.cues);
    const cuesFile = await fetchJson<{ cues: ReadAloudCue[] }>(entry.cues);
    const loadedCues = Array.isArray(cuesFile.cues) ? cuesFile.cues : [];

    console.log('[TTS] loaded cues count', loadedCues.length);

    if (!loadedCues.length) {
      throw new Error('朗读时间轴为空');
    }

    audioSrc.value = entry.audio;
    cues.value = loadedCues;
    console.log('[TTS] set audioSrc', audioSrc.value);
    // If MP3, estimate encoder delay/leading silence to align WAV-based cues
    if (typeof audioSrc.value === 'string' && audioSrc.value.toLowerCase().endsWith('.mp3')) {
      try {
        mp3Offset.value = await estimateMp3Offset(audioSrc.value);
        console.log('[TTS] estimated mp3 offset (s)', mp3Offset.value);
      } catch (e) {
        console.warn('[TTS] mp3 offset estimation failed', e);
        mp3Offset.value = 0;
      }
    } else {
      mp3Offset.value = 0;
    }

    await nextTick();
    mapParagraphsToCues();
    attachParagraphClickHandler();
    attachMutationObserver();
  } catch (error) {
    const message = error instanceof Error ? error.message : '朗读资源加载失败';
    errorMessage.value = message;
  } finally {
    loading.value = false;
  }
}

async function togglePlayback() {
  const audio = audioRef.value;
  if (!audio || !hasPlayableAudio.value || loading.value) return;

  if (audio.paused) {
    // If user previously clicked a paragraph while paused, start from that pending cue.
    if (pendingCueIndex.value !== null) {
      const startIndex = pendingCueIndex.value;
      pendingCueIndex.value = null;
      await loadAndPlayCue(startIndex).catch((err) => {
        errorMessage.value = err?.message || '无法加载音频片段';
        isPlaying.value = false;
        console.error('loadAndPlayCue error', err);
      });
      return;
    }

    // Otherwise, if we have a partial blob loaded, resume it. Otherwise start via partial-load of the current cue.
    if (audio.src && audio.src.startsWith('blob:')) {
      await audio.play().catch(() => {
        errorMessage.value = '浏览器阻止自动播放，请再次点击开始朗读';
        isPlaying.value = false;
      });
      // clear pending just in case
      pendingCueIndex.value = null;
      // scroll current active cue into view after resume
      try {
        if (currentCueId.value) {
          const el = paragraphElementByCueId.get(currentCueId.value);
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      } catch (e) {
        console.error('[TTS] scroll on resume failed', e);
      }
      return;
    }

    // find cue index to start from
    let startIndex = 0;
    if (currentCueId.value) {
      const cue = activeCueById.get(currentCueId.value);
      if (cue) startIndex = cue.index;
    }
    await loadAndPlayCue(startIndex).catch((err) => {
      errorMessage.value = err?.message || '无法加载音频片段';
      isPlaying.value = false;
      console.error('loadAndPlayCue error', err);
    });
    return;
  }

  audio.pause();
}

function formatTimeAsMinSec(sec: number) {
  if (!Number.isFinite(sec) || sec <= 0) return '0:00';
  const minutes = Math.floor(sec / 60);
  const seconds = Math.floor(sec % 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

const totalSeconds = computed(() => {
  if (cues.value.length) {
    return cues.value[cues.value.length - 1].end || 0;
  }
  const audio = audioRef.value;
  if (audio && Number.isFinite(audio.duration) && audio.duration > 0) return audio.duration;
  return 0;
});

const currentTimeDisplay = computed(() => formatTimeAsMinSec(currentSeconds.value));
const totalTimeDisplay = computed(() => formatTimeAsMinSec(totalSeconds.value));

function computeFloatPosition() {
  // Default offset from viewport right
  const baseOffset = 24;
  const insideContentMargin = 0; // tightly hug content right edge (0px)
  try {
    // Try to find the main doc/content area used by VitePress
    const docEl = document.querySelector('.vp-doc') || document.querySelector('main') || document.querySelector('.theme-default') || null;
    if (!docEl) {
      floatStyle.value = { right: `${baseOffset}px` };
      return;
    }
    const rect = docEl.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    // compute distance from viewport right to doc right; we want the ball to sit inside doc's right edge
    // Position the float button so it sits flush with the content's inner right edge (ignore container padding)
    // Prefer specific inner container selectors that hold readable content
    let contentRect = rect;
    try {
      const inner = docEl.querySelector('.container, .content, .content-container');
      if (inner instanceof Element) {
        const innerRect = inner.getBoundingClientRect();
        const cs = window.getComputedStyle(inner);
        const padRight = parseFloat(cs.paddingRight || '0') || 0;
        // content's visual inner right edge excludes paddingRight
        const innerContentRight = innerRect.right - padRight;
        contentRect = { ...contentRect, right: innerContentRight } as DOMRect;
      }
    } catch (e) {
      // fallback to docEl rect
    }

    const gapToContent = Math.max(0, Math.round(viewportWidth - (contentRect as any).right + insideContentMargin));
    // Only apply tight hugging on desktop widths
    if ((window.innerWidth || document.documentElement.clientWidth) >= 960) {
      floatStyle.value = { right: `${gapToContent}px` };
    } else {
      floatStyle.value = { right: `${baseOffset}px` };
    }
  } catch (err) {
    floatStyle.value = { right: `${baseOffset}px` };
  }
}

let resizeObserver: any = null;
onMounted(() => {
  computeFloatPosition();
  window.addEventListener('resize', computeFloatPosition);
  // Also observe layout changes that might affect content width
  try {
    const docEl = document.querySelector('.vp-doc') || document.querySelector('main') || document.querySelector('.theme-default');
    if (docEl && ('ResizeObserver' in window)) {
      resizeObserver = new (window as any).ResizeObserver(() => computeFloatPosition());
      resizeObserver.observe(docEl);
    }
  } catch (e) {
    // ignore
  }
  console.log('[TTS] ArticleReadAloud mounted (positioning)');
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', computeFloatPosition);
  try {
    if (resizeObserver && resizeObserver.disconnect) resizeObserver.disconnect();
  } catch (e) {}
});

watch(
  () => route.path,
  async () => {
    unbindAudioEvents();
    clearCueMappings();
    detachParagraphClickHandler();
    detachMutationObserver();

    await nextTick();
    await loadReadAloudAssets();
    bindAudioEvents();
  }
);

watch(readAloudEnabled, async (enabled) => {
  if (enabled) {
    await loadReadAloudAssets();
    bindAudioEvents();
    return;
  }

  const audio = audioRef.value;
  if (audio && !audio.paused) {
    audio.pause();
  }

  unbindAudioEvents();
  clearCueMappings();
  detachParagraphClickHandler();
  detachMutationObserver();
  audioSrc.value = '';
  cues.value = [];
  errorMessage.value = '';
});

onMounted(async () => {
  console.log('[TTS] ArticleReadAloud onMounted - loading assets start', { route: route.path, readAloudEnabled: readAloudEnabled.value });
  await nextTick();
  await loadReadAloudAssets();
  bindAudioEvents();
});

onUnmounted(() => {
  if (rescanRaf) {
    cancelAnimationFrame(rescanRaf);
    rescanRaf = 0;
  }

  unbindAudioEvents();
  clearCueMappings();
  detachParagraphClickHandler();
  detachMutationObserver();
  if (partialBlobUrl.value) {
    try { URL.revokeObjectURL(partialBlobUrl.value); } catch (e) {}
    partialBlobUrl.value = null;
  }
  // no-op: MP3 timing handled via timeupdate; no scheduled timers to clear
});
</script>

<template>
  <div v-if="readAloudEnabled" class="read-aloud-float-container" :style="floatStyle">
    <button
      class="read-aloud-ball"
      :class="{ 'is-playing': isPlaying, 'is-loading': loading }"
      type="button"
      :disabled="loading || !hasPlayableAudio"
      :aria-disabled="loading || !hasPlayableAudio"
      :aria-label="isPlaying ? '暂停朗读' : '开始朗读'"
      @click="togglePlayback"
    >
      <div class="read-aloud-times">
        <span class="current-time">{{ currentTimeDisplay }}</span>
        <span class="total-time">{{ totalTimeDisplay }}</span>
      </div>

      <!-- background icon placed under the timestamps (visual background) -->
      <svg class="read-aloud-bg-icon" width="36" height="36" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <g v-if="!isPlaying" fill="currentColor">
          <!-- play triangle for paused state -->
          <path d="M8 5v14l11-7z" />
        </g>
        <g v-else fill="currentColor">
          <!-- stop square for playing state -->
          <rect x="6" y="6" width="12" height="12" rx="1.5" />
        </g>
      </svg>
    </button>

    <audio
      ref="audioRef"
      :src="audioSrc"
      preload="metadata"
      class="read-aloud-audio"
    ></audio>
  </div>
</template>
