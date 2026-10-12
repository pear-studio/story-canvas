// 仅在创建已提交后调用；后续读取失败不能让调用方误以为需要重试创建。
export async function creationEditReceipt(readEdit, next) {
  try {
    return {saved:true,edit:await readEdit()};
  } catch (error) {
    return {saved:true,edit_error:{code:error.code??'edit_read_failed',message:'创建已保存，但编辑回执读取失败；使用 next 重新读取，不要重复创建。'},next};
  }
}
