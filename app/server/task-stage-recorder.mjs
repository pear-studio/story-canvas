// 阶段随实际提交记录持久化；同一批次的远端执行只记一次，下载和保存按输出条目记录。
export function createTaskStageRecorder(record, persist, { now = () => new Date().toISOString(), clock = () => performance.now() } = {}) {
  record.stages = [];
  return {
    async start(phase, itemId = null) {
      const stage = { phase, item_id: itemId, started_at: now(), ended_at: null, duration_ms: null, status: "running" };
      const start = clock();
      record.stages.push(stage);
      await persist(record);
      return async (error = null) => {
        Object.assign(stage, { ended_at: now(), duration_ms: Math.max(0, Math.round(clock() - start)), status: error ? "failed" : "completed" });
        if (error) stage.error = error.message ?? String(error);
        await persist(record);
      };
    },
    async measure(phase, action, itemId = null) {
      const finish = await this.start(phase, itemId);
      try {
        const value = await action();
        await finish();
        return value;
      } catch (error) {
        await finish(error);
        throw error;
      }
    },
  };
}
