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

/**
 * Optimizes screenshot buffer (downsampling resolution and converting to JPEG)
 * using macOS native hardware-accelerated /usr/bin/sips.
 */
export function optimizeScreenshot(
  inputBuffer: Buffer,
  options: OptimizeImageOptions = {}
): OptimizedImageResult {
  const maxWidth = options.maxWidth ?? 1440;
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

  // Check if optimization should be skipped (e.g. unscaled PNG explicitly requested)
  const shouldDownsample = maxWidth > 0 && originalWidth > maxWidth;
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
      sipsArgs.push('--resampleWidth', String(maxWidth));
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
