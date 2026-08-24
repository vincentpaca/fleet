// Launches a runner through the real ProcessProvider, prints the handle, and
// exits immediately — a daemon that died right after launch (#123). The child
// is unref'd by the provider and survives; the exit handler registered in this
// process dies with it, which is exactly the orphan recover() must settle.
//
// argv: <home> <workspaceRoot> <runnerPath> <jobId>
import { ProcessProvider } from "../src/providers/process.ts";

const [home, workspaceRoot, runnerPath, jobId] = process.argv.slice(2);
const provider = new ProcessProvider({ home, workspaceRoot, runnerPath });
const { handle } = await provider.launch({
  jobId,
  daemonUrl: "http://127.0.0.1:1",
  runnerToken: "tok-0123456789abcdef",
  env: {},
  sync: {},
  manifest: { version: 1 },
  workOrder: { mode: "implement", target: "APP-123", finish: "implemented" },
});
console.log(handle);
process.exit(0);
