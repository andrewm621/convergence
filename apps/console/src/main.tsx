import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { bootstrapToken } from "@/client/auth";
import { readRuntime } from "@/client/create-client";
import { App, readUi } from "./app";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

const runtime = readRuntime(window.location.search);
// Live mode needs the bearer secret: from `#token=...`, else this tab's sessionStorage, else a prompt. The public read-only view (`?view=public`) never asks for one.
if (!runtime.mock && !runtime.publicView) bootstrapToken();

createRoot(root).render(
	<StrictMode>
		<App runtime={runtime} ui={readUi(window.location.search)} />
	</StrictMode>,
);
