/** Shared constants, logging and worker launcher for the corporation scripts.
 * Pure at module top level: no ns.corporation.* calls except those documented as 0 GB. */

export const CORP_LOG_PORT = 3003;
export const CORPORATION_NAME = "Erebos";
export const AGRI_NAME = "Dark Soil";
export const CHEM_NAME = "Black Salt";
export const TOB_NAME = "Ebon Stick";
export const EXPORT_STRING = "(IPROD+IINV/10)*(-1)";
export const BOOST_MATERIALS = ["AI Cores", "Hardware", "Real Estate", "Robots"]; // FIXED ORDER used by every optimizer array
export const BOOST_SIZES = [0.1, 0.06, 0.005, 0.5]; // same order
export const JOBS = {
  ops: "Operations",
  eng: "Engineer",
  biz: "Business",
  mgmt: "Management",
  rnd: "Research & Development",
  intern: "Intern",
  none: "Unassigned",
};
export const STATE_FILE = "/Temp/corp-state.txt"; // written by T04, read by daemon
export const BN_FILE = "/Temp/corp-bn.txt"; // written by T08
export const OFFER_PREP_FILE = "/Temp/corp-offer-prep.txt"; // "1" while T14 is switching offices to the profit setup before accepting an offer; T19 must not touch the product division's office jobs while it is "1"
export const LIFECYCLE_LOG = "corp.lifecycle.log.txt"; // appended by the daemon (T07)

export const getCities = (ns) => Object.values(ns.enums.CityName);

/** Single writer for worker log lines: prints locally and sends "worker|LEVEL|message" to the daemon's port.
 * @param {NS} ns @param {string} message @param {"INFO"|"WARN"|"ERROR"|"MILESTONE"} level **/
export function corpLog(ns, message, level = "INFO") {
  const worker = ns.getScriptName().split("/").pop().replace(/\.js$/, "");
  ns.print(`${level}: ${message}`);
  try {
    ns.getPortHandle(CORP_LOG_PORT).write(`${worker}|${level}|${message}`);
  } catch {}
}

/** Daemon side: split a port line into its parts. Splits on the first two "|" only, so the message keeps any "|".
 * @param {string} line **/
export function parseLogLine(line) {
  const first = line.indexOf("|");
  const second = first < 0 ? -1 : line.indexOf("|", first + 1);
  if (second < 0) return { worker: "", level: "INFO", message: line };
  return { worker: line.slice(0, first), level: line.slice(first + 1, second), message: line.slice(second + 1) };
}

/** Launch a worker script on home, optionally waiting for it to finish.
 * @param {NS} ns @param {string} script @param {(string|number|boolean)[]} args @param {{wait?: boolean, threads?: number}} opts **/
export async function runWorker(ns, script, args = [], { wait = true, threads = 1 } = {}) {
  if (!ns.fileExists(script)) {
    corpLog(ns, `worker ${script} not installed yet`, "WARN");
    return { ok: false, pid: 0, reason: "missing" };
  }
  const needed = ns.getScriptRam(script, "home") * threads;
  const free = ns.getServerMaxRam("home") - ns.getServerUsedRam("home");
  if (needed > free) {
    corpLog(
      ns,
      `not enough home RAM for ${script}: needs ${needed.toFixed(2)} GB, free ${free.toFixed(2)} GB`,
      "ERROR",
    );
    return { ok: false, pid: 0, reason: "ram" };
  }
  const pid = ns.run(script, threads, ...args);
  if (pid === 0) return { ok: false, pid: 0, reason: "launch" };
  if (wait) while (ns.isRunning(pid)) await ns.sleep(200);
  return { ok: true, pid };
}

/** Self-check for the pure parts. Run with node: see report. Throws on failure. **/
export function selfCheck() {
  const p = parseLogLine("phase-round1|MILESTONE|Accepted offer 551.9b");
  if (!(p.worker === "phase-round1" && p.level === "MILESTONE" && p.message === "Accepted offer 551.9b"))
    throw new Error("parseLogLine basic");
  const q = parseLogLine("w|ERROR|a|b|c");
  if (!(q.worker === "w" && q.level === "ERROR" && q.message === "a|b|c"))
    throw new Error("parseLogLine pipes in message");
  if (CORP_LOG_PORT !== 3003) throw new Error("port");
  return true;
}
