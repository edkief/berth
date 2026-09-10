'use strict';

const test = require('node:test');
const assert = require('node:assert');

let keys;
test.before(async () => { keys = await import('../public/js/terminal-keys.mjs'); });

test('terminal key maps cover navigation and every function key', () => {
    assert.equal(keys.keySequence('Escape'), '\x1b');
    assert.equal(keys.keySequence('Tab'), '\t');
    assert.equal(keys.keySequence('Home'), '\x1b[H');
    assert.equal(keys.keySequence('PageDown'), '\x1b[6~');
    assert.equal(keys.keySequence('F1'), '\x1bOP');
    assert.equal(keys.keySequence('F12'), '\x1b[24~');
    assert.deepEqual(
        keys.FUNCTION_KEYS.filter(item => /^F\d+$/.test(item.key)).map(item => item.key),
        Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
    );
});

test('cursor keys follow application cursor mode', () => {
    assert.equal(keys.keySequence('ArrowUp'), '\x1b[A');
    assert.equal(keys.keySequence('ArrowUp', { applicationCursorKeysMode: true }), '\x1bOA');
    assert.equal(keys.keySequence('End', { applicationCursorKeysMode: true }), '\x1bOF');
});

test('ctrl and alt transform printable input', () => {
    assert.equal(keys.controlCharacter('c'), '\x03');
    assert.equal(keys.keySequence('c', {}, { ctrl: true }), '\x03');
    assert.equal(keys.keySequence('x', {}, { alt: true }), '\x1bx');
    assert.equal(keys.keySequence('c', {}, { ctrl: true, alt: true }), '\x1b\x03');
    assert.equal(keys.keySequence('/', {}, { ctrl: true }), '\x1f');
});

test('modifiers produce xterm-compatible special-key parameters', () => {
    assert.equal(keys.keySequence('ArrowLeft', {}, { ctrl: true }), '\x1b[1;5D');
    assert.equal(keys.keySequence('PageUp', {}, { alt: true }), '\x1b[5;3~');
    assert.equal(keys.keySequence('F2', {}, { ctrl: true, alt: true }), '\x1b[1;7Q');
});

test('dedicated interrupt always emits ctrl-c', () => {
    assert.equal(keys.keySequence('Interrupt'), '\x03');
    assert.equal(keys.keySequence('Interrupt', {}, { alt: true }), '\x03');
});

test('every main key is placed in the stylesheet grid, arrows as an inverted T', () => {
    const areas = keys.MAIN_KEYS.map(item => item.area);
    assert.ok(areas.every(Boolean), 'each main key needs a grid area');
    assert.equal(new Set(areas).size, areas.length, 'grid areas must be unique');

    const css = require('node:fs').readFileSync(
        require('node:path').join(__dirname, '../public/styles/terminal.css'), 'utf8');
    const template = /\.key-layout--main\s*{[^}]*grid-template-areas:\s*([^;]+);/.exec(css);
    assert.ok(template, 'terminal.css must place the main layout');
    const rows = template[1].trim().split('"').filter(row => row.trim()).map(row => row.trim().split(/\s+/));
    for (const area of areas) assert.ok(rows.some(row => row.includes(area)), `${area} is unplaced`);

    const columnOf = name => {
        const row = rows.findIndex(cells => cells.includes(name));
        return { row, column: rows[row].indexOf(name) };
    };
    const up = columnOf('up');
    const down = columnOf('down');
    assert.equal(up.column, down.column);
    assert.equal(down.row, up.row + 1);
    assert.equal(columnOf('left').row, down.row);
    assert.equal(columnOf('right').row, down.row);
    assert.equal(columnOf('left').column, down.column - 1);
    assert.equal(columnOf('right').column, down.column + 1);
});
