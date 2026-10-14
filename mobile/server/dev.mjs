import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const children = [];
let stopping = false;
function stop(code = 0) {
	if (stopping) return;
	stopping = true;
	for (const child of children) child.kill("SIGTERM");
	process.exitCode = code;
}
function run(args, env = {}) {
	const child = spawn(process.execPath, args, {
		cwd,
		env: { ...process.env, ...env },
		stdio: "inherit",
	});
	children.push(child);
	child.on("error", (error) => {
		console.error(error.message);
		stop(1);
	});
	child.on("exit", (code) => {
		if (!stopping) stop(code ?? 1);
	});
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
run(["--watch", "--env-file-if-exists=.env", "server/index.mjs"], {
	APP_ORIGIN: "http://127.0.0.1:5174",
	PORT: "3001",
	HOST: "127.0.0.1",
	NODE_ENV: "development",
});
run(["../node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--strictPort"]);
