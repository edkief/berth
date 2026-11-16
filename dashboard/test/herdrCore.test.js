'use strict';

// herdr-core (`hc`) in the standalone editor: the terminal runtime the herdr
// app attaches to over SSH, supervised behind HERDR_CORE_ENABLE, in
// WORKSPACE_MODE=editor only.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const WORKSPACE = path.join(ROOT, 'workspace');
const ENTRYPOINT = fs.readFileSync(path.join(WORKSPACE, 'entrypoint.sh'), 'utf8');

/** A `[program:<name>]` section of the workspace's supervisord config, as key=value pairs. */
function program(name) {
    const source = fs.readFileSync(path.join(WORKSPACE, 'supervisord.conf'), 'utf8');
    const match = source.match(new RegExp(`^\\[program:${name}\\]\\n([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, 'm'));
    assert.ok(match, `[program:${name}] is missing`);
    return Object.fromEntries(match[1].split('\n')
        .filter((line) => /^\w+=/.test(line))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
}

/**
 * Run the entrypoint's mode block (from `export WORKSPACE_MODE=` to the end
 * of the HERDR_CORE_SERVER gate) and report what it exported.
 */
function modeBlock(env) {
    const start = ENTRYPOINT.indexOf('export WORKSPACE_MODE=');
    const gate = ENTRYPOINT.indexOf('export HERDR_CORE_SERVER=false');
    assert.ok(start > 0 && gate > start, 'mode block not found');
    const end = ENTRYPOINT.indexOf('\nfi\n', gate) + 4;
    const script = `${ENTRYPOINT.slice(start, end)}\necho "$HERDR_CORE_SERVER"`;
    return execFileSync('/bin/bash', ['-c', script], { env, encoding: 'utf8' }).trim();
}

test('supervisord runs herdr-core serve, autostarted by HERDR_CORE_SERVER', () => {
    const p = program('herdr-core');
    assert.equal(p.command, 'herdr-core serve');
    assert.equal(p.user, 'ubuntu');
    assert.equal(p.autostart, '%(ENV_HERDR_CORE_SERVER)s');
    // A deliberate `hc server stop` exits 0 and stays down; a crash restarts;
    // a start that keeps failing ends FATAL instead of looping.
    assert.equal(p.autorestart, 'unexpected');
    assert.equal(p.exitcodes, '0');
    assert.equal(p.startretries, '3');
    assert.equal(p.stopsignal, 'TERM');
    // Its terminals start a login shell; HOME is where its socket resolves.
    assert.match(p.environment, /HOME="\/home\/ubuntu"/);
    assert.match(p.environment, /SHELL="\/bin\/bash"/);
});

test('the core runs only in editor mode with HERDR_CORE_ENABLE, independent of herdr', () => {
    const cases = [
        [{}, 'false'],
        [{ HERDR_CORE_ENABLE: '1' }, 'false'],
        [{ WORKSPACE_MODE: 'workspace', HERDR_CORE_ENABLE: '1' }, 'false'],
        [{ WORKSPACE_MODE: 'editor' }, 'false'],
        [{ WORKSPACE_MODE: 'editor', HERDR_ENABLE: '1' }, 'false'],
        [{ WORKSPACE_MODE: 'editor', HERDR_CORE_ENABLE: '0' }, 'false'],
        [{ WORKSPACE_MODE: 'editor', HERDR_CORE_ENABLE: 'false' }, 'false'],
        [{ WORKSPACE_MODE: 'editor', HERDR_CORE_ENABLE: '1' }, 'true'],
        [{ WORKSPACE_MODE: 'editor', HERDR_CORE_ENABLE: 'true' }, 'true'],
    ];
    for (const [env, expected] of cases) {
        assert.equal(modeBlock({ PATH: process.env.PATH, ...env }), expected, JSON.stringify(env));
    }
});

test('herdr-core state and config are on the PVC, behind the gate', () => {
    const gate = ENTRYPOINT.indexOf('if [ "$HERDR_CORE_SERVER" = "true" ]');
    assert.ok(gate > 0, 'persistence is not gated on HERDR_CORE_SERVER');
    const block = ENTRYPOINT.slice(gate, ENTRYPOINT.indexOf('\nfi\n', gate));
    assert.match(block, /persist_home \.local\/state\/herdr-core\s+\/workspace\/_home\/herdr-core\/state/);
    assert.match(block, /persist_home \.config\/herdr-core\s+\/workspace\/_home\/herdr-core\/config/);
    // persist_home must exist by then, or the links are never made.
    assert.ok(ENTRYPOINT.indexOf('persist_home() {') < gate);
});

test('the image pins herdr-core by version and checksum, with hc beside it', () => {
    const dockerfile = fs.readFileSync(path.join(WORKSPACE, 'Dockerfile'), 'utf8');
    assert.match(dockerfile, /^ARG HERDR_CORE_VERSION=\d+\.\d+\.\d+$/m);
    assert.match(dockerfile, /^ARG HERDR_CORE_SHA256=[0-9a-f]{64}$/m);
    assert.match(dockerfile,
        /releases\.herdr\.dev\/core\/\$\{HERDR_CORE_VERSION\}\/herdr-core-linux-x86_64\.tar\.gz/);
    assert.match(dockerfile, /echo "\$\{HERDR_CORE_SHA256\}  \/tmp\/herdr-core\.tar\.gz" \| sha256sum -c -/);
    // Where the app looks first: `command -v herdr-core`.
    assert.match(dockerfile, /-C \/usr\/local\/bin herdr-core/);
    assert.match(dockerfile, /ln -sf herdr-core \/usr\/local\/bin\/hc/);
});
