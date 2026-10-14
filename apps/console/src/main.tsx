import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { bootstrapToken } from "@/client/auth";
import { readRuntime } from "@/client/create-client";
import { App, readUi } from "./app";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

const runtime = readRuntime(window.location.search);
// Live mode needs the bearer secret: from `#token=...`, else this tab's sessionStorage, else a prompt.
if (!runtime.mock) bootstrapToken();

createRoot(root).render(
	<StrictMode>
		<App runtime={runtime} ui={readUi(window.location.search)} />
	</StrictMode>,
);
