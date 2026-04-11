<script setup lang="ts">
import { ref } from 'vue';

type PDFOutlineItem = {
  title: string;
  page: number;
  level?: number;
};

const props = withDefaults(defineProps<{
  items: PDFOutlineItem[];
  viewerId?: string;
  title?: string;
}>(), {
  viewerId: '',
  title: ''
});

const activePage = ref<number | null>(null);

function getLevel(item: PDFOutlineItem): number {
  const level = Number(item.level || 1);
  if (!Number.isFinite(level)) return 1;
  return Math.min(4, Math.max(1, Math.round(level)));
}

function buildItemStyle(item: PDFOutlineItem): Record<string, string> {
  const level = getLevel(item);
  return {
    marginLeft: `${(level - 1) * 12}px`
  };
}

function jumpToPage(item: PDFOutlineItem) {
  activePage.value = item.page;

  document.dispatchEvent(new CustomEvent('pdf-outline-jump', {
    detail: {
      page: item.page,
      viewerId: props.viewerId || undefined,
      source: 'frontmatter-outline'
    }
  }));
}
</script>

<template>
  <nav class="pdf-outline-aside" :aria-label="title || 'PDF outline'">
    <div class="pdf-outline-content">
      <div v-if="title" class="pdf-outline-title" id="pdf-outline-title">
        {{ title }}
      </div>

      <ul class="pdf-outline-list">
        <li v-for="item in items" :key="`${item.title}-${item.page}`" class="pdf-outline-item">
          <button
            type="button"
            class="pdf-outline-link"
            :class="{ active: activePage === item.page }"
            @click="jumpToPage(item)"
          >
            <span class="pdf-outline-link-title" :style="buildItemStyle(item)">{{ item.title }}</span>
            <span class="pdf-outline-link-page">P{{ item.page }}</span>
          </button>
        </li>
      </ul>
    </div>
  </nav>
</template>

<style scoped>
.pdf-outline-content {
  border-left: 1px solid var(--vp-c-divider);
  padding-left: 14px;
}

.pdf-outline-title {
  line-height: 28px;
  font-size: 14px;
  font-weight: 600;
  color: var(--vp-c-text-1);
  margin-bottom: 6px;
}

.pdf-outline-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.pdf-outline-item {
  margin: 0;
  padding: 0;
}

.pdf-outline-link {
  width: 100%;
  border: none;
  padding: 5px 0;
  border-radius: 6px;
  background: transparent;
  color: var(--vp-c-text-2);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  text-align: left;
}

.pdf-outline-link:hover {
  color: var(--vp-c-text-1);
  background: var(--vp-c-bg-soft);
}

.pdf-outline-link.active {
  color: var(--vp-c-brand-1);
  background: color-mix(in srgb, var(--vp-c-brand-1) 12%, transparent);
}

.pdf-outline-link-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-left: 5px;
  font-size: 13px;
  line-height: 1.5;
}

.pdf-outline-link-page {
  flex-shrink: 0;
  margin-right: 5px;
  font-size: 11px;
  color: var(--vp-c-text-3);
}

.pdf-outline-link.active .pdf-outline-link-page {
  color: color-mix(in srgb, var(--vp-c-brand-1) 72%, var(--vp-c-text-2));
}
</style>
