// Presentation text derives only from backend state and evidence.
export const SAVED_LABEL='PREVIOUSLY VALIDATED — NOT THIS LIVE RUN';
export function resultLabel(best) {
  return best?.attribution==='previously_validated' ? SAVED_LABEL : 'VALIDATED IN THIS LIVE RUN';
}
export function recoveryText(recovery, stopped=false) {
  const r=recovery;
  if(!r)return '';
  const death=`AGENT ${r.dead.toUpperCase()} TERMINATED`;
  const count=r.active_before!=null?`${r.active_before} → ${r.active_before-1} ACTIVE`:'';
  if(!r.successor)return `${death} · ${count} · ${stopped?'LIVE SEARCH STOPPED':r.silenced?'RECOVERY UNCONFIRMED — PEER NETWORK OFF':'RECOVERY IN PROGRESS — awaiting real takeover'}`;
  const task=(r.role==='validator'?'validation':r.role??'unknown').toUpperCase();
  return `${death} · ${count} · ${r.successor.toUpperCase()} TAKES OVER ${r.dead.toUpperCase()}'S ${task} TASK · ${stopped?'LIVE SEARCH STOPPED · ':r.successor_alive?'':'SUCCESSOR OFFLINE · '}checkpoint ${r.checkpoint_id} · previous progress ${r.recovered_progress} (${r.recovered_trials} trials) · ${r.new_trials} new trials · ${r.resumed?'WORK RESUMED':'awaiting resumed trials'} · ${r.improving?'NEW LIVE VALIDATED PLAN SINCE DEATH':`${r.continuing_trials} additional trials since death; no new validated result yet`}`;
}
