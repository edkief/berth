'use strict';

const test = require('node:test');
const assert = require('node:assert');

process.env.NAMESPACE = 'dev';
process.env.KUBERNETES_SERVICE_HOST = '';
delete process.env.CODE_ENABLE;

const cfg = require('../lib/config');
const { describePod } = require('../lib/sessions');
const { buildWorkspacePodManifest, CODE_PORT, workspaceContainer } = require('../lib/podTemplate');

const ID = 'berth-ws-x-0badf00d';

function manifest(code) {
    return buildWorkspacePodManifest({
        id: ID, key: 'github.com/e/r', repoUrl: 'git@github.com:e/r.git',
        repoFullName: 'e/r', branch: 'main', baseBranch: 'main',
        sessionName: 'r-main', pvcName: ID, code,
    });
}

const codePort = (m) => workspaceContainer(m).ports.find((p) => p.name === 'code-ui');
const codeEnv = (m) => workspaceContainer(m).env.find((e) => e.name === 'CODE_ENABLE');

test('the editor is off by default, on a port clear of Codex, files and Ralph', () => {
    assert.equal(cfg.code.enabled, false);
    assert.equal(CODE_PORT, 7686);
    assert.ok(![7681, 7682, 7684, 7685, cfg.ralph.uiPort].includes(CODE_PORT));
});

test('disabled declares no port and sets no CODE_ENABLE', () => {
    const m = manifest({ enabled: false });
    assert.equal(codePort(m), undefined);
    assert.equal(codeEnv(m), undefined);
});

test('enabled declares the code-ui port and turns the in-pod editor on', () => {
    const m = manifest({ enabled: true });
    assert.deepEqual(codePort(m), { containerPort: CODE_PORT, name: 'code-ui' });
    assert.deepEqual(codeEnv(m), { name: 'CODE_ENABLE', value: '1' });
    // In the workspace container, not a sidecar: it needs the toolchain.
    assert.equal(m.spec.containers.filter((c) => c.ports?.some((p) => p.name === 'code-ui')).length, 1);
});

test('codeUrl follows the pod, not the current setting', () => {
    const withCode = manifest({ enabled: true });
    withCode.status = { phase: 'Running' };
    assert.equal(describePod(withCode).codeUrl, `/code/${ID}/`);

    const without = manifest({ enabled: false });
    without.status = { phase: 'Running' };
    assert.equal(describePod(without).codeUrl, null);
});

test('editor upgrades select code-server and reach it without the prefix', () => {
    const { matchWorkspaceUpgrade, codeUpstreamPath } = require('../lib/ttyProxy');
    assert.deepEqual(matchWorkspaceUpgrade(`/code/${ID}/stable-abc?reconnectionToken=t&skipWebSocketFrames=false`), {
        service: 'code', id: ID, port: CODE_PORT, healthPath: '/healthz',
        path: '/stable-abc?reconnectionToken=t&skipWebSocketFrames=false',
    });
    assert.equal(matchWorkspaceUpgrade(`/code/${ID}`).path, '/');
    assert.equal(matchWorkspaceUpgrade(`/codex/${ID}/`), null);
    assert.equal(matchWorkspaceUpgrade(`/code/${ID}x/`).id, `${ID}x`);
    assert.equal(codeUpstreamPath(`/code/${ID}/?folder=/workspace/main`, ID), '/?folder=/workspace/main');
    assert.equal(codeUpstreamPath(`/code/${ID}?a=1`, ID), '/?a=1');
});

test('proxyRequest forwards to the overridden path, and to req.url by default', async () => {
    const http = require('node:http');
    const { proxyRequest } = require('../lib/ttyProxy');
    const seen = [];
    const upstream = http.createServer((req, res) => { seen.push(req.url); res.end('ok'); });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const target = { id: ID, ip: '127.0.0.1', port: upstream.address().port };
    const front = http.createServer((req, res) => {
        if (req.url.startsWith('/code/')) proxyRequest(req, res, target, { path: '/stripped' });
        else proxyRequest(req, res, target);
    });
    await new Promise((r) => front.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${front.address().port}`;
    try {
        assert.equal(await (await fetch(`${base}/code/${ID}/x`)).text(), 'ok');
        assert.equal(await (await fetch(`${base}/tty/${ID}/y`)).text(), 'ok');
        assert.deepEqual(seen, ['/stripped', `/tty/${ID}/y`]);
    } finally {
        front.close();
        upstream.close();
    }
});
