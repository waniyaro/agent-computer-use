import { z } from 'zod';

export const VisualClickInputSchema = z
  .object({
    window_id: z.number().int({ message: 'window_id must be an integer' }),
    pid: z.number().int({ message: 'pid must be an integer' }),
    button: z.enum(['left', 'right', 'double']).default('left'),
    x_percent: z.number().min(0).max(1).optional(),
    y_percent: z.number().min(0).max(1).optional(),
    x_pixel: z.number().optional(),
    y_pixel: z.number().optional(),
    screenshot_width: z.number().positive().optional(),
    screenshot_height: z.number().positive().optional(),
  })
  .refine(
    (data) => {
      const hasPercent =
        typeof data.x_percent === 'number' && typeof data.y_percent === 'number';
      const hasPixels =
        typeof data.x_pixel === 'number' &&
        typeof data.y_pixel === 'number' &&
        typeof data.screenshot_width === 'number' &&
        typeof data.screenshot_height === 'number';
      return hasPercent || hasPixels;
    },
    {
      message:
        'Must provide either (x_percent, y_percent [0.0..1.0]) or (x_pixel, y_pixel, screenshot_width, screenshot_height)',
      path: ['coordinates'],
    }
  );

export type VisualClickInput = z.infer<typeof VisualClickInputSchema>;

export const PressHotkeyInputSchema = z.object({
  window_id: z.number().int({ message: 'window_id must be an integer' }),
  pid: z.number().int({ message: 'pid must be an integer' }),
  keys: z
    .array(z.string().min(1, 'Key name cannot be empty'))
    .min(1, { message: 'keys array must contain at least one key' }),
});

export type PressHotkeyInput = z.infer<typeof PressHotkeyInputSchema>;

export const GetWindowScreenshotInputSchema = z.object({
  window_id: z.number().int({ message: 'window_id must be an integer' }),
  pid: z.number().int({ message: 'pid must be an integer' }),
});

export type GetWindowScreenshotInput = z.infer<typeof GetWindowScreenshotInputSchema>;

const MODIFIER_NAMES: ReadonlySet<string> = new Set([
  'cmd',
  'command',
  'ctrl',
  'control',
  'alt',
  'option',
  'opt',
  'shift',
  'fn',
]);

export function canonicalizeKey(key: string): string {
  const k = key.trim().toLowerCase();
  switch (k) {
    case 'command':
    case 'cmd':
      return 'cmd';
    case 'control':
    case 'ctrl':
      return 'ctrl';
    case 'option':
    case 'alt':
    case 'opt':
      return 'option';
    case 'shift':
      return 'shift';
    case 'fn':
      return 'fn';
    case 'enter':
    case 'return':
      return 'return';
    case 'esc':
    case 'escape':
      return 'escape';
    case 'space':
    case 'spacebar':
      return 'space';
    case 'tab':
      return 'tab';
    case 'backspace':
    case 'delete':
    case 'del':
      return 'delete';
    case 'arrowup':
    case 'up':
      return 'up';
    case 'arrowdown':
    case 'down':
      return 'down';
    case 'arrowleft':
    case 'left':
      return 'left';
    case 'arrowright':
    case 'right':
      return 'right';
    default:
      return key.length === 1 ? key.toLowerCase() : k;
  }
}

export function isModifierKey(key: string): boolean {
  return MODIFIER_NAMES.has(key.trim().toLowerCase());
}

export interface ParsedHotkey {
  isSingleKey: boolean;
  singleKey?: string;
  chord?: string[];
  modifiers: string[];
}

export function normalizeHotkey(keys: string[]): ParsedHotkey {
  const normalized = keys.map((k) => canonicalizeKey(k));

  if (normalized.length === 1 && !isModifierKey(normalized[0])) {
    return {
      isSingleKey: true,
      singleKey: normalized[0],
      modifiers: [],
    };
  }

  const modifiers: string[] = [];
  let nonModifier: string | undefined;

  for (const k of normalized) {
    if (isModifierKey(k)) {
      if (!modifiers.includes(k)) {
        modifiers.push(k);
      }
    } else {
      nonModifier = k;
    }
  }

  if (modifiers.length > 0 && nonModifier) {
    return {
      isSingleKey: false,
      modifiers,
      chord: [...modifiers, nonModifier],
    };
  }

  // Fallback: multiple keys without non-modifier or single modifier
  return {
    isSingleKey: normalized.length === 1,
    singleKey: normalized[0],
    chord: normalized,
    modifiers,
  };
}
