import { createRoot } from "react-dom/client";
import ProjectGenerationSettingsView from "../../../src/ProjectGenerationSettingsView";
import { FeedbackProvider } from "../../../src/feedback";
import "../../../src/styles.css";
createRoot(document.getElementById("root")!).render(<FeedbackProvider><ProjectGenerationSettingsView projectId="test" project={{id:"test",title:"选择器测试",canvas:"2:3",default_render_profile:"qwen"}} busy={false} onSaveProject={async () => {}} /></FeedbackProvider>);
