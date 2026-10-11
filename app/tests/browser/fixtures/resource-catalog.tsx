import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import GlobalModelsView, { type GlobalResources } from "../../../src/GlobalModelsView";
import { loraResourceItem } from "../../../src/global-resource-catalog";
import { ResourcePicker } from "../../../src/ResourceCatalog";
import { FeedbackProvider } from "../../../src/feedback";
import "../../../src/styles.css";

function Fixture() {
  const [resources, setResources] = useState<GlobalResources | null>(null);
  const [picker, setPicker] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => { void fetch("/api/resources").then(response => response.json()).then(setResources); }, []);
  return <main style={{ padding: 16 }}>
    <button onClick={() => setPicker(value => !value)}>{picker ? "打开总览" : "打开选择器"}</button>
    {picker && resources ? <ResourcePicker items={resources.models.map(loraResourceItem)} selection={{ ids: selected, onChange: setSelected }} /> : <GlobalModelsView resources={resources} kind="lora" />}
    <output aria-label="已选资源 ID">{selected.join(",")}</output>
  </main>;
}
createRoot(document.getElementById("root")!).render(<FeedbackProvider><Fixture /></FeedbackProvider>);
