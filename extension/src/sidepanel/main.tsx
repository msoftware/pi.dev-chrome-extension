import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// No StrictMode: the port to the service worker must not be opened and closed twice (closing a panel stops the agent).
createRoot(document.getElementById("root")!).render(<App />);
