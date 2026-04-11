export function normalizePagePath(path: string): string {
  const raw = (path || '/').trim();

  if (!raw) return '/';

  let normalized = raw.split('?')[0].split('#')[0];

  if (!normalized.startsWith('/')) {
    normalized = `/${normalized}`;
  }

  normalized = normalized.replace(/\/index\.html$/i, '');

  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }

  return normalized || '/';
}