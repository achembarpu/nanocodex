import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { startWalletHost } from "./protocol";
import "./styles.css";

startWalletHost();

const root = document.getElementById("root");
if (!root) throw new Error("Nanocodex Connect root element is missing");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
