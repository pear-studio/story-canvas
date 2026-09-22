import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PromptOverview } from "../../src/PromptOverview";
import { FeedbackProvider } from "../../src/feedback";
import { setProjectWriteRevision } from "../../src/project-write-client";
import { type ProjectWorkbenchView, type WorkbenchPage } from "../../src/project-workbench-client";
import "../../src/styles.css";

const page = (index: number): WorkbenchPage => ({
  kind: "story", page_id: `page-${index}`, page_key: { page_id: `page-${index}` }, title: `页面 ${index}`,
  content_sha256: `content-${index}`, prompt_sha256: `prompt-${index}`, prompt_context_sha256: `context-${index}`, characters: [],
  prompt: { text: index === 1 ? " dim lighting, a sentence with unrecognized words " : `第 ${index} 页的画面描述`, reference_images: [{ id: "ref-11111111-1111-4111-8111-111111111111", file: "reference-11111111.png", title: "参考" }] },
});
function Harness() {
  const [view, setView] = useState<ProjectWorkbenchView>({ version: 6, project: { id: "overview-test", title: "总览测试", canvas: "3:4", default_render_profile: "test", lettering_settings: null, lettering_settings_sha256: null }, characters: [], diagnostics: [], render_capabilities: { candidates: { available: true, counts: [1,3] } }, outline: { synopsis: "", synopsis_sha256: "synopsis", chapters: [{ id: "chapter", title: "章节", summary: "", summary_sha256: "chapter", sequences: Array.from({ length: Number(new URLSearchParams(location.search).get("pages") ?? 4) / 2 }, (_, index) => index + 1).map(i => ({ id: `seq-${i}`, title: `单元 ${i}`, summary: "", summary_sha256: "seq", pages: [page(i*2-1),page(i*2)] })) }] } });
  const [focus, setFocus] = useState({ pageId: "page-1", request: 0 });
  const updatePage = (saved: WorkbenchPage) => setView(current => ({ ...current, outline: { ...current.outline, chapters: current.outline.chapters.map(chapter => ({ ...chapter, sequences: chapter.sequences.map(sequence => ({ ...sequence, pages: sequence.pages.map(p => p.page_id === saved.page_id ? saved : p) })) })) } }));
  return <FeedbackProvider><button onClick={() => setFocus(current => ({ pageId: `page-${new URLSearchParams(location.search).get("pages") ?? 4}`, request: current.request + 1 }))}>导航到单元二末页</button><button onClick={() => { const p = view.outline.chapters[0].sequences[0].pages[0]; updatePage({ ...p, prompt_sha256: "external-change", prompt: { ...p.prompt, text: "外部改写的页面描述" } }); }}>模拟外部更新</button><div style={{ height: 800, width: "100%" }}><PromptOverview projectId="overview-test" view={view} focus={focus} onOpenPage={() => {}} onSaved={updatePage} onTrackedTasks={() => {}} /></div></FeedbackProvider>;
}
setProjectWriteRevision("overview-test", "revision");
createRoot(document.getElementById("root")!).render(<Harness />);
