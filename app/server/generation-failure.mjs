// 在原始异常仍含 cause 时解释错误；保留原始信息，不推断服务已退出或自动重提。
export function generationFailureMessage(error) {
  const message = error?.message ?? String(error);
  const code = error?.cause?.code ?? error?.code ?? '';
  if (error?.name === 'TimeoutError' || /TIMEOUT|ETIMEDOUT/.test(code) || /等待 ComfyUI 任务超时/.test(message)) {
    return `[runtime_timeout] ${message}；远端可能仍在执行。先 task.inspect 核查原任务及提交记录，再 runtime.health 查询连接；不要直接重提或重启。`;
  }
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|UND_ERR_SOCKET/.test(code) || message === 'fetch failed') {
    return `[runtime_connection_failed] ${message}${code ? ` (${code})` : ''}；连接失败不代表进程退出。先 runtime.health，必要时 runtime.hardware；核实本地服务未运行后才 runtime.start。已提交的任务先核查原任务，不盲目重提。`;
  }
  if (error?.comfyTerminal || /ComfyUI (任务失败|批次未完整完成)/.test(message)) {
    return `[runtime_execution_failed] ${message}；先 task.inspect 查看执行详情，修正输入或依赖；不要为执行错误直接重启服务。`;
  }
  return message;
}
