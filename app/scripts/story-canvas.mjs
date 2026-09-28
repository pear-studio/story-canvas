#!/usr/bin/env node
import path from 'node:path';
import { readJsonInput, extractOutputOption, writeJsonOutput } from './workbench-client.mjs';
import { executeWorkbench } from './workbench-actions/index.mjs';
import { restrictWorkbench } from './workbench-actions/access-policy.mjs';

// 与 DSH 共用操作注册表、参数校验和帮助，不再编写另一套 HTTP 路由。
let outFile, result;
try {
  let args;
  ({args,outFile}=extractOutputOption(process.argv.slice(2)));
  const agent={};
  if(args.includes('--lite')){restrictWorkbench(agent,['generation','training']);args=args.filter(arg=>arg!=='--lite');}
  let input;
  if(!args.length||['help','-h','--help'].includes(args[0])) {
    if(args.length>3)throw new Error('帮助用法：story-canvas.mjs help [分类或操作名] [字段主题]');
    input={operation:'help',...(args[1]?{target:args[1]}:{}),...(args[2]?{topic:args[2]}:{})};
  }else {
    if(args.length!==1 && (args.length!==3||args[1]!=='--args'))throw new Error('用法：story-canvas.mjs <操作名> [--args JSON文件|-] [--out 回执文件] [--lite]');
    if(args[2]&&args[2]!=='-'&&outFile&&path.resolve(args[2]).toLowerCase()===path.resolve(outFile).toLowerCase()){outFile=undefined;throw new Error('输入与输出必须使用不同文件');}
    input={operation:args[0],...(args[2]?{args:await readJsonInput(args[2])}:{})};
  }
  result=await executeWorkbench(input,{agent});
  if(input.operation==='help'&&!input.target)result.cli={usage:'node C:/Workspace/story-canvas/app/scripts/story-canvas.mjs <操作名> --args 参数.json --out 回执.json',help:'help [分类或操作名] [字段主题]；-h 与 --help 等价',output:'结果与 story_canvas 一致；--out 成功和失败都覆盖回执文件。错误或批量部分失败退出码为1，必须检查退出码和逐项结果，不重放整批。输入输出使用不同文件；--lite 限制生成和训练。'};
  // 部分失败仍保留完整逐项回执，同时让脚本通过退出码识别失败。
  if(result.error || result.counts&&['failed','unknown','not_executed','rejected','not_submitted'].some(key=>result.counts[key]>0))process.exitCode=1;
}catch(error) {
  try{result=JSON.parse(error.message);}catch{result={error:error.code??'command_failed',message:error.message};}
  process.exitCode=1;
}
if(outFile) {
  try{console.log(JSON.stringify(await writeJsonOutput(outFile,result)));}
  catch(error){console.error(JSON.stringify({error:'output_write_failed',message:error.message,result,recovery:'操作可能已经完成；先核验 result，不重放操作。'}));process.exitCode=1;}
}else console.log(JSON.stringify(result));
