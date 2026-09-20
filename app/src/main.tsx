import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import StoryWorkbench from "./App";
import { FeedbackProvider } from "./feedback";
import { initializeImagePrivacy } from "./image-privacy.mjs";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("StoryCanvas root element is missing");
}

let imagePrivacyStorage: Storage | null = null;
try { imagePrivacyStorage = window.localStorage; } catch { /* 当前页面仍可切换。 */ }
const initialImagesHidden = initializeImagePrivacy(imagePrivacyStorage, document.documentElement);

createRoot(root).render(
  <StrictMode>
    <FeedbackProvider><StoryWorkbench initialImagesHidden={initialImagesHidden} imagePrivacyStorage={imagePrivacyStorage} /></FeedbackProvider>
  </StrictMode>,
);
