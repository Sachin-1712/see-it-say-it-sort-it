// Reject stale/duplicate telemetry without changing the physical workbench state.
export class SwarmFrames {
  task = null; version = -1; timestamps = new Map(); stream = null; sequence = -1;
  accept(frame) {
    if (frame.protocol !== "gekko-swarm-v1") return false;
    if(frame.stream_id && frame.stream_id!==this.stream){this.stream=frame.stream_id;this.sequence=-1;this.version=-1;this.task=null;this.timestamps.clear();}
    if(Number.isInteger(frame.frame_seq)){if(frame.frame_seq<=this.sequence)return false;this.sequence=frame.frame_seq;}
    if (!frame.task) return true;
    const {task_id:id, scene_version:version} = frame.task;
    if (!Number.isInteger(version) || version < this.version) return false;
    if (version === this.version && this.task && id !== this.task) return false;
    if (version > this.version) { this.version=version; this.task=id; this.timestamps.clear(); }
    frame.ghosts = (frame.ghosts ?? []).filter(trial => {
      if (trial.task_id !== id || trial.scene_version !== version || !Number.isFinite(trial.timestamp)) return false;
      const prior=this.timestamps.get(trial.agent) ?? -Infinity;
      if (trial.timestamp <= prior) return false;
      this.timestamps.set(trial.agent,trial.timestamp); return true;
    });
    return true;
  }
}
