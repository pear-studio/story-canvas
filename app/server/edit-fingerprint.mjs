import {hashCanonicalJson} from './workflow-definition.mjs';
import {ApiError} from './http-support.mjs';

// 无服务端缓存的目标读据；完整版本仍覆盖目标和依赖，前缀仅用于区分拿错目标。
export function editFingerprint(identity,value) {
  return `edit1:${hashCanonicalJson(identity).slice(0,16)}:${hashCanonicalJson({identity,value})}`;
}
export function assertEditFingerprint(expected,current,{invalidCode,conflictCode}) {
  if(typeof expected!=='string'||!/^edit1:[a-f0-9]{16}:[a-f0-9]{64}$/.test(expected))
    throw new ApiError(400,invalidCode,[{field:'expected_sha256',message:'请原样使用本目标最新读取回执中的 expected_sha256；旧格式读据需重新读取，不自行计算。'}]);
  if(expected.split(':')[1]!==current.split(':')[1])
    throw new ApiError(409,'edit_receipt_target_mismatch',['读取凭据不属于本项目、目标或编辑范围；每项使用自己的 save.args，不能复用其他页面的凭据。本次未写入。']);
  if(expected!==current)throw new ApiError(409,conflictCode,['本目标或必要上游已变化；重新读取并判断修改，本次未写入。']);
}
