import { useEffect, useRef, useState } from 'react';
import { responseJson } from './api-response';
import { mutateFacts, readFacts } from './project-write-client';

type Material = { file: string; title: string; available: boolean; url: string | null };

export function ReferenceImageEditor({ projectId, value, disabled, onChange }: {
  projectId: string; value?: string; disabled?: boolean; onChange: (file?: string) => void;
}) {
  const [materials, setMaterials] = useState<Material[]>([]);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [uploading, setUploading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let current = true;
    setMaterials([]);
    setError('');
    void readFacts(`/api/projects/${encodeURIComponent(projectId)}/materials`)
      .then(responseJson<{ materials: Material[] }>).then(result => {
        if (current) setMaterials(result.materials.filter(item => item.available && /\.(png|jpe?g|webp)$/i.test(item.file)));
      }).catch(error => { if (current) setError(error instanceof Error ? error.message : String(error)); });
    return () => { current = false; };
  }, [projectId, refresh]);
  const selected = materials.find(item => item.file === value);
  async function upload(file: File) {
    setUploading(true); setError('');
    try {
      if (file.size > 32 * 1024 * 1024 || !/\.(png|jpe?g|webp)$/i.test(file.name)) throw new Error('请选择不超过 32MB 的 PNG、JPEG 或 WebP 图片');
      const content = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error('无法读取图片'));
        reader.readAsDataURL(file);
      });
      const filename = `reference-${crypto.randomUUID()}.${file.name.split('.').at(-1)!.toLowerCase()}`;
      if (!mounted.current) return;
      await responseJson(await mutateFacts(`/api/projects/${encodeURIComponent(projectId)}/materials/item`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: filename, title: file.name, encoding: 'base64', content }),
      }));
      if (mounted.current) { setRefresh(value => value + 1); onChange(filename); }
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (mounted.current) setUploading(false); }
  }
  return <div className="character-reference-editor reference-image-editor">
    {selected?.url && <img src={selected.url} alt={selected.title} />}
    <select aria-label="页面参考图" disabled={disabled || uploading} value={value ?? ''} onChange={event => onChange(event.target.value || undefined)}>
      <option value="">无参考图</option>
      {value && !selected && <option value={value}>不可用：{value}</option>}
      {materials.map(item => <option key={item.file} value={item.file}>{item.title}</option>)}
    </select>
    {value && <button type="button" className="button button--quiet" aria-label="移除参考图" disabled={disabled || uploading} onClick={() => onChange()}>移除</button>}
    <button type="button" className="button button--quiet" aria-label="刷新参考材料" disabled={disabled || uploading} onClick={() => setRefresh(value => value + 1)}>刷新</button>
    <button type="button" className="button button--quiet" disabled={disabled || uploading} onClick={() => input.current?.click()}>{uploading ? '正在导入…' : '导入图片'}</button>
    <input ref={input} aria-label="导入参考图" type="file" accept=".png,.jpg,.jpeg,.webp" disabled={disabled || uploading} hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void upload(file); }} />
    {!materials.length && !error && <small>从项目参考材料中选择 PNG、JPEG 或 WebP 图片</small>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
