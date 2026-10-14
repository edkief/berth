// What the card's Ralph button shows and does, from the session's `ralph`
// (lib/sessions.js ralphState()). Pure, so the state table is unit-tested.
//
// A UI that answers always wins over supervisord's view: a ralph someone
// started by hand in the terminal is `running`, and the button just opens it.

const STARTING = new Set(['STARTING', 'BACKOFF', 'RUNNING']);

/** Where the latest run stands, for a Ralph whose UI answers. */
function runningTitle(ralph) {
  const run = ralph.run;
  const tasks = ralph.tasks?.total != null ? `${ralph.tasks.passed}/${ralph.tasks.total} tasks` : null;
  if (!run) return ['Ralph web UI', tasks].filter(Boolean).join(' · ');
  const iteration = run.iteration != null ? `iteration ${run.iteration}${run.maxIterations ? `/${run.maxIterations}` : ''}` : null;
  return [`Ralph ${run.live ? 'running' : run.status || 'idle'}`, run.live ? run.taskId : null, iteration, tasks].filter(Boolean).join(' · ');
}

function stoppedTitle(daemon) {
  const why = daemon?.state === 'FATAL' ? ` — it gave up starting (${daemon.detail || 'see the ralph tab in the terminal'})`
    : daemon?.state === 'EXITED' ? ` — it exited (${daemon.detail || 'see the ralph tab in the terminal'})`
      : daemon?.state === 'STOPPING' ? ' — it is stopping'
        : '';
  return `Ralph is set up but not running${why}. Start it.`;
}

/**
 * @returns {{ state: 'running'|'starting'|'stopped'|'unset'|'unknown',
 *             action: 'open'|'start'|null, title: string, label: string }}
 * `action` null means the button is disabled.
 */
export function ralphView(ralph) {
  if (ralph?.ui) return { state: 'running', action: 'open', title: runningTitle(ralph), label: 'Open Ralph' };
  // No answer from the agent, or one from before it could start Ralph: it can
  // say nothing about setup, so nothing here offers to start it.
  if (!ralph || typeof ralph.configured !== 'boolean') {
    return { state: 'unknown', action: null, title: `Ralph ${ralph?.reason || 'is not running'} — start it from the terminal with \`ralph\``, label: 'Open Ralph' };
  }
  if (STARTING.has(ralph.daemon?.state)) {
    return { state: 'starting', action: 'open', title: 'Ralph is starting…', label: 'Open Ralph' };
  }
  if (ralph.configured) return { state: 'stopped', action: 'start', title: stoppedTitle(ralph.daemon), label: 'Start Ralph' };
  return {
    state: 'unset',
    action: 'start',
    title: 'Ralph is not set up here — start it, then plan the project from its Plan tab',
    label: 'Set up Ralph',
  };
}

export const RALPH_STATES = ['running', 'starting', 'stopped', 'unset', 'unknown'];
