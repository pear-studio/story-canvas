// 仅在事实提交成功后调用。后续读取失败明确要求重读，不能诱发重复写入。
export async function savedFactReceipt(read, next) {
  try {return {saved:true,...await read()};}
  catch (error) {return {saved:true,refresh_required:true,next,read_error:{code:error.code ?? 'saved_fact_read_failed',message:'修改已保存，但最新内容读取失败；请重新读取，不要重复提交。'}};}
}
