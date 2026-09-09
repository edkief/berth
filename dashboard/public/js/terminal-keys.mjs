export const MAIN_KEYS = [
  { key: 'Escape', label: 'Esc' },
  { key: 'Tab', label: 'Tab' },
  { action: 'modifier', key: 'Control', label: 'Ctrl' },
  { action: 'modifier', key: 'Alt', label: 'Alt' },
  { key: '/', label: '/' },
  { action: 'layout', key: 'function', label: 'FN' },
  { key: 'Home', label: 'Home' },
  { key: 'ArrowUp', label: '↑', ariaLabel: 'Up arrow' },
  { key: 'End', label: 'End' },
  { key: 'PageUp', label: 'PgUp' },
  { key: 'ArrowLeft', label: '←', ariaLabel: 'Left arrow' },
  { key: 'ArrowDown', label: '↓', ariaLabel: 'Down arrow' },
  { key: 'ArrowRight', label: '→', ariaLabel: 'Right arrow' },
  { key: 'PageDown', label: 'PgDn' },
  { key: 'Interrupt', label: 'Ctrl+C', wide: true },
];

export const FUNCTION_KEYS = [
  ...Array.from({ length: 12 }, (_, index) => ({
    key: `F${index + 1}`,
    label: `F${index + 1}`,
  })),
  { action: 'layout', key: 'main', label: 'ABC', wide: true },
];

const BASE_SEQUENCES = {
  Escape: '\x1b',
  Tab: '\t',
  '/': '/',
  Interrupt: '\x03',
  Home: '\x1b[H',
  End: '\x1b[F',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
  F1: '\x1bOP',
  F2: '\x1bOQ',
  F3: '\x1bOR',
  F4: '\x1bOS',
  F5: '\x1b[15~',
  F6: '\x1b[17~',
  F7: '\x1b[18~',
  F8: '\x1b[19~',
  F9: '\x1b[20~',
  F10: '\x1b[21~',
  F11: '\x1b[23~',
  F12: '\x1b[24~',
};

const CURSOR_FINAL = {
  ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D', Home: 'H', End: 'F',
};
const TILDE_CODE = {
  PageUp: 5, PageDown: 6, F5: 15, F6: 17, F7: 18, F8: 19,
  F9: 20, F10: 21, F11: 23, F12: 24,
};
const SS3_FINAL = { F1: 'P', F2: 'Q', F3: 'R', F4: 'S' };

export function controlCharacter(value) {
  if (typeof value !== 'string' || value.length !== 1) return null;
  const char = value.toUpperCase();
  const code = char.charCodeAt(0);
  if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
  if (char === ' ' || char === '2') return '\x00';
  if (char === '3') return '\x1b';
  if (char === '4') return '\x1c';
  if (char === '5') return '\x1d';
  if (char === '6') return '\x1e';
  if (char === '7' || char === '?') return '\x7f';
  if (char === '/') return '\x1f';
  return null;
}

function modifierParameter({ ctrl = false, alt = false } = {}) {
  return 1 + (alt ? 2 : 0) + (ctrl ? 4 : 0);
}

export function keySequence(key, modes = {}, modifiers = {}) {
  const ctrl = Boolean(modifiers.ctrl);
  const alt = Boolean(modifiers.alt);

  if (key === 'Interrupt') return BASE_SEQUENCES.Interrupt;

  if (key.length === 1) {
    let value = ctrl ? controlCharacter(key) : key;
    if (value === null) return null;
    if (alt) value = `\x1b${value}`;
    return value;
  }

  if (!ctrl && !alt) {
    if (modes.applicationCursorKeysMode && CURSOR_FINAL[key]) {
      return `\x1bO${CURSOR_FINAL[key]}`;
    }
    return BASE_SEQUENCES[key] ?? null;
  }

  const parameter = modifierParameter({ ctrl, alt });
  if (CURSOR_FINAL[key]) return `\x1b[1;${parameter}${CURSOR_FINAL[key]}`;
  if (TILDE_CODE[key]) return `\x1b[${TILDE_CODE[key]};${parameter}~`;
  if (SS3_FINAL[key]) return `\x1b[1;${parameter}${SS3_FINAL[key]}`;

  const base = BASE_SEQUENCES[key];
  return base && alt ? `\x1b${base}` : base ?? null;
}
