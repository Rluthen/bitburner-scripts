/** T07 - corp.js: the CENTRAL DAEMON for the corporation rollout.
 *
 * Watches the corporation once per corp cycle (10 s, 1 s with bonus time), reads game state through
 * Corp/corp-snapshot.js + ns.read, asks the PURE rule module (Corp/corp-rules.js) what is due, starts
 * the missing services + at most ONE spending job, and prints the whole lifecycle into this tail
 * window (workers report over log port CORP_LOG_PORT, drained by drainLog() below between awaits).
 *
 * Statically-referenced corporation APIs (docs figure, NOT measured - both are 0 GB, so the daemon
 * stays small on any home): nextUpdate, hasCorporation. Every other value arrives via the snapshot.
 *
 * Run it:   run corp.js --dry-run    (do this first: it decides and logs, but launches nothing)
 * Then:     run corp.js              (services keep running; spending jobs run one at a time)
 * Options:  --product-city, --mat-ratio, --custom-supply, --improve-every, --dry-run, --pause
 * Stop it:  `kill corp.js`  (services/jobs it started keep running; `kill <name>` each if you want)
 * History:  corp.lifecycle.log.txt (next to this script) holds every printed line after the tail scrolls
 *
 * Workers that do not exist yet are skipped with a WARN; the daemon never exits on a transient problem
 * (missing script, stale snapshot, low RAM). Only --help and a missing Source-File 3 stop it.
 */
import { getConfiguration, getActiveSourceFiles, instanceCount, formatMoney, formatNumberShort } from "./helpers.js";
import { CORP_LOG_PORT, LIFECYCLE_LOG, STATE_FILE, BN_FILE, parseLogLine, runWorker } from "./Corp/corp-lib.js";
import { decide } from "./Corp/corp-rules.js";

// These parameters are meant to let you tweak the script's behaviour from the command line (without altering source code)
const argsSchema = [
    ["product-city", "Sector-12"], // City used for the product (Tobacco) office and products
    ["mat-ratio", 0.8], // % of each warehouse used for boost materials (round 3+ default)
    ["custom-supply", false], // start Corp/corp-supply.js instead of the built-in Smart Supply (T16)
    ["improve-every", 5], // cycles between improve / advert jobs
    ["dry-run", false], // decide and LOG, never launch
    ["pause", false], // keep logging / status but launch nothing
];

const PROFIT_MILESTONES = Array.from({ length: 28 }, (_, i) => 10 ** (9 + 3 * i)); // 1e9 .. 1e90
const SNAPSHOT_FRESH_MS = 30_000; // a snapshot older than this is stale (bonus time can stretch a cycle)

export function autocomplete(data, _) {
    data.flags(argsSchema);
    return [];
}

/** Entry point. @param {NS} ns **/
export async function main(ns) {
    try {
        await runDaemon(ns);
    } catch (err) {
        // The game prints an uncaught throw in the TERMINAL; the tail window (what the player watches) must
        // say why the daemon stopped too, or a death looks like the script silently doing nothing.
        const line = `corp.js stopped: ${err?.message ?? err}`;
        try {
            ns.print(line);
            ns.tprint(line);
            ns.write(LIFECYCLE_LOG, line + "\n", "a");
        } catch {
            // nothing we can do while dying
        }
        throw err;
    }
}

async function runDaemon(ns) {
    const opts = getConfiguration(ns, argsSchema);
    if (!opts) return; // --help or a bad argument (getConfiguration already logged why)
    if ((await instanceCount(ns)) > 1) return; // never two daemons at once
    const sf3 = (await getActiveSourceFiles(ns))[3] ?? 0; // BN3 counts as SF3 access by default
    if (sf3 === 0) {
        ns.tprint("ERROR: corp.js needs Source-File 3 (Corporation). Not unlocked - stopping.");
        return;
    }
    ns.disableLog("ALL");
    ns.ui.openTail();

    // One mutable state object for the whole run, threaded through the helpers below.
    const ctx = {
        cycle: 0, // daemon ticks (2 s ticks before the corporation exists, 1 per corp cycle after)
        phase: "NO_CORP",
        started: Date.now(),
        options: {
            improveEvery: Number(opts["improve-every"]),
            advertShare: 0.2,
            customSupply: !!opts["custom-supply"],
            productCity: String(opts["product-city"]),
            matRatio: Number(opts["mat-ratio"]),
            dryRun: !!opts["dry-run"],
        },
        installed: new Set(), // Corp/*.js present on home, refreshed each cycle
        lastJobCycle: {}, // per-script launch cycle (T06 cadence)
        job: null, // the one job we started: { script, pid }
        launchHistory: [], // { script, cycle, phase } - for the looping-job guard
        halted: false, // set when a job loops; user must restart the daemon
        bnViable: true, // false => observe-only (no jobs)
        runningJob: false,
        runningServices: [],
        paused: !!opts.pause,
        dryRun: !!opts["dry-run"],
        prev: null, // previous snapshot (milestone detection)
        maxProfitMilestone: 0,
        warned: new Set(), // warn-only-once messages
        announced: new Set(), // dry-run / pause "would start" messages
        lastNoteKey: "",
    };
    banner(ns, ctx);

    // No floating log-pump loop: Bitburner kills a script that calls any ns function while an ns.sleep()
    // is pending, so the daemon keeps ONE ns-calling context and drains the port between awaits.
    await startup(ns, ctx); // corp-bn.js once, before the main loop

    for (;;) {
        drainLog(ns, ctx); // everything the workers wrote while we were parked / working
        if (!ns.corporation.hasCorporation()) {
            await tickNoCorp(ns, ctx); // nextUpdate() throws without a corporation - sleep instead
            continue;
        }
        const st = await ns.corporation.nextUpdate(); // 0 GB; resolves with the state that JUST happened
        if (st !== "START") continue; // act once per cycle, in START (guide 18.1 p68)
        ctx.cycle++;
        const state = await readSnapshot(ns, ctx);
        if (!state) continue; // missing / stale snapshot: warn once, skip this cycle
        await runCycle(ns, ctx, state);
    }
}

// ---------------------------------------------------------------------------------------------
// Per-cycle work

/** One corporation cycle: refresh inputs, decide, launch, report. **/
async function runCycle(ns, ctx, state) {
    ctx.installed = new Set(ns.ls("home", "Corp/")); // pick up scripts installed since the last cycle
    ctx.runningJob = trackJob(ns, ctx);
    const plan = decide(state, ctx); // all decisions live in T06
    ctx.phase = plan.phase;
    reportNotes(ns, ctx, plan.notes);
    await reconcileServices(ns, ctx, plan.services);
    await maybeLaunchJob(ns, ctx, plan);
    milestones(ns, ctx, state);
    statusLine(ns, ctx, state, plan);
}

/** No corporation yet: the round-1 job is what CREATES it, so keep ticking until it does. **/
async function tickNoCorp(ns, ctx) {
    await ns.sleep(2000);
    drainLog(ns, ctx); // a pending ns.sleep() blocks every other ns call, so print only after it resolves
    ctx.cycle++;
    ctx.installed = new Set(ns.ls("home", "Corp/"));
    ctx.runningJob = trackJob(ns, ctx);
    await readSnapshot(ns, ctx); // keeps STATE_FILE fresh for the services + warns once if unavailable
    // T06's decide() only offers jobs once a corporation exists (a corp-less state is phase NO_CORP
    // with no job), but the round-1 job is what creates one - so hand it an empty round-1 state.
    const plan = decide(round1StartState(), ctx);
    ctx.phase = plan.phase;
    reportNotes(ns, ctx, plan.notes);
    await maybeLaunchJob(ns, ctx, plan); // services wait until the corporation exists
    if (ctx.cycle === 1 || ctx.cycle % 15 === 0) {
        const what = plan.job ? `launching ${plan.job.script}` : ctx.job ? `${ctx.job.script} running` : "waiting";
        emit(ns, `${stamp()} c${ctx.cycle} [${plan.phase}] no corporation yet - ${what}`);
    }
}

/** The empty round-1 state the daemon feeds decide() before the corporation exists. **/
function round1StartState() {
    return {
        hasCorp: true,
        corp: { funds: 0, revenue: 0, expenses: 0, public: false },
        offer: { funds: 0, round: 1, shares: 0 },
        divisions: {},
        unlocks: {},
        upgrades: {},
    };
}

/** Run the snapshot worker (the ONLY expensive reader, T04) and parse its JSON.
 * Returns null when it is missing, unparseable or older than SNAPSHOT_FRESH_MS. **/
async function readSnapshot(ns, ctx) {
    const res = await launch(ns, ctx, "Corp/corp-snapshot.js", [], true);
    if (!res.ok) return null;
    let snap;
    try {
        snap = JSON.parse(ns.read(STATE_FILE));
    } catch {
        warnOnce(ns, ctx, `could not parse ${STATE_FILE}`);
        return null;
    }
    if (!snap || typeof snap.t !== "number" || Date.now() - snap.t > SNAPSHOT_FRESH_MS) {
        warnOnce(ns, ctx, `${STATE_FILE} is stale - skipping this cycle`);
        return null;
    }
    return snap;
}

/** Is the last-launched job still running? Clears it (and returns false) once it has exited. **/
function trackJob(ns, ctx) {
    if (!ctx.job) return false;
    if (ns.isRunning(ctx.job.pid)) return true;
    ctx.job = null;
    return false;
}

/** Start every desired service that is not already running. Never duplicate an instance. **/
async function reconcileServices(ns, ctx, services) {
    const running = new Set(ns.ps("home").map((p) => p.filename));
    ctx.runningServices = services.map((s) => s.script).filter((s) => running.has(s));

    if (ctx.paused || ctx.dryRun) {
        for (const s of services) announce(ns, ctx, `${ctx.paused ? "PAUSED" : "DRYRUN"} would start`, s.script, s.args);
        return;
    }
    for (const s of services) {
        if (running.has(s.script)) continue;
        const res = await launch(ns, ctx, s.script, s.args, false);
        if (res.ok) logLine(ns, ctx, "INFO", `service ${s.script} started (pid ${res.pid})`);
    }
}

/** Launch at most ONE job: none while one runs, none while paused/dry/observe-only, and none at all
 * after the same job has relaunched 3+ times in 15 cycles without the phase moving on (halted). **/
async function maybeLaunchJob(ns, ctx, plan) {
    if (!ctx.bnViable || ctx.halted || !plan.job) return;
    const job = plan.job;
    if (ctx.paused || ctx.dryRun) {
        announce(ns, ctx, `${ctx.paused ? "PAUSED" : "DRYRUN"} would start`, job.script, job.args);
        return;
    }
    const recent = ctx.launchHistory.filter((h) => h.script === job.script && h.cycle > ctx.cycle - 15);
    if (recent.length >= 3 && recent.every((h) => h.phase === plan.phase)) {
        ctx.halted = true;
        logLine(ns, ctx, "ERROR", `job ${job.script} is looping - pausing launches until restart`);
        ns.tprint(`corp.js: ${job.script} kept relaunching in phase ${plan.phase}; launches halted, restart corp.js to resume.`);
        return;
    }
    const res = await launch(ns, ctx, job.script, job.args, false);
    if (!res.ok) return; // launch already warned (missing script / not enough RAM)
    ctx.job = { script: job.script, pid: res.pid };
    ctx.lastJobCycle[job.script] = ctx.cycle;
    ctx.launchHistory.push({ script: job.script, cycle: ctx.cycle, phase: plan.phase });
    logLine(ns, ctx, "INFO", `started ${job.script}${job.args.length ? " " + job.args.join(" ") : ""} - ${job.reason}`);
}

// ---------------------------------------------------------------------------------------------
// Milestones and status

/** MILESTONE lines, detected by comparing consecutive snapshots. These double as the guide's
 * comparison table (guide 19.4.2 p79: cycle number : profit/offer). Each fires once. **/
function milestones(ns, ctx, state) {
    const prev = ctx.prev;
    if (state.hasCorp && (!prev || !prev.hasCorp)) mile(ns, ctx, `corporation "${state.corp.name}" created`);
    const prevDivs = prev ? Object.keys(prev.divisions ?? {}) : Object.keys(state.divisions ?? {});
    for (const name of Object.keys(state.divisions ?? {}))
        if (!prevDivs.includes(name)) mile(ns, ctx, `division "${name}" created (${state.divisions[name].industry})`);
    if (prev?.offer && state.offer && state.offer.round > prev.offer.round)
        mile(ns, ctx, `accepted investment round ${prev.offer.round} for ${formatMoney(prev.offer.funds)}`);
    if (prev?.corp && state.corp && !prev.corp.public && state.corp.public) mile(ns, ctx, "corporation went public");
    if ((!prev || !anyFinished(prev)) && state.hasCorp) {
        const done = finishedProducts(state);
        if (done.length) mile(ns, ctx, `first product finished: ${done[0]}`);
    }
    const profit = state.corp ? state.corp.profit ?? state.corp.revenue - state.corp.expenses : 0;
    for (const p of PROFIT_MILESTONES)
        if (profit >= p && p > ctx.maxProfitMilestone) {
            ctx.maxProfitMilestone = p;
            mile(ns, ctx, `profit reached ${formatNumberShort(p)}/s (cycle ${ctx.cycle})`);
        }
    ctx.prev = state;
}

const anyFinished = (state) =>
    Object.values(state.divisions ?? {}).some((d) => (d.products ?? []).some((p) => p.developmentProgress >= 100));
const finishedProducts = (state) =>
    Object.values(state.divisions ?? {}).flatMap((d) => (d.products ?? []).filter((p) => p.developmentProgress >= 100).map((p) => p.name));

/** One INFO status line per cycle. **/
function statusLine(ns, ctx, state, plan) {
    const c = state.corp ?? {};
    const profit = c.profit ?? (c.revenue ?? 0) - (c.expenses ?? 0);
    const offer = state.offer && state.offer.funds > 0 ? `offer r${state.offer.round} ${formatMoney(state.offer.funds)}` : "no offer";
    const divs = Object.keys(state.divisions ?? {}).length;
    const svc = ctx.runningServices.length ? ctx.runningServices.map(basename).join(",") : "-";
    const job = ctx.job ? `job=${basename(ctx.job.script)} pid=${ctx.job.pid}` : plan.job ? `job=due(${basename(plan.job.script)})` : "job=-";
    const elapsed = ((Date.now() - ctx.started) / 60000).toFixed(1);
    emit(
        ns,
        `${stamp()} c${ctx.cycle} +${elapsed}m [${plan.phase}] funds ${formatMoney(c.funds ?? 0)} ` +
            `profit ${formatMoney(profit)}/s ${offer} divs ${divs} svc ${svc} ${job}`,
    );
}

/** Print MISSING notes immediately when they change, and remind every 20 cycles (T06 behaviour). **/
function reportNotes(ns, ctx, notes) {
    const key = notes.join("|");
    if (!key) return;
    if (key !== ctx.lastNoteKey) {
        ctx.lastNoteKey = key;
        for (const note of notes) logLine(ns, ctx, "WARN", note);
    } else if (ctx.cycle % 20 === 0) {
        for (const note of notes) logLine(ns, ctx, "WARN", note);
    }
}

// ---------------------------------------------------------------------------------------------
// Startup: the BitNode profile

/** One-shot startup: make sure /Temp/corp-bn.txt exists (T08) so the phase jobs and the offers
 * service can read the BitNode profile. A non-viable BitNode puts the daemon in observe-only mode. **/
async function startup(ns, ctx) {
    logLine(ns, ctx, "INFO", "reading the BitNode profile (Corp/corp-bn.js) ...");
    const res = await launch(ns, ctx, "Corp/corp-bn.js", [], true);
    if (!res.ok) return; // missing / no RAM - launch warned once; the daemon keeps going
    let bn;
    try {
        bn = JSON.parse(ns.read(BN_FILE));
    } catch {
        return warnOnce(ns, ctx, `could not read ${BN_FILE}`);
    }
    logLine(ns, ctx, "INFO", `BitNode profile: ${bn.note ?? JSON.stringify(bn)} - viable=${bn.viable}`);
    if (bn.viable === false) {
        ctx.bnViable = false;
        logLine(ns, ctx, "ERROR", "this BitNode does not allow a viable corporation - observe-only (no jobs)");
    }
}

// ---------------------------------------------------------------------------------------------
// Log drain (workers -> this tail window)

/** Drain the worker log port into this tail window. Called BETWEEN awaits from the main loop only.
 *
 * Bitburner permits exactly ONE pending ns call per script: `netscriptDelay` (ns.sleep) sets the
 * worker's `runningFn`, and any other ns call made while it is set trips the game's concurrency check,
 * which KILLS the script (NetscriptHelpers.tsx checkEnvFlags). So the old floating pump loop - parked on
 * port.nextWrite(), printing the moment a worker logged - got the daemon killed the first time the main
 * chain was sleeping (e.g. while waiting for corp-bn.js). One context, drain on wake.
 *
 * ponytail: the port holds 50 lines (game default) and drops the oldest; a worker burst that outruns a
 * single parked nextUpdate() can lose lines. Drain more often (smaller sleeps) if that ever shows up. **/
function drainLog(ns, ctx) {
    const handle = ns.getPortHandle(CORP_LOG_PORT);
    for (let line; (line = handle.read()) !== "NULL PORT DATA"; ) {
        if (typeof line !== "string") continue;
        const { worker, level, message } = parseLogLine(line);
        const text = `${stamp()} c${ctx.cycle} [${ctx.phase}] ${worker} ${level}: ${message}`;
        ns.print(text);
        append(ns, text);
        if (level === "ERROR") ns.tprint(text);
        if (level === "MILESTONE") ns.toast(message, "success");
    }
}

// ---------------------------------------------------------------------------------------------
// Small helpers

const stamp = () => new Date().toTimeString().slice(0, 8);
const basename = (script) => script.split("/").pop().replace(/\.js$/, "");

/** Launch a worker through runWorker, but warn only ONCE per problem: runWorker logs an ERROR/WARN on
 * every call, which a per-cycle launcher would turn into a toast every 10 s on a small home. **/
async function launch(ns, ctx, script, args, wait) {
    if (!ns.fileExists(script)) {
        warnOnce(ns, ctx, `worker ${script} not installed yet - skipping`, `missing:${script}`);
        return { ok: false, pid: 0, reason: "missing" };
    }
    const needed = ns.getScriptRam(script, "home");
    const free = ns.getServerMaxRam("home") - ns.getServerUsedRam("home");
    if (needed > free) {
        // Key on the script, not the message: `free` changes every cycle and would defeat the dedupe.
        warnOnce(ns, ctx, `not enough home RAM for ${script}: needs ${needed.toFixed(2)} GB, free ${free.toFixed(2)} GB`, `ram:${script}`);
        return { ok: false, pid: 0, reason: "ram" };
    }
    ctx.warned.delete(`ram:${script}`); // a shortage that has cleared should warn again if it returns
    const res = await runWorker(ns, script, args, { wait: false });
    // Wait here rather than inside runWorker so the log port keeps being drained while a long job runs
    // (draining is only legal between awaits - see the note in main()).
    if (res.ok && wait) {
        while (ns.isRunning(res.pid)) {
            await ns.sleep(200);
            drainLog(ns, ctx);
        }
    }
    return res;
}

/** Append a line to the lifecycle log (0 GB): full history after the tail scrolls. **/
function append(ns, text) {
    try {
        ns.write(LIFECYCLE_LOG, text + "\n", "a");
    } catch {
        // transient (node reset): the tail still has it
    }
}

/** A line from the daemon itself: tail + lifecycle file. **/
function emit(ns, text) {
    ns.print(text);
    append(ns, text);
}

/** A daemon event line with a level, tagged "daemon" like a worker line. **/
function logLine(ns, ctx, level, message) {
    const text = `${stamp()} c${ctx.cycle} [${ctx.phase}] daemon ${level}: ${message}`;
    emit(ns, text);
    if (level === "ERROR") ns.tprint(text);
    if (level === "MILESTONE") ns.toast(message, "success");
}

const mile = (ns, ctx, message) => logLine(ns, ctx, "MILESTONE", message);

/** Log a WARN once. `key` (defaults to the message) must be stable: a message that embeds a changing
 * value (free RAM) would otherwise re-warn every cycle. **/
function warnOnce(ns, ctx, message, key = message) {
    if (ctx.warned.has(key)) return;
    ctx.warned.add(key);
    logLine(ns, ctx, "WARN", message);
}

/** Dry-run / pause "would start" line, printed once per script (avoid per-cycle spam). **/
function announce(ns, ctx, tag, script, args) {
    const key = `${tag} ${script}`;
    if (ctx.announced.has(key)) return;
    ctx.announced.add(key);
    logLine(ns, ctx, "INFO", `${tag} ${script}${args.length ? " " + args.join(" ") : ""}`);
}

function banner(ns, ctx) {
    const mode = ctx.dryRun ? "DRY-RUN" : ctx.paused ? "PAUSED" : "LIVE";
    emit(
        ns,
        `${stamp()} corp.js daemon started [${mode}] - city ${ctx.options.productCity}, mat-ratio ${ctx.options.matRatio}, ` +
            `improve-every ${ctx.options.improveEvery}, custom-supply ${ctx.options.customSupply}`,
    );
}

/** Offline check of the warn-once / announce dedupe (no game - corp.js has no top-level ns use):
 *   node --input-type=module -e "import('./corp.js').then(m=>m.selfCheck()).then(()=>console.log('corp.js selfCheck ok'))"
 * Proves repeated warnings collapse to one line - NOT in-game correctness. **/
export function selfCheck() {
    const lines = [];
    const ns = { print: (t) => lines.push(String(t)), write: () => {}, tprint: () => {}, toast: () => {} };
    const ctx = { cycle: 1, phase: "R1", warned: new Set(), announced: new Set() };
    // A message that embeds a changing value (free RAM) must still warn only once per key.
    warnOnce(ns, ctx, "not enough home RAM for X: needs 1 GB, free 1 GB", "ram:X");
    warnOnce(ns, ctx, "not enough home RAM for X: needs 1 GB, free 2 GB", "ram:X");
    if (lines.length !== 1) throw new Error(`warnOnce dedupe: logged ${lines.length}, want 1`);
    ctx.warned.delete("ram:X"); // a cleared shortage may warn again
    warnOnce(ns, ctx, "not enough home RAM for X: needs 1 GB, free 3 GB", "ram:X");
    if (lines.length !== 2) throw new Error(`warnOnce re-warn after clear: logged ${lines.length}, want 2`);
    announce(ns, ctx, "DRYRUN would start", "Corp/corp-advert.js", []); // dedupes per (tag, script)
    announce(ns, ctx, "DRYRUN would start", "Corp/corp-advert.js", []);
    if (lines.length !== 3) throw new Error(`announce dedupe: logged ${lines.length}, want 3`);
    return true;
}
