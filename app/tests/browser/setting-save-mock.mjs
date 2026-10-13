// 浏览器只验证草稿与交互；事实验证和原子性由 setting-save.test 覆盖。
export async function mockSettingSave(page, writes, {delay=0}={}) {
  await page.route('**/workbench/setting-save', async route => {
    const input=route.request().postDataJSON();writes.push(input);
    const current=JSON.parse(await page.locator('#setting-state').textContent());
    const {model_id:model,scope,variant_id:oldId}=input.target;
    const setting=structuredClone(current);
    if(input.profile)Object.assign(setting,input.profile.value);
    const id=input.variant?.value.id ?? oldId;
    if(input.variant)setting.visual.variants=setting.visual.variants.map(v=>v.id===oldId?input.variant.value:v);
    if(scope==='base' && input.prompt)Object.assign(setting.prompt,input.prompt);
    if(scope==='variant') {
      setting.prompt.variants[id]=input.prompt ?? setting.prompt.variants[oldId];
      if(id!==oldId)delete setting.prompt.variants[oldId];
    }
    setting.profile_sha256='profile-'+writes.length;setting.visual_sha256='visual-'+writes.length;setting.prompt_sha256='prompt-'+writes.length;
    const version=setting.prompt_scope_versions[model];
    if(scope==='base')version.base='saved-'+writes.length;
    else {version.variants[id]='saved-'+writes.length;if(id!==oldId)delete version.variants[oldId];}
    setting.model_prompts={models:{[model]:setting.prompt}};
    if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
    await route.fulfill({json:{setting,setting_id:scope==='base'?'profile':id}});
  });
}
