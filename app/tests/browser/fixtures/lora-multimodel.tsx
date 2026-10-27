import {useState} from "react";
import {createRoot} from "react-dom/client";
import LoraTrainingView from "../../../src/LoraTrainingView";
import {FeedbackProvider} from "../../../src/feedback";
import "../../../src/styles.css";

function Fixture(){
  const [section,setSection]=useState<"datasets"|"tasks"|"runs">(new URLSearchParams(location.search).get("section")==="tasks"?"tasks":"datasets");
  const [datasetId,setDatasetId]=useState("dataset-111111111111");
  return <FeedbackProvider><label>测试项目<select aria-label="测试项目" value={datasetId} onChange={event=>setDatasetId(event.target.value)}><option value="dataset-111111111111">项目一</option><option value="dataset-222222222222">项目二</option></select></label><LoraTrainingView datasetId={datasetId} section={section} onSectionChange={setSection}/></FeedbackProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
