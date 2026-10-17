import test from 'node:test';
import assert from 'node:assert/strict';
import {editFingerprint,assertEditFingerprint} from '../server/edit-fingerprint.mjs';

const codes={invalidCode:'invalid_page_edit_fingerprint',conflictCode:'page_edit_conflict'};
test('转写损坏、错误目标和真正的过时读据分别诊断，保留并发保护',()=>{
  const current=editFingerprint({page:'a',section:'content'},{text:'原文'});
  assert.equal(current.length,68);
  assert.doesNotThrow(()=>assertEditFingerprint(current,current,codes));
  const index=23,typo=current.slice(0,index)+(current[index]==='a'?'b':'a')+current.slice(index+1);
  assert.throws(()=>assertEditFingerprint(typo,current,codes),e=>e.code==='edit_receipt_corrupted'&&e.status===400&&!e.refresh_required);
  assert.throws(()=>assertEditFingerprint(current.slice(0,-1),current,codes),{code:'invalid_page_edit_fingerprint'});
  assert.throws(()=>assertEditFingerprint('edit1:09d6e2d68135d0ea:'+'a'.repeat(64),current,codes),{code:'invalid_page_edit_fingerprint'});
  assert.throws(()=>assertEditFingerprint(editFingerprint({page:'b',section:'content'},{text:'原文'}),current,codes),{code:'edit_receipt_target_mismatch'});
  assert.throws(()=>assertEditFingerprint(editFingerprint({page:'a',section:'content'},{text:'旧文'}),current,codes),e=>e.code==='page_edit_conflict'&&e.refresh_required===true);
});
