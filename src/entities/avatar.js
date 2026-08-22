function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('头像读取失败'));
    reader.readAsDataURL(blob);
  });
}

async function bitmapFromBlob(blob) {
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = 'async';
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = url; });
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasBlob(canvas, quality) {
  return new Promise(resolve => canvas.toBlob(resolve, 'image/webp', quality));
}

export async function imageToAvatarDataUrl(source, { maxBytes = 96 * 1024, maxSize = 256 } = {}) {
  if (!source) return null;
  const blob = source instanceof Blob ? source : new Blob([source.data || source], { type: source.mime || 'image/png' });
  const image = await bitmapFromBlob(blob);
  const width = image.width || image.naturalWidth;
  const height = image.height || image.naturalHeight;
  if (!width || !height) throw new Error('无法读取角色头像尺寸');
  const crop = Math.min(width, height);
  let size = Math.min(maxSize, crop);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d', { alpha: true });
    context.drawImage(image, (width - crop) / 2, (height - crop) / 2, crop, crop, 0, 0, size, size);
    for (const quality of [0.86, 0.74, 0.62, 0.5, 0.4]) {
      const output = await canvasBlob(canvas, quality);
      if (output && output.size <= maxBytes) return blobToDataUrl(output);
    }
    size = Math.max(72, Math.floor(size * 0.82));
  }
  throw new Error('头像压缩后仍超过 96 KB，请换用更简单的图片');
}
