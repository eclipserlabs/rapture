// Mandatory preflight for EVERY subject run, calibration and probe alike.
// A failure aborts the run and the run does not count.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "./cases.mjs";

const ISO = join(REPO, "experiments", "reproducer-v4", "isolation");
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", timeout: 120000, ...opts });
const checks = [];
const check = (name, pass, detail) => checks.push({ check: name, pass: !!pass, detail: String(detail).slice(0, 300) });

// 0. Reassert the Colima bridge INPUT protection (idempotent).
const up = sh("bash", [join(ISO, "net-up.sh")]);
check("net_up_reasserted", up.status === 0, (up.stdout + up.stderr).trim().split("\n").slice(-2).join(" | "));

// A throwaway probe container on the subject network. The real subject
// container is started only after every check below passes.
const P = "v4-preflight";
sh("docker", ["rm", "-f", P]);
const started = sh("docker", ["run", "-d", "--name", P, "--network", "v4-subject-net",
                              "v4-subject-image", "sleep", "120"]);
if (started.status !== 0) {
  console.log(JSON.stringify({ schema: "v4-probe-preflight-1", preflight_pass: false,
    checks: [{ check: "probe_container_start", pass: false, detail: started.stderr.slice(0, 300) }] }, null, 2));
  process.exit(1);
}
const inP = (script) => sh("docker", ["exec", P, "bash", "-lc", script]);

// 1. no default route
const route = inP("ip route show default");
check("subject_no_default_route", route.stdout.trim() === "", `route=${JSON.stringify(route.stdout.trim())}`);

// 2. Colima VM SSH path filtered
const ssh = inP("timeout 4 nc -z -w 3 10.83.0.1 22 && echo OPEN || echo FILTERED");
check("vm_ssh_filtered", ssh.stdout.includes("FILTERED"), ssh.stdout.trim());

// 3. proxy reachable
const proxy = inP("timeout 4 nc -z -w 3 10.83.0.10 3128 && echo OPEN || echo UNREACHABLE");
check("proxy_reachable", proxy.stdout.includes("OPEN"), proxy.stdout.trim());

// 4. exactly one network attachment, and it is the internal one
const nets = sh("docker", ["inspect", P, "--format", "{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}"])
  .stdout.trim().split(/\s+/).filter(Boolean);
check("single_internal_network_attachment", nets.length === 1 && nets[0] === "v4-subject-net", nets.join(","));

// 5. no general egress (kernel level, no DNS and no proxy involved)
const egress = inP(`timeout 8 node -e 'const n=require("net");const s=n.connect(443,"20.205.243.166",()=>{console.log("REACHABLE");process.exit(0)});s.setTimeout(6000,()=>{console.log("TIMEOUT");process.exit(1)});s.on("error",e=>{console.log(e.code);process.exit(1)})'`);
check("no_direct_egress", /ENETUNREACH|EHOSTUNREACH/.test(egress.stdout), egress.stdout.trim());

sh("docker", ["rm", "-f", P]);

// 6. only the minimal provider auth exists on the host side of the mount
let providers = null;
try { providers = Object.keys(JSON.parse(readFileSync(join(ISO, "subject-auth", "auth.json"), "utf8"))).sort(); }
catch (e) { providers = [`UNREADABLE ${e.message}`]; }
check("minimal_provider_auth_only",
      providers.length === 1 && providers[0] === "opencode", JSON.stringify(providers));

// 7. nothing global inherited — asserted on what the run will actually mount
const mountArgs = (process.argv.slice(2).join(" ").match(/--mounts\s+(.*)$/) || [null, ""])[1];
const forbiddenMount = /\.config\/opencode|\.ssh|\.gitconfig|\.git-credentials|\/rapture\/rapture(:|\s|$)/;
check("no_global_config_or_repo_mounted", !forbiddenMount.test(mountArgs), mountArgs || "(none supplied)");

const pass = checks.every((c) => c.pass);
console.log(JSON.stringify({ schema: "v4-probe-preflight-1", at: new Date().toISOString(),
                             checks, preflight_pass: pass }, null, 2));
process.exit(pass ? 0 : 1);
