import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App, logoutAccount } from "./App";
import { startWalletHost } from "./protocol";
import "./styles.css";

startWalletHost({ logout: logoutAccount });

const root = document.getElementById("root");
if (!root) throw new Error("Nanocodex Connect root element is missing");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
