'use strict';

const cfg = require('./config');
const { slug } = require('./naming');

const LABEL = {
    workspaceKey: 'berth.kieffer.me/workspace-key',
    repo: 'berth.kieffer.me/repo',
    branch: 'berth.kieffer.me/branch',
};

/**
 * The container that runs claude. Every status, limit and port the dashboard
 * reports comes from this one: the Pod also carries sidecars, and the kubelet
 * orders `status.containerStatuses` by name, not spec order, so index 0 is not
 * it once a sidecar sorts first ("files" < "workspace").
 */
const WORKSPACE_CONTAINER = 'workspace';
const FILES_CONTAINER = 'files';
const FILES_PORT = 7685;
const CODE_PORT = 7686;

const ANN = {
    repoUrl: 'berth.kieffer.me/repo-url',
    repoFullName: 'berth.kieffer.me/repo-full-name',
    branch: 'berth.kieffer.me/branch',
    baseBranch: 'berth.kieffer.me/base-branch',
    keyRaw: 'berth.kieffer.me/workspace-key-raw',
    sessionName: 'berth.kieffer.me/session-name',
    startedAt: 'berth.kieffer.me/started-at',
    resourceProfile: 'berth.kieffer.me/resource-profile',
};

/**
 * Build the Pod manifest for a workspace.
 *
 * Kept as code rather than a ConfigMap-mounted YAML template: nearly every
 * field is computed, so a template would need a placeholder per field and could
 * drift out from under the code. The tunable parts come from dashboard env vars
 * (see config.js), so retuning is a Deployment edit, not an image rebuild.
 *
 * Pure function -- unit-testable with no cluster.
 */
function buildWorkspacePodManifest({
    id, key, repoUrl, repoFullName, branch, baseBranch,
    newBranch = null, sessionName, pvcName, resetHard = false,
    resourceProfile = 'default', resources = cfg.workspaceResources,
    ralph = cfg.ralph, files = cfg.files, code = cfg.code,
}) {
    const branchSlug = slug(branch, 40);

    return {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: {
            name: id,
            namespace: cfg.namespace,
            labels: {
                app: cfg.labels.app,
                'app.kubernetes.io/managed-by': cfg.labels.managedBy,
                [LABEL.workspaceKey]: id,
                [LABEL.repo]: slug(repoFullName.split('/').pop(), 63),
                [LABEL.branch]: branchSlug,
            },
            annotations: {
                [ANN.repoUrl]: repoUrl,
                [ANN.repoFullName]: repoFullName,
                [ANN.branch]: branch,
                [ANN.baseBranch]: baseBranch,
                [ANN.keyRaw]: key,
                [ANN.sessionName]: sessionName,
                [ANN.startedAt]: new Date().toISOString(),
                [ANN.resourceProfile]: resourceProfile,
            },
        },
        spec: {
            // The pod name is the storage identity (repo + hash), which is what
            // the shell prompt and any hostname-derived UI would otherwise show.
            // Name the host after the session instead: "my-repo-main".
            hostname: slug(sessionName, 63),
            // OOMKill restarts the container in place: same pod IP (so the tty
            // proxy target cache stays valid), PVC stays attached, checkout
            // survives. That is the whole point of a bare Pod here.
            restartPolicy: 'Always',
            terminationGracePeriodSeconds: 30,
            // Workspaces run agent-authored code and must not hold a token that
            // could create more pods.
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            securityContext: {
                runAsUser: 1000,
                runAsGroup: 1000,
                fsGroup: 1000,
                fsGroupChangePolicy: 'OnRootMismatch',
            },
            containers: [{
                name: WORKSPACE_CONTAINER,
                image: cfg.workspaceImage,
                imagePullPolicy: cfg.imagePullPolicy,
                ports: [
                    { containerPort: 7681, name: 'tty' },
                    { containerPort: 7682, name: 'agent' },
                    { containerPort: 7684, name: 'codex-ui' },
                    ...(ralph.enabled ? [{ containerPort: ralph.uiPort, name: 'ralph-ui' }] : []),
                    ...(code.enabled ? [{ containerPort: CODE_PORT, name: 'code-ui' }] : []),
                ],
                env: [
                    { name: 'WORKSPACE_ID', value: id },
                    { name: 'REPO_URL', value: repoUrl },
                    { name: 'GIT_REF', value: baseBranch },
                    { name: 'BRANCH', value: branch },
                    { name: 'BRANCH_SLUG', value: branchSlug },
                    { name: 'NEW_BRANCH', value: newBranch || '' },
                    { name: 'FORCE_RESET', value: resetHard ? 'true' : 'false' },
                    { name: 'CLAUDE_SESSION_NAME', value: sessionName },
                    // ttyd bakes its base path into the JS it serves, so the
                    // dashboard hands it the exact prefix it is proxied under.
                    { name: 'TTY_BASE_PATH', value: `/tty/${id}` },
                    // codexapp gets its base path as a CLI argument in
                    // supervisord. CODEX_HOME stays on the repo PVC across
                    // pod swaps.
                    { name: 'CODEX_HOME', value: '/workspace/_home/codex' },
                    // pi (Ralph's other harness) keeps its auth and models.json
                    // here, on the PVC, for the same reason.
                    { name: 'PI_CODING_AGENT_DIR', value: '/workspace/_home/pi' },
                    ...ralphEnv(id, ralph),
                    // Read by workspace/bootstrap/code-server.sh; absent, the
                    // supervised editor exits at once and nothing listens.
                    ...(code.enabled ? [{ name: 'CODE_ENABLE', value: '1' }] : []),
                    { name: 'CLAUDE_CODE_VERSION', value: cfg.claudeCodeVersion },
                    { name: 'OPENCODE_VERSION', value: cfg.opencodeVersion },
                    { name: 'PI_VERSION', value: cfg.piVersion },
                    { name: 'CONFIG_PUSH_POLICY', value: cfg.configPushPolicy },
                    // Where the shared OAuth token lives. Propagated rather
                    // than defaulted per-pod: a dashboard pointing at a
                    // separate auth bucket and pods still reading the config
                    // one would silently split the login in two.
                    { name: 'AUTH_S3_BUCKET', value: cfg.authS3Bucket },
                    { name: 'AUTH_S3_KEY', value: cfg.authS3Key },
                    { name: 'POD_NAME', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
                    {
                        name: 'GITHUB_TOKEN',
                        valueFrom: {
                            secretKeyRef: { name: cfg.githubSecretName, key: 'github_token' },
                        },
                    },
                ],
                envFrom: [
                    // Read-write or read-only S3 credentials depending on
                    // CONFIG_PUSH_POLICY, so the policy is enforced by the
                    // credentials themselves rather than by convention.
                    { secretRef: { name: cfg.workspaceS3Secret() } },
                ],
                resources,
                volumeMounts: [
                    { name: 'ws', mountPath: '/workspace' },
                    { name: 'ws', mountPath: '/home/ubuntu/.claude', subPath: '_home/claude' },
                    { name: 'github-ssh', mountPath: '/run/secrets/github-ssh', readOnly: true },
                ],
                // Replaces the old 30s `tmux capture-pane` poll in the API.
                // failureThreshold is generous: a cold start pulls a large
                // image, syncs config and clones a repo.
                readinessProbe: {
                    httpGet: { path: '/healthz', port: 7682 },
                    initialDelaySeconds: 5,
                    periodSeconds: 3,
                    failureThreshold: 60,
                },
                // /livez is not "is the agent up" -- that is always yes. It
                // reports whether the workspace is salvageable in place: it
                // fails only after the pod was ready, claude died, and in-pane
                // relaunch was exhausted. Readiness gates nothing but the UI
                // here, so this is the only thing that can restart a wedged
                // workspace.
                livenessProbe: {
                    httpGet: { path: '/livez', port: 7682 },
                    initialDelaySeconds: 120,
                    periodSeconds: 30,
                    failureThreshold: 4,
                },
            }, ...(files.enabled ? [filesContainer(id, files)] : [])],
            volumes: [
                { name: 'ws', persistentVolumeClaim: { claimName: pvcName } },
                { name: 'github-ssh', secret: { secretName: cfg.githubSecretName, defaultMode: 0o400 } },
                ...(files.enabled ? [{ name: 'files-db', emptyDir: { sizeLimit: '256Mi' } }] : []),
            ],
        },
    };
}

/**
 * Read by `ralph` itself -- the supervised daemon and any ralph started by
 * hand -- plus RALPH_ENABLE, which turns on the agent's side. RALPH_UI makes a
 * hand-run loop serve its web UI too (the daemon always does); the host, port
 * and base path put it where the dashboard proxies it. 0.0.0.0 because the
 * dashboard reaches the pod IP, never loopback -- the NetworkPolicy and the
 * ingress auth are the boundary, the same as for ttyd and codexapp. That is
 * also why RALPH_UI_ACTIONS is `open`: off loopback, Ralph otherwise refuses
 * every action (Plan, Run, Pause, answering it), and setting Ralph up from
 * the dashboard means planning in its UI.
 */
function ralphEnv(id, ralph) {
    if (!ralph.enabled) return [];
    return [
        { name: 'RALPH_ENABLE', value: '1' },
        { name: 'RALPH_UI', value: '1' },
        { name: 'RALPH_UI_HOST', value: '0.0.0.0' },
        { name: 'RALPH_UI_PORT', value: String(ralph.uiPort) },
        { name: 'RALPH_UI_BASE_PATH', value: `/ralph/${id}` },
        { name: 'RALPH_UI_ACTIONS', value: 'open' },
    ];
}

/**
 * filebrowser over the whole repo PVC, as its own container rather than a
 * supervisord program in the workspace: a runaway agent that OOMs the
 * workspace container is exactly when you want to get at its files, and a
 * sidecar keeps its own memory limit and restarts on its own.
 *
 * A regular container, not a native sidecar (an init container with
 * restartPolicy Always): a native sidecar must start before the workspace
 * does, so a failed pull of this image would hold every workspace at
 * PodInitializing. No readiness probe either -- pod readiness is the
 * workspace's status in the UI, and the dashboard probes /health itself
 * before proxying.
 *
 * --noauth: the ingress auth plus the NetworkPolicy are the boundary, as for
 * ttyd and codexapp. --baseURL means the proxy rewrites nothing. The command
 * replaces the image's init script, which would write its own config and
 * database paths; the database (users, settings) is throwaway and lives on
 * an emptyDir, so quick setup runs fresh in every pod.
 */
function filesContainer(id, files) {
    return {
        name: FILES_CONTAINER,
        image: files.image,
        imagePullPolicy: 'IfNotPresent',
        command: ['filebrowser'],
        args: [
            '--noauth',
            '--root', '/workspace',
            '--baseURL', `/files/${id}`,
            '--address', '0.0.0.0',
            '--port', String(FILES_PORT),
            '--database', '/database/filebrowser.db',
            '--disableExec',
        ],
        ports: [{ containerPort: FILES_PORT, name: 'files' }],
        // Fixed rather than profile-driven: these are filebrowser's needs, not
        // the workspace's. The memory limit bounds a large zip download.
        resources: {
            requests: { cpu: '10m', memory: '32Mi' },
            limits: { cpu: '500m', memory: '256Mi' },
        },
        // Runs as the pod's uid 1000, so what it writes is owned by `ubuntu`.
        securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ['ALL'] },
        },
        volumeMounts: [
            { name: 'ws', mountPath: '/workspace' },
            { name: 'files-db', mountPath: '/database', subPath: 'database' },
            // The root filesystem is read-only; give Go's temp dir somewhere.
            { name: 'files-db', mountPath: '/tmp', subPath: 'tmp' },
        ],
    };
}

/** Falls back to the first entry for a pod whose containers were never named. */
function byWorkspaceName(list) {
    return list.find((c) => c.name === WORKSPACE_CONTAINER) || list[0];
}

function workspaceContainer(pod) {
    return byWorkspaceName(pod?.spec?.containers || []);
}

function workspaceContainerStatus(pod) {
    return byWorkspaceName(pod?.status?.containerStatuses || []);
}

module.exports = {
    buildWorkspacePodManifest, LABEL, ANN,
    WORKSPACE_CONTAINER, workspaceContainer, workspaceContainerStatus,
    FILES_CONTAINER, FILES_PORT, CODE_PORT,
};
