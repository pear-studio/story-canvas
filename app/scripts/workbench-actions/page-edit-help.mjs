// 页面编辑工具自己的按需字段帮助；普通分类目录不展开这些细则。
export const pageEditHelp = {
  dialogue: {
    summary:'对白模式、说话人、稳定 ID 与数组编辑',
    details:'section:content 的 dialogue 是完整数组，提交时整项替换。speech（说话）和 thought（心理）必须有 speaker，取角色 ID；npc 只可说话，不可 thought。heart（心声）可省略 speaker。narration（旁白）不得有 speaker，可选 position:top/bottom；每页至多一条，最多200字。text 必须非空。已有条目保留其原 id；新增条目省略 id。ID 跟随同一条对白，不按数组索引分配或复用被删条目的 ID。删除已排版对白前先用 lettering.page.read/save 移除对应布局锚点；不要自动清空无关布局。文字页用 body/display_title，dialogue 必须为空。',
    example:{section:'content',changes:{dialogue:[{id:'dialogue-012345abcdef',mode:'speech',speaker:'alice',text:'原对白的新文字'},{mode:'narration',text:'次日',position:'top'}]}},
  },
  fragments: {
    summary:'Anima 本页片段字段和 ID 的增删改',
    details:'section:prompt 的 models.anima 按 population/person/setting/camera/avoid 分组。population 仅用于人数 tag 和 solo/no_humans；普通词严禁写入。person 是人物外观、姿态、身体、动作和关系，可不带 character_id，表示未绑定词条，不需要创建其他分类。setting 为环境物体光线，camera 为镜头，avoid 为负向。片段使用 tag 或 description 二选一，不能把两个字段留在同一片段中；可带 weight、enabled，人物片段按读取结构保留 character_id/role。已有片段保留自身 id，新增省略 id 由服务端生成；换顺序时 ID 跟随片段，不能按索引转给另一词条。数组整项替换，保留未修改条目。Prompt 不是字符串数组，不把词库返回的说明对象直接保存。不要把重复的继承词拷成本页片段；改继承词用 inheritance。切换 tag/description 时数组中的新对象只留所需字段。',
    example:{section:'prompt',changes:{models:{anima:{camera:[{description:'wide shot'}]}}}},
  },
  inheritance: {
    summary:'Anima 继承来源、调整键与恢复继承',
    details:'只用于 models.anima.inheritance。来源键为 character:<角色ID>:<子设定ID> 或 scene:<场景ID>:<子设定ID>，必须是当前页面引用。词条键取原 tag/description：转小写，下划线换空格，合并空白并去首尾空白；avoid 词条加 negative: 前缀。值只允许 enabled（布尔）与 weight（0.2–10）。设定层 identity_overrides/identity_disabled 不是页面字段。局部保存中将某个调整键设为 null 即恢复继承；不删除上游词条，也不复制上游全文。需要确认来源与实际原词时用 prompt.context；不从最终拼接的 Prompt 反推键。',
    example:{section:'prompt',changes:{models:{anima:{inheritance:{'scene:study:default':{day:{enabled:false},'negative:blurry':{weight:1.2}}}}}}},
    restore:{section:'prompt',changes:{models:{anima:{inheritance:{'scene:study:default':{day:null}}}}}},
  },
  qwen: {
    summary:'Qwen 整段文字覆盖及恢复继承',
    details:'按读取结果编辑 models.qwen；text_overrides/reference_overrides 使用读取或 prompt.context 返回的来源键。文字是整段覆盖，不能按 Anima 词条格式填写。局部保存中将对应覆盖键设 null 恢复继承；不要回写只读展开结果。保留其他模型分支。',
  },
};
