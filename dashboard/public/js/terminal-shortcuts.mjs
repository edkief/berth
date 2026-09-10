import { FUNCTION_KEYS, MAIN_KEYS, keySequence } from './terminal-keys.mjs';

const match = /^\/terminal\/(berth-ws-[a-z0-9-]+-[0-9a-f]{8})\/?$/.exec(window.location.pathname);
const frame = document.getElementById('terminal-frame');
const drawer = document.getElementById('keyboard-drawer');
const toggle = document.getElementById('keyboard-toggle');
const close = document.getElementById('keyboard-close');
const status = document.getElementById('keyboard-status');
const mainLayout = document.getElementById('key-layout-main');
const functionLayout = document.getElementById('key-layout-function');
const modifiers = { ctrl: false, alt: false };
let term = null;
let textarea = null;

// Focusing xterm's hidden textarea summons the Android soft keyboard, which
// would cover the drawer we just opened. Only ever restore focus that the
// terminal already had — when the iframe is focused, activeElement is <iframe>.
function refocusTerminal() {
  if (document.activeElement === frame) term?.focus();
}

function setDrawer(open) {
  drawer.hidden = !open;
  drawer.setAttribute('aria-hidden', String(!open));
  drawer.inert = !open;
  toggle.hidden = open;
  toggle.setAttribute('aria-expanded', String(open));
  // Reopening always lands on the main layout; FN is a momentary detour.
  if (!open) { setLayout('main'); toggle.focus(); }
}

function setLayout(name) {
  const showFunctions = name === 'function';
  mainLayout.hidden = showFunctions;
  functionLayout.hidden = !showFunctions;
}

function clearModifiers() {
  modifiers.ctrl = false;
  modifiers.alt = false;
  document.querySelectorAll('[data-modifier]').forEach(button => {
    button.classList.remove('is-active');
    button.setAttribute('aria-pressed', 'false');
  });
}

function send(key) {
  if (!term) return;
  const sequence = keySequence(key, term.modes, modifiers);
  if (sequence !== null) term.input(sequence, true);
  clearModifiers();
  refocusTerminal();
}

function toggleModifier(button) {
  const name = button.dataset.modifier;
  modifiers[name] = !modifiers[name];
  button.classList.toggle('is-active', modifiers[name]);
  button.setAttribute('aria-pressed', String(modifiers[name]));
  refocusTerminal();
}

function makeButton(definition) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `terminal-key${definition.wide ? ' terminal-key--wide' : ''}`;
  button.textContent = definition.label;
  button.disabled = definition.action !== 'layout';
  if (definition.area) button.style.gridArea = definition.area;
  if (definition.ariaLabel) button.setAttribute('aria-label', definition.ariaLabel);

  if (definition.action === 'modifier') {
    button.dataset.modifier = definition.key === 'Control' ? 'ctrl' : 'alt';
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => toggleModifier(button));
  } else if (definition.action === 'layout') {
    button.classList.add('terminal-key--layout');
    button.addEventListener('click', () => setLayout(definition.key));
  } else {
    button.addEventListener('click', () => send(definition.key));
  }

  // Do not let a pointer press steal focus from xterm's hidden textarea.
  button.addEventListener('pointerdown', event => event.preventDefault());
  return button;
}

function renderKeys(container, definitions) {
  definitions.forEach(definition => container.append(makeButton(definition)));
}

function consumeModifiedInput(value) {
  if (!term || (!modifiers.ctrl && !modifiers.alt)) return false;
  const sequence = keySequence(value, term.modes, modifiers);
  if (sequence === null) return false;
  term.input(sequence, true);
  clearModifiers();
  return true;
}

function attachInputHandlers(nextTextarea) {
  if (textarea === nextTextarea) return;
  textarea = nextTextarea;
  textarea.addEventListener('keydown', event => {
    if (!modifiers.ctrl && !modifiers.alt) return;
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return;
    if (!consumeModifiedInput(event.key)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  // Some mobile keyboards skip keydown for printable text. beforeinput is the
  // fallback; if keydown already consumed it, the one-shot modifier is clear.
  textarea.addEventListener('beforeinput', event => {
    if (!event.data || !consumeModifiedInput(event.data)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}

function connectToTerminal(attempt = 0) {
  try {
    const candidate = frame.contentWindow?.term;
    if (candidate && typeof candidate.input === 'function' && candidate.textarea) {
      term = candidate;
      attachInputHandlers(candidate.textarea);
      document.querySelectorAll('.terminal-key').forEach(button => { button.disabled = false; });
      status.textContent = 'Ready';
      return;
    }
  } catch { /* The raw terminal remains usable if its API cannot be reached. */ }
  if (attempt < 100) setTimeout(() => connectToTerminal(attempt + 1), 100);
  else status.textContent = 'Shortcuts unavailable';
}

// The layout viewport does not shrink when a mobile keyboard opens, so a page
// sized to it puts the drawer (and the terminal's last lines) behind the keys.
// Only the keyboard is measured: browser chrome is already inside 100dvh, and
// subtracting that too would push the drawer off the bottom of the screen.
const KEYBOARD_MIN_HEIGHT = 150;

function trackKeyboardInset() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const sync = () => {
    const inset = window.innerHeight - viewport.height - viewport.offsetTop;
    document.documentElement.style.setProperty(
      '--keyboard-inset', inset > KEYBOARD_MIN_HEIGHT ? `${Math.round(inset)}px` : '0px');
  };
  viewport.addEventListener('resize', sync);
  viewport.addEventListener('scroll', sync);
  sync();
}

renderKeys(mainLayout, MAIN_KEYS);
renderKeys(functionLayout, FUNCTION_KEYS);
trackKeyboardInset();
toggle.addEventListener('click', () => setDrawer(true));
close.addEventListener('click', () => setDrawer(false));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !drawer.hidden) setDrawer(false);
});
frame.addEventListener('load', () => {
  term = null;
  textarea = null;
  clearModifiers();
  status.textContent = 'Connecting…';
  document.querySelectorAll('.terminal-key').forEach(button => {
    button.disabled = !button.classList.contains('terminal-key--layout');
  });
  connectToTerminal();
});

if (match) {
  frame.src = `/tty/${encodeURIComponent(match[1])}/`;
} else {
  frame.replaceWith(Object.assign(document.createElement('p'), { textContent: 'Invalid terminal URL.' }));
}
