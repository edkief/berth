'use strict';

// WORKSPACE_MODE=agent: a pod another system creates to host headless Claude
// sessions. The clone and config pull as in a workspace, a supervised
// caller-supplied runner in place of `claude remote`, and readiness/liveness
// from that runner's health URL.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
    runnerHealth, runnerLive, probeHttp, envAuthenticated,
} = require('../../workspace/agent');

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

/** The entrypoint from `from` to the first `\nfi\n` after `to`, inclusive. */
function slice(from, to = from) {
    const start = ENTRYPOINT.indexOf(from);
    const anchor = ENTRYPOINT.indexOf(to, start);
    assert.ok(start > 0 && anchor >= start, `${from} not found`);
    return ENTRYPOINT.slice(start, ENTRYPOINT.indexOf('\nfi\n', anchor) + 4);
}

function bash(script, env) {
    return execFileSync('/bin/bash', ['-c', script], {
        env: { PATH: process.env.PATH, ...env }, encoding: 'utf8',
    }).trim();
}

/** The mode block, reporting what it exported. */
function modeBlock(env) {
    const script = `${slice('export WORKSPACE_MODE=', 'export WORKSPACE_TERMINALS=true')}
echo "$AGENT_RUNNER $WORKSPACE_TERMINALS \${WORKSPACE_TOKEN_SYNC:-unset}"`;
    return bash(script, env);
}

test('agent mode autostarts the runner, stops the terminals, and defaults token sync off', () => {
    const cases = [
        [{}, 'false true unset'],
        [{ WORKSPACE_MODE: 'workspace' }, 'false true unset'],
        [{ WORKSPACE_MODE: 'editor' }, 'false false unset'],
        [{ WORKSPACE_MODE: 'agent' }, 'true false 0'],
        // An explicit value wins.
        [{ WORKSPACE_MODE: 'agent', WORKSPACE_TOKEN_SYNC: '1' }, 'true false 1'],
        // Only agent mode changes the token-sync default.
        [{ WORKSPACE_MODE: 'workspace', WORKSPACE_TOKEN_SYNC: '0' }, 'false true 0'],
    ];
    for (const [env, expected] of cases) {
        assert.equal(modeBlock(env), expected, JSON.stringify(env));
    }
});

test('agent mode fails the bootstrap without a command or a health URL', () => {
    const block = slice('if [ "$WORKSPACE_MODE" = "agent" ]; then\n    [ -n "${AGENT_RUNNER_CMD');
    const script = `fail() { echo "FAIL: $1"; exit 0; }\n${block}\necho ok`;
    assert.equal(bash(script, { WORKSPACE_MODE: 'agent' }),
        'FAIL: WORKSPACE_MODE=agent needs AGENT_RUNNER_CMD');
    assert.equal(bash(script, { WORKSPACE_MODE: 'agent', AGENT_RUNNER_CMD: 'node r.js' }),
        'FAIL: WORKSPACE_MODE=agent needs AGENT_RUNNER_HEALTH_URL');
    assert.equal(bash(script, {
        WORKSPACE_MODE: 'agent', AGENT_RUNNER_CMD: 'node r.js',
        AGENT_RUNNER_HEALTH_URL: 'http://127.0.0.1:8080/health',
    }), 'ok');
    // Other modes need neither.
    assert.equal(bash(script, { WORKSPACE_MODE: 'workspace' }), 'ok');
    // fail() must exist by then.
    assert.ok(ENTRYPOINT.indexOf('fail() {') < ENTRYPOINT.indexOf(block));
});

test('without token sync, an agent pod does not pull the shared login', () => {
    const block = slice('PULL_ARGS=()');
    const script = `${block}\necho "\${PULL_ARGS[*]:-none}"`;
    assert.equal(bash(script, { WORKSPACE_MODE: 'agent', WORKSPACE_TOKEN_SYNC: '0' }), '--no-token');
    assert.equal(bash(script, { WORKSPACE_MODE: 'agent', WORKSPACE_TOKEN_SYNC: '1' }), 'none');
    assert.equal(bash(script, { WORKSPACE_MODE: 'workspace', WORKSPACE_TOKEN_SYNC: '0' }), 'none');
    assert.match(ENTRYPOINT, /claude-config-sync pull "\$\{PULL_ARGS\[@\]\}"/);
});

test('agent mode clones, and does not launch claude remote', () => {
    const launch = ENTRYPOINT.indexOf('claude remote --name');
    const guard = ENTRYPOINT.lastIndexOf('if [ "$WORKSPACE_MODE"', launch);
    assert.match(ENTRYPOINT.slice(guard, launch), /^if \[ "\$WORKSPACE_MODE" = "workspace" \]; then/);
    // The clone is the editor's exception only.
    const clone = ENTRYPOINT.indexOf('bootstrap/clone.sh');
    const cloneGuard = ENTRYPOINT.lastIndexOf('if [ "$WORKSPACE_MODE"', clone);
    assert.match(ENTRYPOINT.slice(cloneGuard, clone), /^if \[ "\$WORKSPACE_MODE" = "editor" \]; then[\s\S]*else/);
});

test('supervisord runs the runner from the checkout, autostarted by AGENT_RUNNER', () => {
    const p = program('agent-runner');
    assert.equal(p.command, '/home/ubuntu/bootstrap/agent-runner.sh');
    assert.equal(p.directory, '%(ENV_WORKSPACE_DIR)s');
    assert.equal(p.user, 'ubuntu');
    assert.equal(p.autostart, '%(ENV_AGENT_RUNNER)s');
    // Any exit restarts it; one that cannot start ends FATAL instead of looping.
    assert.equal(p.autorestart, 'true');
    assert.equal(p.startretries, '3');
    assert.equal(p.stopasgroup, 'true');
    assert.equal(p.killasgroup, 'true');
    // supervisord refuses to start on an unset %(ENV_*)s: exported in every mode.
    assert.match(ENTRYPOINT, /^export AGENT_RUNNER=false$/m);
});

test('the launcher loads nvm and runs AGENT_RUNNER_CMD in the checkout', () => {
    const launcher = path.join(WORKSPACE, 'bootstrap', 'agent-runner.sh');
    const source = fs.readFileSync(launcher, 'utf8');
    assert.match(source, /\. "\$NVM_DIR\/nvm\.sh"/);

    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'agent-runner-'));
    try {
        const out = execFileSync('/bin/bash', [launcher], {
            env: {
                PATH: process.env.PATH, NVM_DIR: path.join(dir, 'no-nvm'),
                WORKSPACE_DIR: dir, AGENT_RUNNER_CMD: 'echo "$PWD" \'quoted arg\'',
            },
            encoding: 'utf8',
        }).trim();
        assert.equal(out, `${fs.realpathSync(dir)} quoted arg`);
        assert.throws(() => execFileSync('/bin/bash', [launcher], {
            env: { PATH: process.env.PATH, NVM_DIR: path.join(dir, 'no-nvm'), WORKSPACE_DIR: dir },
            stdio: 'ignore',
        }), (err) => err.status === 2);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('runner readiness: bootstrap done and the health URL answering', () => {
    const up = { up: true, reason: null };
    const down = { up: false, reason: 'not running' };

    assert.deepEqual(runnerHealth('starting', up, null), { ready: true, stage: 'ready', detail: null });
    assert.deepEqual(runnerHealth('starting', down, null),
        { ready: false, stage: 'starting-runner', detail: 'agent runner: not running' });
    // Ready once, down now: its own stage, not "starting".
    assert.deepEqual(runnerHealth('starting', down, null, true),
        { ready: false, stage: 'runner-down', detail: 'agent runner: not running' });
    assert.deepEqual(runnerHealth('cloning', up, null), { ready: false, stage: 'cloning', detail: null });
    assert.deepEqual(runnerHealth('failed', up, 'WORKSPACE_MODE=agent needs AGENT_RUNNER_CMD\n'),
        { ready: false, stage: 'failed', detail: 'WORKSPACE_MODE=agent needs AGENT_RUNNER_CMD' });
});

test('runner liveness: only a runner that was ready and stays down restarts', () => {
    const base = { selfHeal: true, readyOnce: true, up: false, downSince: 1000, now: 1000, downMs: 120000 };
    assert.equal(runnerLive({ ...base, readyOnce: false, now: 10e6 }).ok, true, 'never before first ready');
    assert.equal(runnerLive({ ...base, selfHeal: false, now: 10e6 }).ok, true, 'self-heal off');
    assert.equal(runnerLive({ ...base, up: true, downSince: null }).ok, true);
    assert.equal(runnerLive({ ...base, now: 1000 + 119999 }).ok, true, 'inside the window');
    const dead = runnerLive({ ...base, now: 1000 + 120000 });
    assert.equal(dead.ok, false);
    assert.match(dead.reason, /restarting container/);
});

test('probeHttp: any 2xx is up, anything else says why', async () => {
    const server = http.createServer((req, res) => {
        res.statusCode = req.url === '/ok' ? 204 : 500;
        res.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const probe = (url) => new Promise((r) => probeHttp(url, r));
    try {
        assert.equal((await probe(`http://127.0.0.1:${port}/ok`)).up, true);
        const bad = await probe(`http://127.0.0.1:${port}/err`);
        assert.deepEqual([bad.up, bad.reason], [false, 'answered 500']);
    } finally {
        await new Promise((r) => server.close(r));
    }
    const refused = await probe(`http://127.0.0.1:${port}/ok`);
    assert.deepEqual([refused.up, refused.reason], [false, 'not running']);
    const invalid = await probe('');
    assert.equal(invalid.up, false);
    assert.match(invalid.reason, /invalid URL/);
});

test('a credential in the environment stands down the credentials-file verdicts', () => {
    assert.equal(envAuthenticated({}), false);
    assert.equal(envAuthenticated({ ANTHROPIC_API_KEY: 'sk-x' }), true);
    assert.equal(envAuthenticated({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x' }), true);
    assert.equal(envAuthenticated({ CLAUDE_CODE_OAUTH_TOKEN: '' }), false);
    // The entrypoint's no-credentials warning honours the same two.
    assert.match(ENTRYPOINT, /\$\{ANTHROPIC_API_KEY:-\}\$\{CLAUDE_CODE_OAUTH_TOKEN:-\}/);
});
