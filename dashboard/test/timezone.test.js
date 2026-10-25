'use strict';

const test = require('node:test');
const assert = require('node:assert');

process.env.NAMESPACE = 'dev';
process.env.KUBERNETES_SERVICE_HOST = '';
delete process.env.WORKSPACE_TIMEZONE;

const cfg = require('../lib/config');
const { buildWorkspacePodManifest, workspaceContainer } = require('../lib/podTemplate');

const ID = 'berth-ws-x-0badf00d';

function tzEnv() {
    const m = buildWorkspacePodManifest({
        id: ID, key: 'github.com/e/r', repoUrl: 'git@github.com:e/r.git',
        repoFullName: 'e/r', branch: 'main', baseBranch: 'main',
        sessionName: 'r-main', pvcName: ID,
    });
    return workspaceContainer(m).env.find((e) => e.name === 'TZ');
}

test('no TZ is injected unless WORKSPACE_TIMEZONE is set', () => {
    assert.equal(cfg.timezone, '');
    assert.equal(tzEnv(), undefined);
});

test('WORKSPACE_TIMEZONE becomes TZ on the workspace container', () => {
    cfg.timezone = 'Europe/Paris';
    try {
        assert.deepEqual(tzEnv(), { name: 'TZ', value: 'Europe/Paris' });
    } finally {
        cfg.timezone = '';
    }
});
