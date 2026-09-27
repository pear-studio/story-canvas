// 编辑视图不截断正文；草稿保留原样，只压缩只读上下文的重复表示。
const present = value => value !== undefined && value !== null && value !== ''
  && (typeof value !== 'object' || Object.keys(value).length > 0);

function inheritedPrompt(prompt) {
  return Object.fromEntries(Object.entries(prompt).filter(([, words]) => words.length).map(([category, words]) => [
    category, words.map(word => {
      const text = word.tag ?? word.description ?? word.prompt_text ?? '';
      const weight = word.weight;
      return word.enabled === false || (weight !== undefined && weight !== 1)
        ? {text, ...(weight !== undefined && weight !== 1 ? {weight} : {}), ...(word.enabled === false ? {enabled:false} : {})}
        : text;
    }),
  ]));
}

export function editingContext(context) {
  const references = Object.fromEntries((context.references ?? []).map(ref => [ref.source, {
    ...(ref.prompt_name && ref.prompt_name !== ref.id ? {name:ref.prompt_name} : {}),
    ...(ref.inherited_prompt ? {inherited:inheritedPrompt(ref.inherited_prompt)} : {text:ref.current_text ?? ''}),
    ...(present(ref.reference_images) ? {images:ref.reference_images, selected:ref.selected_image_ids ?? []} : {}),
  }]));
  const final = context.final === null ? null : Object.fromEntries(
    ['positive','negative','images'].filter(key => present(context.final?.[key])).map(key => [key,context.final[key]]),
  );
  const audit = Object.fromEntries(Object.entries(context.audit ?? {}).filter(([key, value]) =>
    ['errors','warnings','diagnostics'].includes(key) && present(value)));
  return {
    status:context.status, model_id:context.model_id,
    ...(present(context.render) ? {render:context.render} : {}),
    ...(present(references) ? {references} : {}),
    final,
    ...(present(audit) ? {audit} : {}),
    ...(present(context.diagnostics) ? {diagnostics:context.diagnostics} : {}),
  };
}
