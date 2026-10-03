// 页面编辑工具自己的按需字段帮助；普通分类目录不展开这些细则。
export const pageEditHelp = {
  person_groups: {
    summary:'在指定角色下编辑本页词，自动绑定而不复制继承',
    details:'仅 Anima 页面 prompt.save 的 changes.person_groups，数组项为 {character_id,entries}。角色 ID 取 references.characters；null 表示共同／未绑定区域。entries 完整替换该组本页 person 词，条目省略 character_id，[] 清空该组；不改变角色引用、人数或继承词。不能同时提交 person。原槽位依次替换，其余角色顺序保持，新增项接在该组最后原槽位之后，无原词则追加末尾。重排所有人词才用 person 完整数组。重复提示包含归属与权重，不自动清理。解除角色引用使用 page.editor.read/save 的 characters，带原 save.args（包括 expected_reference_sha256）；会清理各模型明确绑定词与旧来源，保留画外对白、自由词和显式 LoRA。',
    example:{target:{kind:'page',id:'page-001',model_id:'anima'},changes:{person_groups:[{character_id:'alice',entries:[{description:'standing by the window'}]},{character_id:null,entries:[{description:'looking at each other'}]}]}},
  },
  dialogue: {
    summary:'对白模式、说话人、稳定 ID 与数组编辑',
    details:'section:content 的 dialogue 是完整数组，提交时整项替换。speech（说话）和 thought（心理）必须有 speaker，取角色 ID；npc 只可说话，不可 thought。heart（心声）可省略 speaker。narration（旁白）不得有 speaker，可选 position:top/bottom；每页至多一条，最多200字。text 必须非空。已有条目保留其原 id；新增条目省略 id。ID 跟随同一条对白，不按数组索引分配或复用被删条目的 ID。删除已排版对白前先用 lettering.page.read/save 移除对应布局锚点；不要自动清空无关布局。文字页用 body/display_title，dialogue 必须为空。',
    example:{section:'content',changes:{dialogue:[{id:'dialogue-012345abcdef',mode:'speech',speaker:'alice',text:'原对白的新文字'},{mode:'narration',text:'次日',position:'top'}]}},
  },
  fragments: {
    summary:'Anima 本页有序词条与共享词条身份',
    details:'Prompt 统一用 prompt.read/save。Anima 页面 document 按 population/person/setting/camera/avoid 分组，不含 models 外壳。population 仅人数 tag 和 solo/no_humans；普通词严禁写入。person 是人物外观、姿态、身体、动作和关系；属于具体角色的词必须带 character_id，取 prompt.read.references.characters；共同关系或匿名人物才保持未绑定。setting 是环境物体光线，camera 是镜头，avoid 为负向。词条使用 tag 或 description 二选一，可带 weight、enabled；人物按读取结构保留 character_id/role。本页词条不带 id，数组直接表达增删改排序。角色／场景共享词保留原 id，新增省略，由服务端生成；不得自造或跨基础／子设定复制 id。数组完整替换并保留未修改项，不是字符串数组，不保存词库说明对象。不要重复拷贝继承词；继承调整用 inheritance。',
    example:{target:{kind:'page',id:'page-001',model_id:'anima'},changes:{person:[{character_id:'alice',description:'standing by the window'},{character_id:'bob',tag:'smile'},{description:'looking at each other'}]}},
  },
  inheritance: {
    summary:'Anima 继承来源、调整键与恢复继承',
    details:'先 prompt.sources 查询完整来源和词条 key。页面 inheritance 的来源为 character:<角色ID>:<子设定ID> 或 scene:<场景ID>:<子设定ID>，必须对应最终引用；内部 key 为 identity:token-… 或 variant:token-…，不能从原词或顺序猜。子设定只用 identity_overrides 调整基础，key为identity:token-…。值允许 enabled（布尔）与 weight（0.2–10）。字段缺失才继承；显式设置即使等于上游也保留，上游改字仍关联同一条。null删除一个字段恢复该字段，整个key置null恢复整条；不删除上游词。已有失效覆盖可原样保留或明确清理，不能新增无效key。新增来源先读source_versions，合入原保存参数。',
    example:{target:{kind:'page',id:'page-001',model_id:'anima'},changes:{inheritance:{'scene:study:default':{'identity:token-012345abcdef':{enabled:false},'variant:token-fedcba543210':{weight:1.2}}}}},
    restore:{changes:{inheritance:{'scene:study:default':{'identity:token-012345abcdef':{enabled:null}}}}},
  },
  qwen: {
    summary:'Qwen 整段文字覆盖及恢复继承',
    details:'prompt.read 指定 model_id:qwen，document 不含 models 外壳。base范围只含prompt_name；variant为text/reference_images。页面text_overrides/reference_overrides用prompt.sources返回的来源；文字整段覆盖，不用Anima词条格式。覆盖键设null恢复继承，不回写只读展开结果。standalone只用本页全文和附图；改为settings之前先读取所需来源及source_versions。其他模型分支始终保留。',
  },
};
