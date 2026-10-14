'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/** The `[program:ralph]` section of the workspace's supervisord config. */
function ralphProgram() {
    const source = fs.readFileSync(
        path.join(__dirname, '..', '..', 'workspace', 'supervisord.conf'),
        'utf8',
    );
    const match = source.match(/^\[program:ralph\]\n([\s\S]*?)(?=^\[|(?![\s\S]))/m);
    assert.ok(match, '[program:ralph] is missing');
    return Object.fromEntries(match[1].split('\n')
        .filter((line) => /^\w+=/.test(line))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
}

test('supervisord runs ralph daemon headless in the checkout, started only on demand', () => {
    const p = ralphProgram();
    assert.equal(p.command, 'ralph daemon');
    assert.equal(p.directory, '%(ENV_WORKSPACE_DIR)s');
    assert.equal(p.user, 'ubuntu');
    // The agent decides: a config in the checkout, or the dashboard's button.
    assert.equal(p.autostart, 'false');
});

test('a deliberate ralph shutdown stays down; a crash restarts, a dud start gives up', () => {
    const p = ralphProgram();
    assert.equal(p.autorestart, 'unexpected');
    assert.equal(p.exitcodes, '0');
    assert.ok(Number(p.startsecs) > 0, 'startsecs 0 would let a failing daemon loop forever');
    assert.ok(Number(p.startretries) > 0);
    assert.equal(p.stopsignal, 'TERM');
    // The agent's log tab tails exactly this file.
    assert.equal(p.stdout_logfile, '/var/log/supervisor/ralph.log');
});
