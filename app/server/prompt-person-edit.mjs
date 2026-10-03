import {ApiError} from './http-support.mjs';

// 编辑投影，不引入第二份存储。原有槽位依次替换，其他角色和未绑定词顺序不变。
export function applyPersonGroups(person, groups, references) {
  const fail=message=>{throw new ApiError(400,'invalid_person_groups',[message]);};
  if (!Array.isArray(groups) || !groups.length) fail('person_groups 必须是非空数组');
  const ids=new Set(references.map(ref=>ref.character_id)),seen=new Set();
  let result=structuredClone(person);
  for (const group of groups) {
    if (!group || typeof group!=='object' || Object.keys(group).some(key=>!['character_id','entries'].includes(key)) || !Object.hasOwn(group,'character_id') || !Array.isArray(group.entries)) fail('每组为 {character_id,entries}；null 表示未绑定');
    const id=group.character_id;
    if (id!==null && !ids.has(id)) fail('character_id 必须来自 references.characters；未绑定用 null');
    if (seen.has(id)) fail('同一组不可重复');seen.add(id);
    const entries=group.entries.map(entry=>{
      if (!entry || typeof entry!=='object' || Array.isArray(entry) || Object.hasOwn(entry,'character_id')) fail('组内条目省略 character_id，由组目标提供');
      return {...entry,...(id===null?{}:{character_id:id})};
    });
    const belongs=entry=>(entry.character_id ?? null)===id;
    const last=result.findLastIndex(belongs);let index=0;
    result=result.flatMap((entry,position)=>{
      if (!belongs(entry)) return [entry];
      const replacement=index<entries.length?[entries[index++]]:[];
      if (position===last) replacement.push(...entries.slice(index));
      return replacement;
    });
    if (last<0) result.push(...entries);
  }
  return result;
}
