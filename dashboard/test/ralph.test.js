'use strict';

const test = require('node:test');
const assert = require('node:assert');

process.env.NAMESPACE = 'dev';
process.env.KUBERNETES_SERVICE_HOST = '';

const cfg = require('../lib/config');
const { describePod } = require('../lib/sessions');
const { buildWorkspacePodManifest } = require('../lib/podTemplate');
const { ralphFromStatus } = require('../../workspace/agent');

const ID = 'berth-ws-x-0badf00d';

function manifest(ralph) {
    return buildWorkspacePodManifest({
        id: ID, key: 'github.com/e/r', repoUrl: 'git@github.com:e/r.git',
        repoFullName: 'e/r', branch: 'main', baseBranch: 'main',
        sessionName: 'r-main', pvcName: ID, ralph,
    });
}

function envOf(m) {
    return Object.fromEntries(m.spec.containers[0].env
        .filter((e) => e.value !== undefined).map((e) => [e.name, e.value]));
}

/** Run `fn` with Ralph switched on for the dashboard, then restore it. */
function withRalphEnabled(fn) {
    const saved = cfg.ralph.enabled;
    cfg.ralph.enabled = true;
    try { return fn(); } finally { cfg.ralph.enabled = saved; }
}

test('Ralph is off unless RALPH_ENABLE turns it on', () => {
    assert.equal(cfg.ralph.enabled, false);
    // Ralph's own default, so an unset RALPH_UI_PORT needs no ralph config.
    assert.equal(cfg.ralph.uiPort, 4280);

    const m = manifest({ enabled: false, uiPort: 4280 });
    assert.ok(!Object.keys(envOf(m)).some((k) => k.startsWith('RALPH_')));
    assert.ok(!m.spec.containers[0].ports.some((p) => p.name === 'ralph-ui'));
});

test('pod manifest: an enabled Ralph serves its UI where the dashboard proxies it', () => {
    const m = manifest({ enabled: true, uiPort: 4390 });
    const env = envOf(m);
    assert.equal(env.RALPH_ENABLE, '1');
    // Every `ralph` typed in the terminal serves the UI beside the loop...
    assert.equal(env.RALPH_UI, '1');
    // ...reachable from the dashboard at the pod IP, not only on loopback...
    assert.equal(env.RALPH_UI_HOST, '0.0.0.0');
    assert.equal(env.RALPH_UI_PORT, '4390');
    // ...under the exact prefix it is proxied at, so nothing is rewritten.
    assert.equal(env.RALPH_UI_BASE_PATH, `/ralph/${ID}`);
    assert.deepEqual(m.spec.containers[0].ports.find((p) => p.name === 'ralph-ui'),
        { containerPort: 4390, name: 'ralph-ui' });
});

test('describePod offers Ralph only when the dashboard and the pod both have it', () => {
    const withPort = { ...manifest({ enabled: true, uiPort: 4280 }), status: { phase: 'Running' } };
    const withoutPort = { ...manifest({ enabled: false, uiPort: 4280 }), status: { phase: 'Running' } };
    const agentHealth = { ralph: { ui: true, tasks: { passed: 1, total: 3 }, run: null } };

    assert.equal(describePod(withPort, { agentHealth }).ralphUrl, null, 'dashboard has it off');
    withRalphEnabled(() => {
        assert.equal(describePod(withoutPort, { agentHealth }).ralphUrl, null,
            'pod started before Ralph was enabled');
        const s = describePod(withPort, { agentHealth });
        assert.equal(s.ralphUrl, `/ralph/${ID}/`);
        assert.deepEqual(s.ralph, { ui: true, reason: null, tasks: { passed: 1, total: 3 }, run: null });
    });
});

test('describePod keeps the Ralph button off, with a reason, when nothing says it is up', () => {
    const p = { ...manifest({ enabled: true, uiPort: 4280 }), status: { phase: 'Running' } };
    withRalphEnabled(() => {
        assert.deepEqual(describePod(p, { agentHealth: { ralph: { ui: false, reason: 'not running' } } }).ralph,
            { ui: false, reason: 'not running', tasks: null, run: null });
        assert.equal(describePod(p, { agentHealth: {} }).ralph.ui, false, 'an agent that predates Ralph');
        assert.equal(describePod(p).ralph.ui, false, 'no agent answer at all');
    });
});

test('agent: a status answer from Ralph means its UI is up', () => {
    const r = ralphFromStatus(200, JSON.stringify({
        project: 'r',
        tasks: { total: 3, passed: 1, next: 'T-2', items: [] },
        run: { runId: '20260930-120000', status: 'running', live: true, iteration: 2, maxIterations: 20, taskId: 'T-2' },
    }));
    assert.equal(r.ui, true);
    assert.deepEqual(r.tasks, { passed: 1, total: 3 });
    assert.deepEqual(r.run, {
        runId: '20260930-120000', status: 'running', live: true,
        iteration: 2, maxIterations: 20, taskId: 'T-2',
    });
});

test('agent: a Ralph that serves its app instead of its API is not usable', () => {
    // A ralph without base-path support answers every unknown path with
    // index.html, whose API calls would then land on the dashboard.
    const r = ralphFromStatus(200, '<!doctype html><div id="root"></div>');
    assert.equal(r.ui, false);
    assert.match(r.reason, /RALPH_UI_BASE_PATH/);

    assert.equal(ralphFromStatus(404, '{"error":"Not found"}').ui, false);
});
