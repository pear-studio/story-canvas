import { FactError, readJson as readFactJson, targetPath } from './fact-storage.mjs';
import {factConflict} from "./fact-conflict.mjs";
import {hashCanonicalJson} from './workflow-definition.mjs';
import {ApiError} from './http-support.mjs';

// 无服务端缓存的目标读据；保留完整 SHA-256，校验码区分转写损坏和真实版本变化。
const compactHash = value => Buffer.from(hashCanonicalJson(value),'hex').toString('base64url');
const checksum = value => compactHash(value).slice(0,6);
export function editFingerprint(identity,value) {
  const body=`edit2:${compactHash(identity).slice(0,11)}:${compactHash({identity,value})}`;
  return `${body}:${checksum(body)}`;
}
export function assertEditFingerprint(expected,current,{invalidCode,conflictCode}) {
  if(typeof expected!=='string'||!/^edit2:[A-Za-z0-9_-]{11}:[A-Za-z0-9_-]{43}:[A-Za-z0-9_-]{6}$/.test(expected))
    throw new ApiError(400,invalidCode,[{field:'expected_sha256',message:'请原样使用本目标最新读取回执中的 expected_sha256；旧格式读据需重新读取，不自行计算。'}]);
  if(checksum(expected.slice(0,expected.lastIndexOf(':')))!==expected.split(':')[3])
    throw new ApiError(400,'edit_receipt_corrupted',[{field:'expected_sha256',message:'读取凭据的校验码不符，可能被抄错或截断。本次未写入；核对读取回执并原样复制 save.args。这不是页面被占用或并发修改的证据。'}]);
  if(expected.split(':')[1]!==current.split(':')[1])
    throw new ApiError(409,'edit_receipt_target_mismatch',['读取凭据不属于本项目、目标或编辑范围；每项使用自己的 save.args，不能复用其他页面的凭据。本次未写入。']);
  if(expected!==current)throw factConflict(conflictCode,['凭据校验通过，但与当前目标版本不匹配；重新读取并核对正文与必要上游，本次未写入。不能据此断言 GUI 占用或页面卡死。']);
}

export async function assertTargetBaseline(projectDirectory, baselineContext) {
  let current;
  try { current = await readFactJson(targetPath(projectDirectory, baselineContext.target.relative_path), baselineContext.target.relative_path); }
  catch (error) {
    if (error instanceof FactError) throw factConflict('story_edit_target_conflict', [baselineContext.target.relative_path]);
    throw error;
  }
  if (hashCanonicalJson(current) !== baselineContext.target.sha256) throw factConflict('story_edit_target_conflict', [baselineContext.target.relative_path]);
  return current;
}
