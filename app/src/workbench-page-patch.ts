import { pageKeyId } from "./page-key.ts";
import type { ProjectWorkbenchView, WorkbenchPage } from "./project-workbench-client";

// layout_sha256 是整份 dialogue-layouts.json 的指纹，任何页面保存后都须同步。
export function replaceWorkbenchPage(view: ProjectWorkbenchView, target: WorkbenchPage, patch: Partial<WorkbenchPage>): ProjectWorkbenchView {
  const replace = (page: WorkbenchPage) => {
    const patched = pageKeyId(page.page_key) === pageKeyId(target.page_key) ? { ...page, ...patch } : page;
    return patch.layout_sha256 ? { ...patched, layout_sha256: patch.layout_sha256 } : patched;
  };
  return {
    ...view,
    outline: { ...view.outline, chapters: view.outline.chapters.map(chapter => ({ ...chapter,
      sequences: chapter.sequences.map(sequence => ({ ...sequence, pages: sequence.pages.map(replace) })),
    })) },
    characters: view.characters.map(character => ({ ...character, pages: character.pages.map(replace) })),
    ...(view.scenes ? { scenes: { ...view.scenes, scenes: view.scenes.scenes.map(scene => ({ ...scene, pages: scene.pages.map(replace) })) } } : {}),
    orphan_pages: (view.orphan_pages ?? []).map(replace),
    ...(view.pages ? { pages: view.pages.map(replace) } : {}),
  };
}
