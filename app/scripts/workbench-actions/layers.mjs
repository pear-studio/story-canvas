import {endpoint,projectPath,pageKey} from './http-action.mjs';
import {id} from './navigation.mjs';
import {object,string} from './contract.mjs';
const action=(name,summary,fields,details,required)=>endpoint(summary,'POST',args=>projectPath(args,`workbench/layers/${name}`),fields,{project:true,body:({project_id,...args})=>args,details,...(required?{required}:{})});
const locale={type:'string',enum:['zh','en','ja'],description:'预览语言，默认 zh；多语言素材缺少对应图片时报错，不回退中文'};
export const layerActions={
  'page.layers.read':action('read','读取普通图片页素材布局与保存指纹',{page_key:pageKey},'返回 document 与 sha256；未设置素材时返回空布局。契约见 page-layers.schema.json。仅支持普通静态图片页，不含分镜内部页。'),
  'page.layers.save':action('save','保存普通图片页素材布局',{page_key:pageKey,document:object('完整素材布局'),expected_sha256:id('read 返回的 sha256')},'最多12层，assets 引用 materials 下的一层图片文件。默认各语言共用 file；素材 multilingual:true 时英文、日文读取 localizations.en/ja.file，中文仍用 file。关闭开关保留语言引用，缺译允许保存但阻止对应语言输出。所有语言共用同一 box/crop，自动等比适配，不支持语言独立排版。items 从底到顶排列，box/crop 为画布/原图归一化矩形。显示长边至少为画布短边2%，不得越界，裁剪至少一个原图像素。enabled:false 保留引用和排版但不输出。保存冲突须重读；移除实例不删除素材，包括关闭状态的语言版本均受删除保护。缺失的已有素材可保留保存，启用时阻止输出。布局跨候选共用。'),
  'page.layers.materials':action('materials','列出可用于图片图层的项目素材',{},'返回 materials[]，各项含 asset、title 和 media。选择后默认各语言共用；普通页可在素材布局中手动开启多语言并关联英日图片。',[]),
  'page.layers.import':action('import','导入静态图片为项目素材',{title:string('素材标题'),content:string('图片字节的纯 Base64，不含 data URL 前缀')},'接受静态 PNG、JPEG、WebP，最大32MB。校验并校正方向、保存为透明通道保留的PNG，使用唯一文件名，不覆盖同名素材。立即持久化，取消页面排版也保留。返回 asset、title、media；随后用 page.layers.save 或 page.collage.save 引用。'),
  'page.layers.media':action('media','解析素材布局中的图片与尺寸',{document:object('完整素材布局'),locale},'只读，按 locale 返回 media；缺少语言版本、文件或不是有效静态图片时返回 error。', ['document']),
  'page.layers.inspect':action('inspect','检查指定候选上的素材合成与实际边界',{page_key:pageKey,candidate_id:id('显式候选ID'),document:object('可选未保存素材布局'),locale},'省略 document 使用已保存布局。按 locale 选择素材，返回布局、画布像素尺寸、各层实际显示矩形和 preview（url、absolute_file）。预览包含素材、不包含文字层；文字翻译检查使用 translation.inspect，正式输出使用 finished.output。只写项目 Saved/layer-previews，不改事实。',['page_key','candidate_id']),
};
