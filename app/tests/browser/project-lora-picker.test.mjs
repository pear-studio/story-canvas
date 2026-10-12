import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {chromium} from 'playwright';

test('LoRA 按所选模型筛选并保存，非默认模型可独立调整，重新打开刷新登记', async () => {
  const server=await createServer({root:fileURLToPath(new URL('../../',import.meta.url)),cacheDir:'../Saved/Tests/vite-project-lora-picker',optimizeDeps:{entries:[fileURLToPath(new URL('./fixtures/project-lora-picker.html',import.meta.url))],include:['react','react-dom','react-dom/client','react/jsx-runtime']},server:{host:'127.0.0.1',port:0},logLevel:'error'});
  await server.listen();
  const browser=await chromium.launch({headless:true,channel:process.platform==='win32'?'msedge':undefined});
  try {
    const page=await browser.newPage();
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    let includeNew=false;
    const writes=[];
    let override={version:1,profiles:{}};
    const resource=(name,family)=>({status:'available',resource:{id:name,name,file:{relative_path:`loras/${name}.safetensors`,sha256:name,size_bytes:100},architecture:{family,prompt_family:family},base_models:[],activation:{trigger_words:[],tags:[]},recommended_generation:{weight:{default:1,minimum:null,maximum:null,status:'untested'},status:'untested'},source:{type:'local_training'},previews:[],examples:[]}});
    await page.route('**/api/**',route=> {
      const url=new URL(route.request().url());
      if(route.request().method()==='PUT') {
        assert.equal(url.pathname,'/api/projects/test/render-profile-override');
        override=route.request().postDataJSON();writes.push(override);
        return route.fulfill({headers:{'x-story-canvas-revision':'test-revision'},json:{saved:true,override}});
      }
      assert.equal(route.request().method(),'GET');
      if(url.pathname.endsWith('/render-profile-override'))return route.fulfill({headers:{'x-story-canvas-revision':'test-revision'},json:{override}});
      if(url.pathname==='/api/lora-resources')return route.fulfill({json:{resources:[resource('Qwen 初版','qwen-image-2-1'),resource('Anima 旧版','anima'),...(includeNew?[resource('Qwen 新登记','qwen-image-2-1')]:[])],raw:[],errors:[]}});
      return route.fulfill({headers:{'x-story-canvas-revision':'test-revision'},json:{render_profiles:[['qwen','Qwen','qwen-image-2-1'],['anima','Anima','anima']].map(([id,name,architecture_family])=>({id,name,architecture_family,prompt_family:null,models:{},style_loras:{},inspection:{style_loras:{},prompt:{text:''},project_override:{changes:[],conflicts:[],blocked:false}}}))}});
    });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/browser/fixtures/project-lora-picker.html`);
    await page.getByRole('button',{name:'选择 LoRA',exact:true}).click();
    await page.getByText('Qwen 初版',{exact:true}).waitFor();
    assert.equal(await page.getByText('Anima 旧版',{exact:true}).count(),0);
    await page.getByRole('button',{name:'用途分类筛选',exact:true}).click();
    await page.getByRole('group',{name:'用途分类选项',exact:true}).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog',{name:'选择 LoRA',exact:true}).count(),1);
    assert.equal(await page.getByRole('group',{name:'用途分类选项',exact:true}).count(),0);
    await page.getByRole('button',{name:'关闭',exact:true}).click();
    includeNew=true;
    await page.getByRole('button',{name:'选择 LoRA',exact:true}).click();
    await page.getByText('Qwen 新登记',{exact:true}).waitFor();
    await page.getByRole('button',{name:'关闭',exact:true}).click();
    await page.getByLabel('LoRA 所属模型',{exact:true}).selectOption('anima');
    await page.getByRole('button',{name:'选择 LoRA',exact:true}).click();
    await page.getByText('Anima 旧版',{exact:true}).waitFor();
    assert.equal(await page.getByText('Qwen 初版',{exact:true}).count(),0);
    await page.getByRole('dialog',{name:'选择 LoRA',exact:true}).getByRole('button',{name:'选择',exact:true}).click();
    await page.getByRole('dialog',{name:'选择 LoRA',exact:true}).waitFor({state:'detached'});
    assert.equal(writes.length,1);
    assert.deepEqual(Object.keys(writes[0].profiles),['anima']);
    assert.equal(writes[0].profiles.anima.changes[0].project.value.filename,'Anima 旧版.safetensors');
    assert.equal(await page.locator('.project-generation-summary__facts').getByText('Qwen',{exact:true}).isVisible(),true);
    assert.deepEqual(errors,[]);
  } finally {await browser.close();await server.close();}
});
