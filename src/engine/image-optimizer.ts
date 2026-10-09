import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { logger } from '../utils/logger.js';

export interface OptimizeImageOptions {
  maxWidth?: number;
  format?: 'jpeg' | 'png';
  quality?: number;
}

export interface OptimizedImageResult {
  buffer: Buffer;
  base64: string;
  mimeType: string;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  downscaleRatio: number; // originalWidth / width (>= 1.0)
}

/**
 * Extracts dimensions from JPEG stream without external libraries.
 */
function getJpegDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    return null;
  }
  let i = 2;
  while (i < buf.length - 8) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    // Baseline (0xC0) or Progressive (0xC2) DCT markers
    if (marker === 0xc0 || marker === 0xc2) {
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      return { width, height };
    }
    const len = buf.readUInt16BE(i + 2);
    i += 2 + len;
  }
  return null;
}

export interface TargetImageSizeOptions {
  pxPerToken?: number;
  maxEdgePx?: number;
  maxTokens?: number;
}

export function nTokensForPx(px: number, pxPerToken = 28): number {
  return Math.floor((px - 1) / pxPerToken) + 1;
}

export function nTokensForImg(w: number, h: number, pxPerToken = 28): number {
  return nTokensForPx(w, pxPerToken) * nTokensForPx(h, pxPerToken);
}

/**
 * Calculates the largest (w, h) preserving aspect ratio that satisfies
 * both the long-edge (<= 1568px) and vision tile budget (<= 1568 tiles of 28x28px).
 * Directly ported from Anthropic's reference implementation to guarantee
 * zero server-side silent re-resizing and eliminate click drift (~14% on macOS).
 */
export function targetImageSize(
  width: number,
  height: number,
  options: TargetImageSizeOptions = {}
): [number, number] {
  const pxPerToken = options.pxPerToken ?? 28;
  const maxEdgePx = options.maxEdgePx ?? 1568;
  const maxTokens = options.maxTokens ?? 1568;

  if (
    width <= maxEdgePx &&
    height <= maxEdgePx &&
    nTokensForImg(width, height, pxPerToken) <= maxTokens
  ) {
    return [width, height];
  }

  // Normalize to landscape for the binary search; transpose back afterwards
  if (height > width) {
    const [w, h] = targetImageSize(height, width, options);
    return [h, w];
  }

  const aspect = width / height;
  let lo = 1;
  let hi = width;

  while (true) {
    if (lo + 1 === hi) {
      return [lo, Math.max(Math.round(lo / aspect), 1)];
    }
    const midW = Math.floor((lo + hi) / 2);
    const midH = Math.max(Math.round(midW / aspect), 1);
    if (midW <= maxEdgePx && nTokensForImg(midW, midH, pxPerToken) <= maxTokens) {
      lo = midW;
    } else {
      hi = midW;
    }
  }
}

/**
 * Optimizes screenshot buffer (downsampling resolution and converting to JPEG)
 * using macOS native hardware-accelerated /usr/bin/sips.
 */
export function optimizeScreenshot(
  inputBuffer: Buffer,
  options: OptimizeImageOptions = {}
): OptimizedImageResult {
  const targetFormat = options.format ?? 'jpeg';
  const quality = Math.min(100, Math.max(1, options.quality ?? 80));

  let originalWidth = 0;
  let originalHeight = 0;

  if (inputBuffer.length >= 24) {
    // Standard PNG header dimensions at byte 16 and 20
    originalWidth = inputBuffer.readUInt32BE(16);
    originalHeight = inputBuffer.readUInt32BE(20);
  }

  // If input is not a recognized PNG or no optimization needed, return original
  if (originalWidth === 0 || originalHeight === 0) {
    return {
      buffer: inputBuffer,
      base64: inputBuffer.toString('base64'),
      mimeType: 'image/png',
      width: originalWidth,
      height: originalHeight,
      originalWidth,
      originalHeight,
      downscaleRatio: 1.0,
    };
  }

  // Compute target dimensions:
  // Anthropic's tile budget ensures server-side early return fires and prevents click drift
  const [anthropicW] = targetImageSize(originalWidth, originalHeight);
  const targetWidthLimit = typeof options.maxWidth === 'number'
    ? Math.min(options.maxWidth, anthropicW)
    : anthropicW;

  // Check if optimization should be skipped (e.g. unscaled PNG explicitly requested)
  const shouldDownsample = targetWidthLimit > 0 && originalWidth > targetWidthLimit;
  const shouldConvertToJpeg = targetFormat === 'jpeg';

  if (!shouldDownsample && !shouldConvertToJpeg) {
    return {
      buffer: inputBuffer,
      base64: inputBuffer.toString('base64'),
      mimeType: 'image/png',
      width: originalWidth,
      height: originalHeight,
      originalWidth,
      originalHeight,
      downscaleRatio: 1.0,
    };
  }

  const tmpId = `acu_opt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const inPath = path.join(os.tmpdir(), `${tmpId}.png`);
  const outExtension = targetFormat === 'jpeg' ? 'jpg' : 'png';
  const outPath = path.join(os.tmpdir(), `${tmpId}.${outExtension}`);

  try {
    fs.writeFileSync(inPath, inputBuffer);

    const sipsArgs: string[] = [];
    if (targetFormat === 'jpeg') {
      sipsArgs.push('-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality));
    }
    if (shouldDownsample) {
      sipsArgs.push('--resampleWidth', String(targetWidthLimit));
    }
    sipsArgs.push(inPath, '--out', outPath);

    execFileSync('/usr/bin/sips', sipsArgs, { stdio: 'pipe' });

    const outBuffer = fs.readFileSync(outPath);
    let newWidth = originalWidth;
    let newHeight = originalHeight;

    if (targetFormat === 'jpeg') {
      const dims = getJpegDimensions(outBuffer);
      if (dims) {
        newWidth = dims.width;
        newHeight = dims.height;
      }
    } else if (outBuffer.length >= 24) {
      newWidth = outBuffer.readUInt32BE(16);
      newHeight = outBuffer.readUInt32BE(20);
    }

    const downscaleRatio = newWidth > 0 ? Number((originalWidth / newWidth).toFixed(4)) : 1.0;

    return {
      buffer: outBuffer,
      base64: outBuffer.toString('base64'),
      mimeType: targetFormat === 'jpeg' ? 'image/jpeg' : 'image/png',
      width: newWidth,
      height: newHeight,
      originalWidth,
      originalHeight,
      downscaleRatio,
    };
  } catch (err) {
    logger.warn('Image optimization with sips failed; falling back to original PNG:', err);
    return {
      buffer: inputBuffer,
      base64: inputBuffer.toString('base64'),
      mimeType: 'image/png',
      width: originalWidth,
      height: originalHeight,
      originalWidth,
      originalHeight,
      downscaleRatio: 1.0,
    };
  } finally {
    try {
      if (fs.existsSync(inPath)) fs.unlinkSync(inPath);
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    } catch {
      // ignore temp cleanup error
    }
  }
}
