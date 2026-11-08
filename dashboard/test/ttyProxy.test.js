'use strict';

const test = require('node:test');
const assert = require('node:assert');

process.env.NAMESPACE = 'dev';
process.env.KUBERNETES_SERVICE_HOST = '';

const {
    TTY_PORT, CODEX_PORT, isSameOriginUpgrade, matchWorkspaceUpgrade, matchEditorUpgrade,
    resolveFixedTarget, invalidateTarget,
} = require('../lib/ttyProxy');

test('workspace WebSocket paths select the correct service and port', () => {
    assert.deepEqual(matchWorkspaceUpgrade('/tty/berth-ws-demo-0badf00d/ws'), {
        service: 'tty', id: 'berth-ws-demo-0badf00d', port: TTY_PORT,
    });
    assert.deepEqual(
        matchWorkspaceUpgrade('/codex/berth-ws-demo-0badf00d/codex-api/ws?token=x'),
        {
            service: 'codex', id: 'berth-ws-demo-0badf00d', port: CODEX_PORT,
            healthPath: '/codex/berth-ws-demo-0badf00d/',
        },
    );
});

test('Codex upgrades are accepted only at its prefixed RPC WebSocket path', () => {
    assert.equal(matchWorkspaceUpgrade('/codex/berth-ws-demo-0badf00d/'), null);
    assert.equal(matchWorkspaceUpgrade('/codex/berth-ws-demo-0badf00d/not-a-websocket'), null);
});

test('browser WebSocket upgrades must be same-origin', () => {
    assert.equal(isSameOriginUpgrade({
        headers: { host: 'work.example.test', origin: 'https://work.example.test' },
    }), true);
    assert.equal(isSameOriginUpgrade({
        headers: { host: 'work.example.test', origin: 'https://evil.example.test' },
    }), false);
    assert.equal(isSameOriginUpgrade({ headers: { host: 'work.example.test' } }), true);
    assert.equal(isSameOriginUpgrade({
        headers: { host: 'work.example.test', origin: 'not a URL' },
    }), false);
});

test("the editor's herdr terminal upgrades only under its own base path", () => {
    assert.ok(matchEditorUpgrade('/editor-tty/ws', '/editor-tty'));
    assert.ok(matchEditorUpgrade('/editor-tty?x', '/editor-tty'));
    assert.ok(!matchEditorUpgrade('/editor-ttyx/ws', '/editor-tty'));
    assert.ok(!matchEditorUpgrade('/tty/berth-ws-demo-0badf00d/ws', '/editor-tty'));
    // Not a workspace id, so the per-pod matcher never claims it either.
    assert.equal(matchWorkspaceUpgrade('/editor-tty/ws'), null);
});

test('a fixed target is used only once it answers, and forgotten on invalidate', async () => {
    const http = require('node:http');
    const server = http.createServer((req, res) => res.end(req.url));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
        const up = await resolveFixedTarget('__fixed-test__', '127.0.0.1', port, '/base/');
        assert.equal(up.ip, '127.0.0.1');
        assert.equal(up.port, port);
        invalidateTarget('__fixed-test__');
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
    // Nothing listening any more: a page, not a hang.
    assert.deepEqual(await resolveFixedTarget('__fixed-test__', '127.0.0.1', port, '/base/'), { notReady: true });
});
