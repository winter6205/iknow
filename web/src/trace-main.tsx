import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TracePanel } from "./components/TracePanel";
import "./styles/global.css";

const el = document.getElementById("root");
if (!el) {
  throw new Error("#root element missing");
}

createRoot(el).render(
  <StrictMode>
    <TracePanel />
  </StrictMode>
);
