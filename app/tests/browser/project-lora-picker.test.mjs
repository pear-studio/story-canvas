import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {chromium} from 'playwright';

test('自由文本配置按模型架构选择 LoRA，并在重新打开时刷新登记', async () => {
  const server=await createServer({root:fileURLToPath(new URL('../../',import.meta.url)),cacheDir:'../Saved/Tests/vite-project-lora-picker',optimizeDeps:{entries:[fileURLToPath(new URL('./fixtures/project-lora-picker.html',import.meta.url))],include:['react','react-dom','react-dom/client','react/jsx-runtime']},server:{host:'127.0.0.1',port:0},logLevel:'error'});
  await server.listen();
  const browser=await chromium.launch({headless:true,channel:process.platform==='win32'?'msedge':undefined});
  try {
    const page=await browser.newPage();
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    let includeNew=false;
    const resource=(name,family)=>({status:'available',resource:{id:name,name,file:{relative_path:`loras/${name}.safetensors`,sha256:name,size_bytes:100},architecture:{family,prompt_family:family},base_models:[],activation:{trigger_words:[],tags:[]},recommended_generation:{weight:{default:1,minimum:null,maximum:null,status:'untested'},status:'untested'},source:{type:'local_training'},previews:[],examples:[]}});
    await page.route('**/api/**',route=> {
      assert.equal(route.request().method(),'GET');
      const url=new URL(route.request().url());
      if(url.pathname==='/api/lora-resources')return route.fulfill({json:{resources:[resource('Qwen 初版','qwen-image-2-1'),resource('Anima 旧版','anima'),...(includeNew?[resource('Qwen 新登记','qwen-image-2-1')]:[])],raw:[],errors:[]}});
      return route.fulfill({headers:{'x-story-canvas-revision':'test-revision'},json:{render_profiles:[{id:'qwen',name:'Qwen',architecture_family:'qwen-image-2-1',prompt_family:null,inspection:{style_loras:{},prompt:{text:''},project_override:{changes:[],conflicts:[],blocked:false}}}]}});
    });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/browser/fixtures/project-lora-picker.html`);
    await page.getByRole('button',{name:'选择 LoRA',exact:true}).click();
    await page.getByText('Qwen 初版',{exact:true}).waitFor();
    assert.equal(await page.getByText('Anima 旧版',{exact:true}).count(),0);
    await page.getByRole('button',{name:'关闭',exact:true}).click();
    includeNew=true;
    await page.getByRole('button',{name:'选择 LoRA',exact:true}).click();
    await page.getByText('Qwen 新登记',{exact:true}).waitFor();
    assert.deepEqual(errors,[]);
  } finally {await browser.close();await server.close();}
});
