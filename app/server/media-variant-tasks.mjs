// 同一变体共用一次编码；最后一个消费者离开时才取消，预热也算消费者。
export function createMediaVariantTasks() {
  const tasks=new Map();
  return async function join(key,generate,signal) {
    signal?.throwIfAborted();
    let task=tasks.get(key);
    if(!task) {
      const controller=new AbortController();
      task={controller,consumers:0};
      const current=task;
      task.promise=Promise.resolve().then(()=>generate(controller.signal)).finally(()=>{
        if(tasks.get(key)===current)tasks.delete(key);
      });
      tasks.set(key,task);
    }
    task.consumers++;
    let abort;
    try {
      return await Promise.race([task.promise,new Promise((_,reject)=>{
        abort=()=>reject(signal.reason);
        signal?.addEventListener('abort',abort,{once:true});
        if(signal?.aborted)abort();
      })]);
    } finally {
      signal?.removeEventListener('abort',abort);
      if(--task.consumers===0) {
        if(tasks.get(key)===task)tasks.delete(key);
        task.controller.abort();
      }
    }
  };
}
