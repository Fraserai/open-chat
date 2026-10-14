import { cp, mkdtemp, mkdir, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// Exercise the deployment dependency set outside the repository's node_modules.
const root = fileURLToPath(new URL("../../", import.meta.url));
const staged = await mkdtemp(resolve(tmpdir(), "openchat-runtime-"));
try {
  for (const name of ["package.json", "package-lock.json"])
    await cp(resolve(root, "mobile/runtime", name), resolve(staged, name));
  for (const name of ["server", "shared", "tests", "dist"])
    await cp(resolve(root, "mobile", name), resolve(staged, "mobile", name), { recursive: true });
  await mkdir(resolve(staged, "mobile/src"), { recursive: true });
  await cp(resolve(root, "mobile/src/chatStream.ts"), resolve(staged, "mobile/src/chatStream.ts"));
  const adapter = "src/lib/server/endpoints/openai/openAIChatToTextGenerationStream.ts";
  await mkdir(resolve(staged, "src/lib/server/endpoints/openai"), { recursive: true });
  await cp(resolve(root, adapter), resolve(staged, adapter));
  execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts"], { cwd: staged, stdio: "inherit" });
  execFileSync("npm", ["audit", "--omit=dev"], { cwd: staged, stdio: "inherit" });
  const tests = (await readdir(resolve(staged, "mobile/tests")))
    .filter((name) => name.endsWith(".test.mjs")).map((name) => "mobile/tests/" + name);
  execFileSync(process.execPath, ["--test", ...tests], { cwd: staged, stdio: "inherit" });
  console.log("Isolated runtime verification passed. Container build still requires Docker.");
} finally {
  await rm(staged, { recursive: true, force: true });
}
