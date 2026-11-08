'use strict';

// herdr (agent multiplexer) in the standalone editor: a supervised background
// server, behind HERDR_ENABLE, in WORKSPACE_MODE=editor only.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { loadAllYaml } = require('@kubernetes/client-node');

const ROOT = path.join(__dirname, '..', '..');
const WORKSPACE = path.join(ROOT, 'workspace');
const ENTRYPOINT = fs.readFileSync(path.join(WORKSPACE, 'entrypoint.sh'), 'utf8');

/** The `[program:herdr]` section of the workspace's supervisord config. */
function herdrProgram() {
    const source = fs.readFileSync(path.join(WORKSPACE, 'supervisord.conf'), 'utf8');
    const match = source.match(/^\[program:herdr\]\n([\s\S]*?)(?=^\[|(?![\s\S]))/m);
    assert.ok(match, '[program:herdr] is missing');
    return Object.fromEntries(match[1].split('\n')
        .filter((line) => /^\w+=/.test(line))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
}

/**
 * Run the entrypoint's mode block (from `export WORKSPACE_MODE=` to the end
 * of the HERDR_SERVER gate) and report what it exported.
 */
function modeBlock(env) {
    const start = ENTRYPOINT.indexOf('export WORKSPACE_MODE=');
    const gate = ENTRYPOINT.indexOf('export HERDR_SERVER=false');
    assert.ok(start > 0 && gate > start, 'mode block not found');
    const end = ENTRYPOINT.indexOf('\nfi\n', gate) + 4;
    const script = `${ENTRYPOINT.slice(start, end)}\necho "$HERDR_SERVER"`;
    return execFileSync('/bin/bash', ['-c', script], { env, encoding: 'utf8' }).trim();
}

test('supervisord runs herdr server, autostarted by HERDR_SERVER', () => {
    const p = herdrProgram();
    assert.equal(p.command, 'herdr server');
    assert.equal(p.user, 'ubuntu');
    assert.equal(p.directory, '%(ENV_WORKSPACE_DIR)s');
    assert.equal(p.autostart, '%(ENV_HERDR_SERVER)s');
    // A deliberate `herdr server stop` exits 0 and stays down; a crash restarts.
    assert.equal(p.autorestart, 'unexpected');
    assert.equal(p.exitcodes, '0');
    assert.equal(p.stopsignal, 'TERM');
    // Panes fall back to /bin/sh without SHELL.
    assert.match(p.environment, /SHELL="\/bin\/bash"/);
});

test('the herdr server runs only in editor mode with HERDR_ENABLE', () => {
    const cases = [
        [{}, 'false'],
        [{ HERDR_ENABLE: '1' }, 'false'],
        [{ WORKSPACE_MODE: 'workspace', HERDR_ENABLE: '1' }, 'false'],
        [{ WORKSPACE_MODE: 'editor' }, 'false'],
        [{ WORKSPACE_MODE: 'editor', HERDR_ENABLE: '0' }, 'false'],
        [{ WORKSPACE_MODE: 'editor', HERDR_ENABLE: 'false' }, 'false'],
        [{ WORKSPACE_MODE: 'editor', HERDR_ENABLE: '1' }, 'true'],
        [{ WORKSPACE_MODE: 'editor', HERDR_ENABLE: 'true' }, 'true'],
    ];
    for (const [env, expected] of cases) {
        assert.equal(modeBlock({ PATH: process.env.PATH, ...env }), expected, JSON.stringify(env));
    }
});

test('herdr state is on the PVC, and its integrations follow the config pull', () => {
    for (const [link, target] of [
        ['.config/herdr', '/workspace/_home/herdr/config'],
        ['.local/state/herdr', '/workspace/_home/herdr/state'],
        ['.herdr', '/workspace/_home/herdr/home'],
    ]) {
        assert.match(ENTRYPOINT, new RegExp(`persist_home ${link.replace(/\./g, '\\.')}\\s+${target}`));
    }
    const pull = ENTRYPOINT.indexOf('claude-config-sync pull');
    const install = ENTRYPOINT.indexOf('herdr integration install');
    assert.ok(pull > 0 && install > pull, 'integrations must be installed after the pull rewrites settings.json');
    // Each sits behind the gate, and a failure only warns.
    assert.match(ENTRYPOINT.slice(ENTRYPOINT.lastIndexOf('if [ "$HERDR_SERVER" = "true" ]', install), install),
        /for agent in claude codex/);
    assert.match(ENTRYPOINT.slice(install, install + 200), /\|\| echo "\[entrypoint\] WARN/);
});

test('the image pins herdr, and k8s/editor.yaml turns it on', () => {
    const dockerfile = fs.readFileSync(path.join(WORKSPACE, 'Dockerfile'), 'utf8');
    assert.match(dockerfile, /^ARG HERDR_VERSION=\d+\.\d+\.\d+$/m);
    assert.match(dockerfile, /herdrdev\/herdr\/releases\/download\/v\$\{HERDR_VERSION\}\/herdr-linux-x86_64/);

    const docs = loadAllYaml(fs.readFileSync(path.join(ROOT, 'k8s', 'editor.yaml'), 'utf8'));
    const d = docs.find((doc) => doc.kind === 'Deployment');
    const c = d.spec.template.spec.containers.find((x) => x.name === 'workspace');
    assert.equal(c.env.find((e) => e.name === 'HERDR_ENABLE')?.value, '1');
});
