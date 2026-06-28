// Local runner: ships vps-smoke-inline.mjs to the VPS, starts a one-off unauth
// fmp server on port 4099 (reusing the production .env FMP_API_KEY via dotenv),
// runs the smoke against it, captures the JSON result, and tears the temp
// server down by PORT (never pkill -f tsx). Writes vps-execute-smoke.json.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = "ubuntu@62.72.22.174";
const REMOTE_DIR = "/home/ubuntu/mcp-servers/fmp-contributor";
const INLINE_LOCAL = path.resolve(__dirname, "vps-smoke-inline.mjs");
const INLINE_REMOTE = "/tmp/fmp-smoke-inline.mjs";
const OUTPUT = path.resolve(__dirname, "vps-execute-smoke.json");
const PORT = 4099;

function ssh(cmd, opts = {}) {
  return execFileSync("ssh", ["-o", "ConnectTimeout=15", "-o", "StrictHostKeyChecking=no", HOST, cmd], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

function scp(local, remote) {
  execFileSync("scp", ["-o", "ConnectTimeout=15", "-o", "StrictHostKeyChecking=no", local, `${HOST}:${remote}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// Remote bash wrapper: free port, start temp server, wait for health, run smoke, kill by port.
const remoteBash = `set -e
cd ${REMOTE_DIR}
p=$(ss -ltnp 2>/dev/null | grep ":${PORT} " | grep -oE "pid=[0-9]+" | head -1 | cut -d= -f2); [ -n "$p" ] && kill -9 "$p" 2>/dev/null || true
FMP_ALLOW_UNAUTH_MCP=true PORT=${PORT} nohup npx tsx server.ts > /tmp/fmp-smoke.log 2>&1 &
echo "temp server pid $!"
HEALTH=""
for i in $(seq 1 40); do
  HEALTH=$(curl -s http://127.0.0.1:${PORT}/health 2>/dev/null || true)
  if echo "$HEALTH" | grep -q '"status":"ok"'; then echo "health ok after \${i}s"; break; fi
  sleep 1
done
echo "health: $HEALTH"
node ${INLINE_REMOTE} 2>/tmp/fmp-smoke-stderr.log
SMOKE_RC=$?
p=$(ss -ltnp 2>/dev/null | grep ":${PORT} " | grep -oE "pid=[0-9]+" | head -1 | cut -d= -f2); [ -n "$p" ] && kill -9 "$p" 2>/dev/null || true
echo "temp server killed"
exit 0
`;

function main() {
  console.log("Shipping smoke script to VPS...");
  scp(INLINE_LOCAL, INLINE_REMOTE);
  console.log("Starting temp unauth fmp server on port", PORT, "and smoking 27 methods...");
  let out = "";
  let err = "";
  try {
    out = execFileSync("ssh", ["-o", "ConnectTimeout=15", "-o", "StrictHostKeyChecking=no", HOST, "bash -s"], {
      encoding: "utf8",
      input: remoteBash,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (e) {
    out = e.stdout ?? "";
    err = e.stderr ?? e.message;
    console.error("SSH run error:", String(err).slice(0, 500));
  }

  // The smoke script prints one JSON line to stdout; find it.
  const lines = String(out).split(/\r?\n/);
  let smokeJson = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{") && trimmed.includes("executeValidation")) {
      try { smokeJson = JSON.parse(trimmed); break; } catch { /* keep scanning */ }
    }
  }
  // Surface remote stderr (per-method PASS/FAIL lines) for diagnostics.
  try {
    const remoteErr = ssh("cat /tmp/fmp-smoke-stderr.log 2>/dev/null || true");
    if (remoteErr) console.log("--- remote smoke stderr ---\n" + remoteErr);
  } catch { /* ignore */ }
  try {
    const remoteLog = ssh("tail -20 /tmp/fmp-smoke.log 2>/dev/null || true");
    if (remoteLog) console.log("--- /tmp/fmp-smoke.log tail ---\n" + remoteLog);
  } catch { /* ignore */ }

  if (!smokeJson) {
    console.error("Could not parse smoke JSON from SSH stdout. Raw stdout tail:\n" + String(out).slice(-1200));
    smokeJson = { executeValidation: { discoveredMethodCount: 0, passedMethodCount: 0, failedMethodCount: 0, methods: [], fatal: "no parseable smoke JSON" }, externalAccuracyCheck: { status: "FAIL", notes: ["no parseable smoke JSON"] } };
  }
  writeFileSync(OUTPUT, JSON.stringify(smokeJson, null, 2) + "\n", "utf8");
  const ev = smokeJson.executeValidation ?? {};
  console.log(`\nExecute smoke: ${ev.passedMethodCount ?? 0}/${ev.discoveredMethodCount ?? 0} methods passed, ${ev.failedMethodCount ?? 0} failed.`);
  console.log(`Accuracy check: ${smokeJson.externalAccuracyCheck?.status ?? "?"}`);
  if (Array.isArray(ev.methods)) {
    const failed = ev.methods.filter((m) => m.status !== "pass");
    if (failed.length > 0) {
      console.log("Failed methods:");
      for (const m of failed) console.log(`  - ${m.methodName}: ${m.error || "(no error msg)"}`);
    }
  }
  console.log(`Saved ${OUTPUT}`);
}

main();
