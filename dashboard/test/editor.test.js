'use strict';

// The standalone editor: the workspace image in WORKSPACE_MODE=editor
// (k8s/editor.yaml), and the dashboard's read-only shortcut to it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { loadAllYaml } = require('@kubernetes/client-node');

process.env.NAMESPACE = 'dev';

const { editorHealth } = require('../../workspace/agent');
const { buildWorkspacePodManifest, PRIORITY_CLASS } = require('../lib/podTemplate');

const ROOT = path.join(__dirname, '..', '..');
const WORKSPACE = path.join(ROOT, 'workspace');

function manifests(file) {
    return loadAllYaml(fs.readFileSync(path.join(ROOT, 'k8s', file), 'utf8'));
}

test('editor readiness is bootstrap done and code-server answering, nothing else', () => {
    const up = { up: true, reason: null };
    const down = { up: false, reason: 'not running' };

    assert.deepEqual(editorHealth('starting', up, null), { ready: true, stage: 'ready', detail: null });
    assert.deepEqual(editorHealth('starting', down, null),
        { ready: false, stage: 'starting-editor', detail: 'code-server: not running' });
    // Mid-bootstrap, code-server is not even started yet: the stage wins.
    assert.deepEqual(editorHealth('syncing-config', up, null),
        { ready: false, stage: 'syncing-config', detail: null });
    assert.deepEqual(editorHealth('failed', up, 'could not seed claude config\n'),
        { ready: false, stage: 'failed', detail: 'could not seed claude config' });
});

test('the editor bootstrap skips the clone and the bootstrap claude remote', () => {
    const source = fs.readFileSync(path.join(WORKSPACE, 'entrypoint.sh'), 'utf8');
    const clone = source.indexOf('bootstrap/clone.sh');
    const launch = source.indexOf('claude remote --name');
    assert.ok(clone > 0 && launch > 0);
    // Both sit inside a branch that the editor mode does not take.
    const guardBefore = (at) => source.lastIndexOf('if [ "$WORKSPACE_MODE"', at);
    assert.match(source.slice(guardBefore(clone), clone), /= "editor" \]; then[\s\S]*else/);
    assert.match(source.slice(guardBefore(launch), launch), /!= "editor" \]; then/);
    assert.match(source, /export CODE_ENABLE=1/);
});

test('supervisord leaves ttyd and codexapp stopped when WORKSPACE_TERMINALS is false', () => {
    const source = fs.readFileSync(path.join(WORKSPACE, 'supervisord.conf'), 'utf8');
    for (const program of ['ttyd', 'codex-ui']) {
        const section = source.match(new RegExp(`^\\[program:${program}\\]\\n([\\s\\S]*?)(?=^\\[)`, 'm'));
        assert.ok(section, `[program:${program}] is missing`);
        assert.match(section[1], /^autostart=%\(ENV_WORKSPACE_TERMINALS\)s$/m);
    }
    // supervisord refuses to start on an unset %(ENV_*)s: the entrypoint
    // must set it in both modes.
    const entry = fs.readFileSync(path.join(WORKSPACE, 'entrypoint.sh'), 'utf8');
    assert.match(entry, /export WORKSPACE_TERMINALS=false/);
    assert.match(entry, /export WORKSPACE_TERMINALS=true/);
});

test('k8s/editor.yaml: one Recreate replica, outside every workspace selector', () => {
    const docs = manifests('editor.yaml');
    const kinds = Object.fromEntries(docs.map((d) => [d.kind, d]));
    for (const kind of ['PersistentVolumeClaim', 'Deployment', 'Service', 'Ingress']) {
        assert.ok(kinds[kind], `${kind} is missing`);
        assert.equal(kinds[kind].metadata.labels?.app, 'berth-editor');
    }
    const d = kinds.Deployment;
    assert.equal(d.spec.replicas, 1);
    // RollingUpdate would deadlock on the RWO volume.
    assert.equal(d.spec.strategy.type, 'Recreate');
    assert.equal(d.spec.template.metadata.labels.app, 'berth-editor');
    assert.equal(d.spec.template.spec.priorityClassName, undefined, 'the editor must not count against the workspace quota');
    assert.equal(d.spec.template.spec.automountServiceAccountToken, false);

    const tolerations = Object.fromEntries(d.spec.template.spec.tolerations.map((t) => [t.key, t.tolerationSeconds]));
    assert.ok(tolerations['node.kubernetes.io/not-ready'] <= 60);
    assert.ok(tolerations['node.kubernetes.io/unreachable'] <= 60);

    const c = d.spec.template.spec.containers[0];
    assert.equal(c.env.find((e) => e.name === 'WORKSPACE_MODE').value, 'editor');
    assert.equal(c.readinessProbe.httpGet.path, '/healthz');
    assert.equal(c.livenessProbe.httpGet.path, '/livez');
    assert.deepEqual(c.volumeMounts.find((m) => m.mountPath === '/workspace').name,
        d.spec.template.spec.volumes.find((v) => v.persistentVolumeClaim?.claimName === kinds.PersistentVolumeClaim.metadata.name).name);

    assert.equal(kinds.Service.spec.selector.app, 'berth-editor');
});

test('k8s/editor.yaml: the ingress carries the auth middleware (code-server runs --auth none)', () => {
    const ingress = manifests('editor.yaml').find((d) => d.kind === 'Ingress');
    assert.equal(ingress.metadata.annotations['traefik.ingress.kubernetes.io/router.middlewares'],
        'authz-proxy-authz-reverse-proxy@kubernetescrd');
    assert.equal(ingress.spec.rules[0].host, 'code.kieffer.me');
    assert.deepEqual(ingress.spec.tls[0].hosts, ['code.kieffer.me']);
});

test('the workspace quota counts only pods in the workspace PriorityClass', () => {
    const docs = manifests('dashboard.yaml');
    assert.ok(docs.find((d) => d.kind === 'PriorityClass' && d.metadata.name === PRIORITY_CLASS));
    const quota = docs.find((d) => d.kind === 'ResourceQuota' && d.metadata.name === 'berth-workspaces');
    assert.deepEqual(quota.spec.scopeSelector.matchExpressions,
        [{ scopeName: 'PriorityClass', operator: 'In', values: [PRIORITY_CLASS] }]);
    // A PriorityClass-scoped quota rejects non-pod resources.
    assert.equal(quota.spec.hard.persistentvolumeclaims, undefined);
    assert.ok(docs.find((d) => d.kind === 'ResourceQuota' && d.spec.hard.persistentvolumeclaims && !d.spec.scopeSelector));

    const pod = buildWorkspacePodManifest({
        id: 'berth-ws-x-0badf00d', key: 'github.com/e/r',
        repoUrl: 'git@github.com:e/r.git', repoFullName: 'e/r',
        branch: 'main', baseBranch: 'main', sessionName: 'r-main',
        pvcName: 'berth-ws-x-0badf00d',
    });
    assert.equal(pod.spec.priorityClassName, PRIORITY_CLASS);
});
