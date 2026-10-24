'use strict';

const { core } = require('./k8s');
const cfg = require('./config');

/**
 * The standalone editor (k8s/editor.yaml) as the dashboard sees it: a link and
 * a status, nothing more. It is IaC, not dashboard-owned -- the dashboard
 * neither proxies, creates nor scales it -- so this only reads its pods, which
 * the existing `list pods` grant already covers.
 */

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

async function getEditor() {
    if (!cfg.editorUrl) return { url: null };
    try {
        const res = await core.listNamespacedPod({
            namespace: cfg.namespace,
            labelSelector: `app=${cfg.labels.editor}`,
        });
        return { url: cfg.editorUrl, status: editorStatus(res.items) };
    } catch {
        // Still a link worth showing; the dot just cannot say.
        return { url: cfg.editorUrl, status: 'unknown' };
    }
}

module.exports = { editorStatus, getEditor };
