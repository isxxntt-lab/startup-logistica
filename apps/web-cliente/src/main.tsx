import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TrackingPage } from "./page";
import "./style.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Falta #root");
}

createRoot(root).render(
  <StrictMode>
    <TrackingPage />
  </StrictMode>,
);
