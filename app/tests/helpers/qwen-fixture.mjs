import {mkdir,readFile,writeFile,access,cp} from 'node:fs/promises';
import path from 'node:path';

export function qwenDocument(input) {
  const {$schema,...qwen}=input;
  return {...($schema ? {$schema} : {}),models:{qwen}};
}

export async function installQwenProfiles(root) {
  for(const directory of ['render-profiles','render-recipes','workflows']) {
    await cp(new URL(`../../../library/${directory}`,import.meta.url),path.join(root,'library',directory),{recursive:true});
  }
}

// Qwen 领域测试以原生输入描述场景，磁盘夹具始终写入当前容器及逐页设置。
export async function writeQwenFixtureJson(target,value) {
  await mkdir(path.dirname(target),{recursive:true});
  if(target.endsWith('.prompt.json')) {
    if(!value.models)value=qwenDocument(value);
    if(path.basename(path.dirname(target))==='pages') {
      const render=target.replace(/\.prompt\.json$/,'.render.json');
      try {await access(render);} catch(error) {
        if(error.code!=='ENOENT')throw error;
        const project=JSON.parse(await readFile(path.join(path.dirname(target),'../project.json'),'utf8'));
        await writeFile(render,JSON.stringify({version:1,model_id:'qwen',profile_id:project.default_render_profile,canvas:project.canvas}));
      }
    }
  }
  await writeFile(target,JSON.stringify(value,null,2)+'\n');
}
