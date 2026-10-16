'use strict';

const test = require('node:test');
const assert = require('node:assert');

process.env.NAMESPACE = 'dev';
process.env.KUBERNETES_SERVICE_HOST = '';
for (const name of Object.keys(process.env)) {
    if (name.startsWith('FILES_')) delete process.env[name];
}

const cfg = require('../lib/config');
const { describePod } = require('../lib/sessions');
const {
    buildWorkspacePodManifest, FILES_CONTAINER, FILES_PORT, WORKSPACE_CONTAINER,
} = require('../lib/podTemplate');

const ID = 'berth-ws-x-0badf00d';

function manifest(files) {
    return buildWorkspacePodManifest({
        id: ID, key: 'github.com/e/r', repoUrl: 'git@github.com:e/r.git',
        repoFullName: 'e/r', branch: 'main', baseBranch: 'main',
        sessionName: 'r-main', pvcName: ID, files,
    });
}

const sidecar = (m) => m.spec.containers.find((c) => c.name === FILES_CONTAINER);

test('files is on by default, with a pinned image', () => {
    assert.equal(cfg.files.enabled, true);
    assert.match(cfg.files.image, /^filebrowser\/filebrowser:v\d+\.\d+\.\d+$/);
});

test('the sidecar serves the whole repo PVC under its proxied base URL', () => {
    const m = manifest({ enabled: true, image: 'fb:test' });
    const c = sidecar(m);
    assert.ok(c, 'files sidecar present');
    assert.equal(c.image, 'fb:test');

    const args = c.args.join(' ');
    assert.match(args, /--noauth/);
    assert.match(args, /--root \/workspace(\s|$)/);
    assert.match(args, new RegExp(`--baseURL /files/${ID}(\\s|$)`));
    assert.match(args, new RegExp(`--port ${FILES_PORT}(\\s|$)`));
    assert.match(args, /--address 0\.0\.0\.0/);
    assert.match(args, /--disableExec/);
    assert.deepEqual(c.ports, [{ containerPort: FILES_PORT, name: 'files' }]);

    // The same PVC as the workspace, at the same path, so paths read alike.
    assert.deepEqual(c.volumeMounts.find((v) => v.mountPath === '/workspace'),
        { name: 'ws', mountPath: '/workspace' });
    const db = c.volumeMounts.find((v) => v.mountPath === '/database');
    assert.equal(m.spec.volumes.find((v) => v.name === db.name).emptyDir !== undefined, true);
});

test('the sidecar is unprivileged and never gates pod readiness', () => {
    const c = sidecar(manifest({ enabled: true, image: 'fb:test' }));
    assert.equal(c.securityContext.allowPrivilegeEscalation, false);
    assert.equal(c.securityContext.readOnlyRootFilesystem, true);
    assert.deepEqual(c.securityContext.capabilities.drop, ['ALL']);
    assert.ok(c.resources.limits.memory, 'bounded memory');
    // Pod readiness is the workspace's status in the UI.
    assert.equal(c.readinessProbe, undefined);
    assert.equal(c.livenessProbe, undefined);
});

test('a regular container, after the workspace container', () => {
    const m = manifest({ enabled: true, image: 'fb:test' });
    assert.equal(m.spec.containers[0].name, WORKSPACE_CONTAINER);
    assert.equal(m.spec.initContainers, undefined, 'not a native sidecar');
});

test('disabled leaves the pod single-container', () => {
    const m = manifest({ enabled: false, image: 'fb:test' });
    assert.deepEqual(m.spec.containers.map((c) => c.name), [WORKSPACE_CONTAINER]);
    assert.equal(m.spec.volumes.some((v) => v.name === 'files-db'), false);
});

test('filesUrl follows the pod, not the current setting', () => {
    const withFiles = manifest({ enabled: true, image: 'fb:test' });
    withFiles.status = { phase: 'Running' };
    assert.equal(describePod(withFiles).filesUrl, `/files/${ID}/`);

    // A pod started before files existed (or with it off) has no sidecar,
    // whatever the dashboard is set to now.
    const without = manifest({ enabled: false, image: 'fb:test' });
    without.status = { phase: 'Running' };
    assert.equal(describePod(without).filesUrl, null);
});
