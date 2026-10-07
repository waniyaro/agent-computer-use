export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CoordinateTransformOptions {
  windowBounds: Bounds;
  screenshotSize?: { width: number; height: number };
  scaleFactor?: number; // По умолчанию определяется как screenshot.width / windowBounds.width (обычно 2.0 для Retina)
}

export interface NormalizedPoint {
  // Координаты от 0.0 до 1.0 относительно верхнего левого угла целевого окна
  x_pct: number; // 0.0 ... 1.0
  y_pct: number; // 0.0 ... 1.0
}

/**
 * Ограничивает значение диапазоном [min, max] (по умолчанию [0, 1]).
 */
export function clamp(val: number, min = 0, max = 1): number {
  if (Number.isNaN(val)) return min;
  return Math.max(min, Math.min(max, val));
}

/**
 * Нормализует координаты в физических пикселях скриншота в диапазон [0.0..1.0]
 * относительно левого верхнего угла окна с автоматическим clamp.
 */
export function normalizeFromScreenshot(
  pixelX: number,
  pixelY: number,
  shotW: number,
  shotH: number
): NormalizedPoint {
  if (shotW <= 0 || shotH <= 0) {
    return { x_pct: 0, y_pct: 0 };
  }
  return {
    x_pct: clamp(pixelX / shotW, 0, 1),
    y_pct: clamp(pixelY / shotH, 0, 1),
  };
}

/**
 * Преобразует нормализованную точку [0.0..1.0] в абсолютные логические координаты экрана
 * (screen coordinates) с учётом положения окна (глобальные оффсеты x, y для нескольких мониторов).
 */
export function toLogicalScreenPoint(
  norm: NormalizedPoint,
  windowBounds: Bounds
): { screenX: number; screenY: number } {
  const clampedX = clamp(norm.x_pct, 0, 1);
  const clampedY = clamp(norm.y_pct, 0, 1);
  return {
    screenX: Math.round(windowBounds.x + clampedX * windowBounds.width),
    screenY: Math.round(windowBounds.y + clampedY * windowBounds.height),
  };
}

/**
 * Преобразует нормализованную точку [0.0..1.0] в логические координаты внутри окна (window-local)
 * от 0 до width / height.
 */
export function toLogicalWindowPoint(
  norm: NormalizedPoint,
  windowBounds: { width: number; height: number }
): { windowX: number; windowY: number } {
  const clampedX = clamp(norm.x_pct, 0, 1);
  const clampedY = clamp(norm.y_pct, 0, 1);
  return {
    windowX: Math.round(clampedX * windowBounds.width),
    windowY: Math.round(clampedY * windowBounds.height),
  };
}

/**
 * Вычисляет коэффициент масштабирования (scale factor) для Retina экранов.
 * Если передан явно — используется он, иначе screenshot.width / windowBounds.width.
 */
export function resolveScaleFactor(options: CoordinateTransformOptions): number {
  if (typeof options.scaleFactor === 'number' && options.scaleFactor > 0) {
    return options.scaleFactor;
  }
  if (
    options.screenshotSize &&
    options.screenshotSize.width > 0 &&
    options.windowBounds.width > 0
  ) {
    return Number((options.screenshotSize.width / options.windowBounds.width).toFixed(2));
  }
  return 1.0;
}

/**
 * Преобразует физические пиксели скриншота в логические координаты окна.
 */
export function pixelToLogicalWindow(
  pixelX: number,
  pixelY: number,
  options: CoordinateTransformOptions
): { windowX: number; windowY: number } {
  const scale = resolveScaleFactor(options);
  const shotW = options.screenshotSize?.width ?? options.windowBounds.width * scale;
  const shotH = options.screenshotSize?.height ?? options.windowBounds.height * scale;
  const norm = normalizeFromScreenshot(pixelX, pixelY, shotW, shotH);
  return toLogicalWindowPoint(norm, options.windowBounds);
}

/**
 * Преобразует физические пиксели скриншота в глобальные экранные логические координаты.
 */
export function pixelToLogicalScreen(
  pixelX: number,
  pixelY: number,
  options: CoordinateTransformOptions
): { screenX: number; screenY: number } {
  const scale = resolveScaleFactor(options);
  const shotW = options.screenshotSize?.width ?? options.windowBounds.width * scale;
  const shotH = options.screenshotSize?.height ?? options.windowBounds.height * scale;
  const norm = normalizeFromScreenshot(pixelX, pixelY, shotW, shotH);
  return toLogicalScreenPoint(norm, options.windowBounds);
}
