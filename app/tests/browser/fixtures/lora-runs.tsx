import { createRoot } from "react-dom/client";
import LoraTrainingView from "../../../src/LoraTrainingView";
import { FeedbackProvider } from "../../../src/feedback";
import "../../../src/styles.css";
createRoot(document.getElementById("root")!).render(<FeedbackProvider><LoraTrainingView section="runs" datasetId="dataset-111111111111" onSectionChange={() => {}} /></FeedbackProvider>);
