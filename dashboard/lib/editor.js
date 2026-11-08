'use strict';

const { core } = require('./k8s');
const cfg = require('./config');

/**
 * The standalone editor (k8s/editor.yaml) as the dashboard sees it: a link, a
 * status, and its herdr terminal. It is IaC, not dashboard-owned -- the
 * dashboard neither creates nor scales it -- so this only reads its pods, which
 * the existing `list pods` grant already covers.
 *
 * The one thing proxied is the herdr terminal: ttyd on EDITOR_TTY_PORT, told
 * TTY_BASE_PATH=EDITOR_TTY_BASE by editor.yaml, reached through the editor's
 * Service (which follows a rescheduled pod) like the config shell's fixed
 * target, rather than resolved per pod like /tty/<id>.
 */

const EDITOR_TTY_BASE = '/editor-tty';
const EDITOR_TTY_PORT = 7681;
const EDITOR_TERMINAL_URL = '/terminal/editor/';
const EDITOR_SERVICE = cfg.labels.editor;

const isReady = (pod) => (pod.status?.conditions || [])
    .some((c) => c.type === 'Ready' && c.status === 'True');

/**
 * Pure: the editor's pods -> running | starting | down. A Recreate rollout
 * briefly has the old pod terminating beside (or instead of) the new one, so
 * a terminating pod counts for nothing.
 */
function editorStatus(pods) {
    const live = (pods || []).filter((p) => !p.metadata?.deletionTimestamp
        && !['Failed', 'Succeeded'].includes(p.status?.phase));
    if (live.some(isReady)) return 'running';
    if (live.length) return 'starting';
    return 'down';
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/**
 * Pure: does a live editor pod run the herdr terminal? It does when it was
 * started with HERDR_ENABLE and declares the `tty` port -- read from the pod,
 * like codeAvailable(), so it follows what is deployed, not a dashboard flag.
 */
function editorTerminal(pods) {
    return (pods || []).some((p) => {
        if (p.metadata?.deletionTimestamp || ['Failed', 'Succeeded'].includes(p.status?.phase)) return false;
        const c = (p.spec?.containers || []).find((x) => x.name === 'workspace');
        if (!c?.ports?.some((port) => port.name === 'tty')) return false;
        const flag = (c.env || []).find((e) => e.name === 'HERDR_ENABLE')?.value;
        return TRUTHY.has(String(flag ?? '').toLowerCase());
    });
}

async function getEditor() {
    if (!cfg.editorUrl) return { url: null };
    try {
        const res = await core.listNamespacedPod({
            namespace: cfg.namespace,
            labelSelector: `app=${cfg.labels.editor}`,
        });
        return {
            url: cfg.editorUrl,
            status: editorStatus(res.items),
            terminalUrl: editorTerminal(res.items) ? EDITOR_TERMINAL_URL : null,
        };
    } catch {
        // Still a link worth showing; the dot just cannot say.
        return { url: cfg.editorUrl, status: 'unknown', terminalUrl: null };
    }
}

module.exports = {
    editorStatus, editorTerminal, getEditor,
    EDITOR_TTY_BASE, EDITOR_TTY_PORT, EDITOR_TERMINAL_URL, EDITOR_SERVICE,
};
