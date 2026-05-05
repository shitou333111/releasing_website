export const TREEHOLE_MAX_IMAGE_SIZE_MB = 5;
export const TREEHOLE_MAX_IMAGE_SIZE_BYTES = TREEHOLE_MAX_IMAGE_SIZE_MB * 1024 * 1024;
export const TREEHOLE_MAX_IMAGE_FILES = 1;

export function validateImageFiles(files: File[]): string | null {
  if (files.length > TREEHOLE_MAX_IMAGE_FILES) {
    return `每条内容最多上传 ${TREEHOLE_MAX_IMAGE_FILES} 张图片`;
  }

  const oversize = files.find((file) => file.size > TREEHOLE_MAX_IMAGE_SIZE_BYTES);
  if (oversize) {
    return `图片 ${oversize.name} 超过 ${TREEHOLE_MAX_IMAGE_SIZE_MB}MB 限制`;
  }

  return null;
}
