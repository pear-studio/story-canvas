import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { captureCandidateSheet, latestPageTask, sheetPageCells, renderCandidateSheet, exportCandidateSheet } from '../server/candidate-sheet.mjs';
import { PAGES_INDEX_SCHEMA_ID } from '../server/pages-store.mjs';

test('最新任务零图不回退，部分结果按任务内顺序而非媒体排序',()=>{
  const page={page_key:{page_id:'page-001'},title:'页面',page_kind:'illustration'};
  const old={id:'old',created_at:'2026-01-01',status:'completed',items:[{page_key:page.page_key,candidate_id:'old',status:'available'}]};
  const latest={id:'new',created_at:'2026-01-02',status:'running',items:[
    {page_key:page.page_key,candidate_id:'b',status:'available'},
    {page_key:page.page_key,candidate_id:'a',status:'queued'},
  ]};
  assert.equal(latestPageTask([latest,old,latest],'page-001').id,'new');
  const rows=sheetPageCells(page,1,latest,[{task_id:'old',candidate_id:'old',absolute_file:'old.png'},{task_id:'new',candidate_id:'b',absolute_file:'new.png'}]);
  assert.deepEqual(rows.map(r=>r.candidate_id),['b','a']);
  assert.deepEqual(rows.map(r=>r.status),['available','queued']);
  assert.equal(rows[1].absolute_file,undefined);
  assert.equal(sheetPageCells(page,1,latest,[])[0].status,'missing');
});

test('章节按单元顺序与组内索引排列，文字页保留，空章可读且长范围自动分页',async t=>{
  const root=path.resolve(import.meta.dirname,'../../Saved/Tests');await mkdir(root,{recursive:true});
  const dir=await mkdtemp(path.join(root,'sheet-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await mkdir(path.join(dir,'story'));await mkdir(path.join(dir,'pages'));
  await writeFile(path.join(dir,'story/outline.json'),JSON.stringify({chapters:[{id:'chapter',sequences:[{id:'s2',title:'二'},{id:'s1',title:'一'}]},{id:'empty',sequences:[]}]}));
  const entries=Array.from({length:13},(_,i)=>({page_id:'page-'+String(i+1).padStart(3,'0'),owner_kind:'story',sequence_id:i===0?'s1':'s2'}));
  await writeFile(path.join(dir,'pages/index.json'),JSON.stringify({$schema:PAGES_INDEX_SCHEMA_ID,pages:entries}));
  for(const p of entries)await writeFile(path.join(dir,'pages',p.page_id+'.content.json'),JSON.stringify({title:p.page_id,page_kind:'text',body:'测试文字'}));
  const snapshot=await captureCandidateSheet(dir,{project_id:'demo',chapter_id:'chapter'});
  assert.equal(snapshot.pages[0].page_key.page_id,'page-002');assert.equal(snapshot.pages.at(-1).page_key.page_id,'page-001');
  const selected=await captureCandidateSheet(dir,{page_keys:[{page_id:'page-001'},{page_id:'page-002'}]});
  assert.deepEqual(selected.pages.map(p=>p.page_number),[1,13]);
  assert.deepEqual(selected.scope.page_keys,[{page_id:'page-002'},{page_id:'page-001'}]);
  await assert.rejects(captureCandidateSheet(dir,{page_keys:[{page_id:'missing'}]}),e=>e.code==='sheet_page_not_found');
  await assert.rejects(captureCandidateSheet(dir,{page_keys:[{page_id:'page-001'},{page_id:'page-001'}]}),e=>e.code==='duplicate_sheet_page');
  await assert.rejects(captureCandidateSheet(dir,{page_keys:[],chapter_id:'chapter'}),e=>e.code==='invalid_sheet_scope');
  const result=await exportCandidateSheet(dir,dir,snapshot);
  assert.equal(result.pages,13);assert.equal(result.sheets.length,2);assert.equal(result.images,0);assert.equal(result.problem_count,0);
  const empty=await captureCandidateSheet(dir,{project_id:'demo',chapter_id:'empty'});
  assert.equal(empty.pages.length,0);
  assert.equal((await exportCandidateSheet(dir,dir,empty)).sheets.length,0);
  await assert.rejects(captureCandidateSheet(dir,{chapter_id:'missing'}),e=>e.code==='sheet_scope_not_found');
});

test('中文标签、空文字、损坏图片可渲染，失败更新状态并保留位置',async()=>{
  const cells=[{ordinal:1,title:'中文 <标签>',page_key:{page_id:'page-001'},page_kind:'text',text:'',display_title:'',status:'text'},
    {ordinal:2,title:'不存在的图',page_key:{page_id:'page-002'},status:'available',absolute_file:'C:/missing-candidate-sheet-test.png',task_status:'completed'}];
  const png=await renderCandidateSheet(cells);
  const info=await sharp(png).metadata();assert.equal(info.width,960);assert.equal(info.height,700);
  assert.equal(cells[1].status,'image_unavailable');assert.equal(cells[1].absolute_file,undefined);
});
