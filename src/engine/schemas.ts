import { z } from 'zod';

export const VisualClickInputSchema = z
  .object({
    window_id: z.number().int({ message: 'window_id must be an integer' }),
    pid: z.number().int({ message: 'pid must be an integer' }).optional(),
    button: z.enum(['left', 'right', 'double']).default('left'),
    x_percent: z.number().min(0).max(1).optional(),
    y_percent: z.number().min(0).max(1).optional(),
    x_pixel: z.number().optional(),
    y_pixel: z.number().optional(),
    screenshot_width: z.number().positive().optional(),
    screenshot_height: z.number().positive().optional(),
    debug_image_out: z.string().optional(),
    delivery_mode: z.enum(['foreground', 'background']).optional(),
  })
  .refine(
    (data) => {
      const hasPercent =
        typeof data.x_percent === 'number' && typeof data.y_percent === 'number';
      const hasPixels =
        typeof data.x_pixel === 'number' && typeof data.y_pixel === 'number';
      return hasPercent || hasPixels;
    },
    {
      message:
        'Must provide either (x_percent, y_percent [0.0..1.0]) or (x_pixel, y_pixel)',
      path: ['coordinates'],
    }
  );

export type VisualClickInput = z.infer<typeof VisualClickInputSchema>;

export const ClipboardPasteInputSchema = z.object({
  window_id: z.number().int({ message: 'window_id must be an integer' }),
  pid: z.number().int({ message: 'pid must be an integer' }).optional(),
  text: z.string({ message: 'text must be a string' }),
});

export type ClipboardPasteInput = z.infer<typeof ClipboardPasteInputSchema>;

export const ClickInputSchema = z.object({
  window_id: z.number().int({ message: 'window_id must be an integer' }),
  pid: z.number().int({ message: 'pid must be an integer' }).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  button: z.enum(['left', 'right', 'double']).default('left').optional(),
  count: z.number().int().optional(),
  delivery_mode: z.enum(['foreground', 'background']).optional(),
  debug_image_out: z.string().optional(),
});

export type ClickInput = z.infer<typeof ClickInputSchema>;

export const DoubleClickInputSchema = z.object({
  window_id: z.number().int({ message: 'window_id must be an integer' }),
  pid: z.number().int({ message: 'pid must be an integer' }).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  delivery_mode: z.enum(['foreground', 'background']).optional(),
});

export type DoubleClickInput = z.infer<typeof DoubleClickInputSchema>;

export const RightClickInputSchema = z.object({
  window_id: z.number().int({ message: 'window_id must be an integer' }),
  pid: z.number().int({ message: 'pid must be an integer' }).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  delivery_mode: z.enum(['foreground', 'background']).optional(),
});

export type RightClickInput = z.infer<typeof RightClickInputSchema>;

export const TypeTextInputSchema = z.object({
  window_id: z.number().int({ message: 'window_id must be an integer' }).optional(),
  pid: z.number().int({ message: 'pid must be an integer' }).optional(),
  text: z.string({ message: 'text must be a string' }),
  delivery_mode: z.enum(['foreground', 'background']).optional(),
});

export type TypeTextInput = z.infer<typeof TypeTextInputSchema>;

export const PressKeyInputSchema = z.object({
  window_id: z.number().int({ message: 'window_id must be an integer' }).optional(),
  pid: z.number().int({ message: 'pid must be an integer' }).optional(),
  key: z.string().min(1, 'Key name cannot be empty'),
  delivery_mode: z.enum(['foreground', 'background']).optional(),
});

export type PressKeyInput = z.infer<typeof PressKeyInputSchema>;

export const HotkeyInputSchema = z.object({
  window_id: z.number().int({ message: 'window_id must be an integer' }).optional(),
  pid: z.number().int({ message: 'pid must be an integer' }).optional(),
  keys: z.array(z.string().min(1, 'Key name cannot be empty')).min(1, 'keys array must contain at least one key'),
  delivery_mode: z.enum(['foreground', 'background']).optional(),
});

export type HotkeyInput = z.infer<typeof HotkeyInputSchema>;

export const ScrollInputSchema = z.object({
  window_id: z.number().int({ message: 'window_id must be an integer' }).optional(),
  pid: z.number().int({ message: 'pid must be an integer' }).optional(),
  delta_x: z.number().optional(),
  delta_y: z.number().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  delivery_mode: z.enum(['foreground', 'background']).optional(),
});

export type ScrollInput = z.infer<typeof ScrollInputSchema>;

export const ActionSequenceStepSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('click'),
    window_id: z.number().int().optional(),
    pid: z.number().int().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    x_pixel: z.number().optional(),
    y_pixel: z.number().optional(),
    x_percent: z.number().min(0).max(1).optional(),
    y_percent: z.number().min(0).max(1).optional(),
    button: z.enum(['left', 'right', 'double']).default('left'),
    delivery_mode: z.enum(['foreground', 'background']).optional(),
  }),
  z.object({
    action: z.literal('double_click'),
    window_id: z.number().int().optional(),
    pid: z.number().int().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    x_pixel: z.number().optional(),
    y_pixel: z.number().optional(),
    x_percent: z.number().min(0).max(1).optional(),
    y_percent: z.number().min(0).max(1).optional(),
    delivery_mode: z.enum(['foreground', 'background']).optional(),
  }),
  z.object({
    action: z.literal('right_click'),
    window_id: z.number().int().optional(),
    pid: z.number().int().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    x_pixel: z.number().optional(),
    y_pixel: z.number().optional(),
    x_percent: z.number().min(0).max(1).optional(),
    y_percent: z.number().min(0).max(1).optional(),
    delivery_mode: z.enum(['foreground', 'background']).optional(),
  }),
  z.object({
    action: z.literal('paste'),
    window_id: z.number().int().optional(),
    pid: z.number().int().optional(),
    text: z.string({ message: 'text is required for paste action' }),
  }),
  z.object({
    action: z.literal('type'),
    window_id: z.number().int().optional(),
    pid: z.number().int().optional(),
    text: z.string({ message: 'text is required for type action' }),
  }),
  z.object({
    action: z.literal('hotkey'),
    window_id: z.number().int().optional(),
    pid: z.number().int().optional(),
    keys: z.array(z.string()).min(1, 'keys array must contain at least one key'),
  }),
  z.object({
    action: z.literal('sleep'),
    ms: z.number().positive('ms must be positive'),
  }),
]);

export type ActionSequenceStep = z.infer<typeof ActionSequenceStepSchema>;

export const ExecuteActionSequenceInputSchema = z
  .object({
    window_id: z.number().int({ message: 'window_id must be an integer' }).optional(),
    pid: z.number().int({ message: 'pid must be an integer' }).optional(),
    delivery_mode: z.enum(['foreground', 'background']).optional(),
    delay_between_ms: z.number().nonnegative().default(100),
    steps: z.array(ActionSequenceStepSchema).optional(),
    actions: z.array(ActionSequenceStepSchema).optional(),
  })
  .refine(
    (data) => Boolean((data.steps && data.steps.length > 0) || (data.actions && data.actions.length > 0)),
    {
      message: "execute_action_sequence requires either 'steps' or 'actions' with at least one step",
      path: ['steps'],
    }
  )
  .transform((data) => {
    const rawSteps = data.steps ?? data.actions ?? [];
    return {
      window_id: data.window_id,
      pid: data.pid,
      delivery_mode: data.delivery_mode,
      delay_between_ms: data.delay_between_ms,
      steps: rawSteps,
    };
  });

export type ExecuteActionSequenceInput = z.infer<typeof ExecuteActionSequenceInputSchema>;

export const PressHotkeyInputSchema = z.object({
  window_id: z.number().int({ message: 'window_id must be an integer' }),
  pid: z.number().int({ message: 'pid must be an integer' }).optional(),
  keys: z
    .array(z.string().min(1, 'Key name cannot be empty'))
    .min(1, { message: 'keys array must contain at least one key' }),
});

export type PressHotkeyInput = z.infer<typeof PressHotkeyInputSchema>;

export const GetWindowScreenshotInputSchema = z.object({
  window_id: z.number().int({ message: 'window_id must be an integer' }),
  pid: z.number().int({ message: 'pid must be an integer' }).optional(),
  save_to_file: z.string().optional(),
  include_image: z.boolean().default(true).optional(),
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
