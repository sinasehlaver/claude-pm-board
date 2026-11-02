import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { DialogHost } from "./dialog.jsx";
import "./app.css";
import "./appearance.css";
import { applyAppearance, loadAppearance } from "./Appearance.jsx";

applyAppearance(loadAppearance());

createRoot(document.getElementById("root")).render(
  <>
    <App />
    <DialogHost />
  </>,
);
