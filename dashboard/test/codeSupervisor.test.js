'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const WORKSPACE = path.join(__dirname, '..', '..', 'workspace');
const SCRIPT = path.join(WORKSPACE, 'bootstrap', 'code-server.sh');

/** The `[program:code-server]` section of the workspace's supervisord config. */
function codeProgram() {
    const source = fs.readFileSync(path.join(WORKSPACE, 'supervisord.conf'), 'utf8');
    const match = source.match(/^\[program:code-server\]\n([\s\S]*?)(?=^\[|(?![\s\S]))/m);
    assert.ok(match, '[program:code-server] is missing');
    return Object.fromEntries(match[1].split('\n')
        .filter((line) => /^\w+=/.test(line))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
}

test('supervisord runs the code-server script, and a clean exit stays down', () => {
    const p = codeProgram();
    assert.equal(p.command, '/home/ubuntu/bootstrap/code-server.sh');
    assert.equal(p.user, 'ubuntu');
    assert.equal(p.autostart, 'true');
    // Disabled exits 0 at once: with startsecs=0 that is EXITED, not FATAL.
    assert.equal(p.startsecs, '0');
    assert.equal(p.exitcodes, '0');
    assert.equal(p.autorestart, 'unexpected');
});

test('code-server serves the checkout unauthenticated on 7686, state on the PVC', () => {
    const source = fs.readFileSync(SCRIPT, 'utf8');
    assert.match(source, /--auth none/);
    assert.match(source, /--bind-addr "0\.0\.0\.0:\$\{CODE_PORT:-7686\}"/);
    assert.match(source, /CODE_HOME="\$\{CODE_HOME:-\/workspace\/_home\/code-server\}"/);
    assert.match(source, /--user-data-dir "\$CODE_HOME\/data"/);
    assert.match(source, /--extensions-dir "\$CODE_HOME\/extensions"/);
    assert.match(source, /--reconnection-grace-time \d+/);
    assert.match(source, /"\$\{WORKSPACE_DIR:-\/workspace\}"$/m);
});

test('without CODE_ENABLE the script exits 0 before starting anything', () => {
    for (const value of [undefined, '', '0', 'false']) {
        const env = { PATH: '/nonexistent' };
        if (value !== undefined) env.CODE_ENABLE = value;
        // PATH holds no code-server: reaching exec would fail, not exit 0.
        execFileSync('/bin/bash', [SCRIPT], { env, stdio: 'pipe' });
    }
});

test('with CODE_ENABLE the script reaches code-server', () => {
    assert.throws(() => execFileSync('/bin/bash', [SCRIPT], {
        // mkdir is found, code-server is not: the error names it.
        env: { PATH: '/usr/bin:/bin', CODE_ENABLE: '1', CODE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'code-home-')) },
        stdio: 'pipe',
    }), /code-server/);
});

test('workspace trust and built-in AI chat are seeded off once, never over settings the user has made', () => {
    const run = (home) => assert.throws(() => execFileSync('/bin/bash', [SCRIPT], {
        env: { PATH: '/usr/bin:/bin', CODE_ENABLE: '1', CODE_HOME: home }, stdio: 'pipe',
    }));
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'code-home-'));
    run(fresh);
    const seeded = JSON.parse(fs.readFileSync(path.join(fresh, 'data', 'User', 'settings.json'), 'utf8'));
    assert.deepEqual(seeded, {
        'security.workspace.trust.enabled': false,
        'chat.disableAIFeatures': true,
    });

    const used = fs.mkdtempSync(path.join(os.tmpdir(), 'code-home-'));
    fs.mkdirSync(path.join(used, 'data', 'User'), { recursive: true });
    fs.writeFileSync(path.join(used, 'data', 'User', 'settings.json'), '{"editor.fontSize": 17}');
    run(used);
    assert.equal(fs.readFileSync(path.join(used, 'data', 'User', 'settings.json'), 'utf8'), '{"editor.fontSize": 17}');
});
