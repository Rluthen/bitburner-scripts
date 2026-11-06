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

/** Expected investment offer for a phase in the CURRENT BitNode. The guide's numbers are BN3, and offers scale
 * with the BitNode's CorporationValuation (guide §17.3 p64), so an unscaled floor refuses every offer a x0.2
 * BitNode (BN6/BN7) can ever produce. `override` (an explicit --offer-expect) is absolute. Pure - checked below.
 * @param {number} base the guide's/reference's BN3 expectation @param {number} offerScale T08's profile.offerScale
 * @param {number|null} override @returns {number} **/
export function scaledOfferExpect(base, offerScale, override) {
  return override == null ? base * (Number(offerScale) || 1) : Number(override);
}

/** Where the BN3 round plan stops working. Guide-writer feedback: "~0.3-0.4 valuation or higher: just follow
 * generic advices. For 0.1-0.2 valuation: use strategy for BN13 ... You need to write your script in a way
 * that it aims for a 'condition', not a number." Below this multiplier the offers are ~1/5 of the guide's
 * numbers while every purchase keeps its BN3 price, so the round plan moves one round later and each offer is
 * taken at whatever amount it reaches. Pure - checked below. **/
export const LOW_OFFER_SCALE = 0.3;

/** @param {number} offerScale T08's profile.offerScale (= CorporationValuation) @returns {"LOW"|"GENERIC"} **/
export function offerMode(offerScale) {
  return Number(offerScale) < LOW_OFFER_SCALE ? "LOW" : "GENERIC";
}

/** T08's BitNode profile out of /Temp/corp-bn.txt (0 GB read). A missing or corrupt file means `{}`, i.e.
 * every caller falls back to its own BN3 default - the same behaviour the phase jobs had before this. **/
export function readBnProfile(ns) {
  try {
    return JSON.parse(ns.read(BN_FILE)) ?? {};
  } catch {
    return {};
  }
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
  if (scaledOfferExpect(340e9, 1, null) !== 340e9) throw new Error("scaledOfferExpect BN3");
  if (Math.abs(scaledOfferExpect(340e9, 0.2, null) - 68e9) > 1) throw new Error("scaledOfferExpect BN6/7");
  if (scaledOfferExpect(340e9, 0.2, 5e11) !== 5e11) throw new Error("scaledOfferExpect explicit --offer-expect");
  if (scaledOfferExpect(11e12, undefined, null) !== 11e12) throw new Error("scaledOfferExpect missing profile");
  if (offerMode(0.2) !== "LOW") throw new Error("offerMode x0.2 (BN6/BN7)");
  if (offerMode(0.001) !== "LOW") throw new Error("offerMode x0.001 (BN13)");
  if (offerMode(0.3) !== "GENERIC") throw new Error("offerMode x0.3 boundary");
  if (offerMode(1) !== "GENERIC") throw new Error("offerMode x1 (BN3)");
  if (offerMode(undefined) !== "GENERIC") throw new Error("offerMode missing profile");
  return true;
}
