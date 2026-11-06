/** T06 - corp-rules.js: the daemon's brain as a PURE function (no ns, no I/O).
 *
 * Ported from catloversg/bitburner-scripts (MIT) - logic only, plain JS.
 *
 * `decide(state, ctx)` returns what the daemon (T07) should start this cycle:
 *   { phase, services: [{script, args}], job: {script, args, reason} | null, notes: [] }
 * The daemon does the I/O (run services/job, drain the log port); every choice lives here so
 * every phase transition can be unit-tested offline with fabricated snapshots (selfCheck()).
 *
 * Guide refs: §4.1-4.3 (p19-22) round structure; §19.2-19.4 (p73-79) budgets, cadence, offer milestones;
 * §18.5 (p71) dummy divisions; §13/§19.4.2 (p76) Wilson/Advert split.
 *
 * Distinct ns.corporation.* APIs used: NONE (this file is pure; it never touches ns).
 */
import { AGRI_NAME, CHEM_NAME, TOB_NAME } from "./corp-lib.js";

// Budget splits of the product-division + corporation-upgrades budget (§19.4.2 p76).
export const SPLIT_BEFORE_ADVERT_FOCUS = { raw: 1 / 23, wilsonAdvert: 4 / 23, office: 8 / 23, stats: 8 / 23, salesBot: 1 / 23, projectInsight: 1 / 23 };
export const SPLIT_AFTER_ADVERT_FOCUS = { raw: 1 / 19, wilsonAdvert: 0, office: 8 / 19, stats: 8 / 19, salesBot: 1 / 19, projectInsight: 1 / 19 };
export const ADVERT_FOCUS_PROFIT = 1e18; // guide: "~1e18-1e19/s"; use the low end
export const SUPPORT_START_BUDGET = { [AGRI_NAME]: 150e9, [CHEM_NAME]: 30e9 }; // §19.4.2 p77 (guide: 500b/100b enough)
export const SUPPORT_WAREHOUSE_VS_OFFICE = [0.10, 0.90]; // §19.4.2 p77
export const MAIN_VS_SUPPORT_OFFICE = { 3: [0.75, 0.25], 4: [0.50, 0.50] }; // round 3 / round 4+ (§19.4.2 p77)

const R_UPKEEP = "Corp/corp-upkeep.js";
const R_SUPPLY = "Corp/corp-supply.js";
const R_PRICING = "Corp/corp-pricing.js";
const R_PRODUCTS = "Corp/corp-products.js";
const R_OFFERS = "Corp/corp-offers.js";
const R_RESEARCH = "Corp/corp-research.js";
const R_IMPROVE = "Corp/corp-improve.js";
const R_ADVERT = "Corp/corp-advert.js";
const R_DUMMIES = "Corp/corp-dummies.js";
const R_R1 = "Corp/phase-round1.js";
const R_R2 = "Corp/phase-round2.js";
const R_R3 = "Corp/phase-round3.js";

const MAX_DIVISIONS = 20; // BN3 max (§2 FAQ p10); other BNs use T08's maxDivisions
const DUMMY_DIVISION_COST = 55e9; // 10e9 (Restaurant) + 5*4e9 offices + 5*5e9 warehouses (T20; Sector-12's office AND warehouse are created free with the division)
const PHASE_RELAUNCH = 5; // don't hammer a phase job that just exited (job rule 1)
const SUPPORT_CADENCE = { [AGRI_NAME]: 10, [CHEM_NAME]: 15 }; // §19.4.2 p77 / reference corporation.ts 923-944

/** Which phase the corporation is in. Uses offer.round (getCorporation() has no round field, T04).
 * @param {object} state parsed /Temp/corp-state.txt
 * @returns {"NO_CORP"|"R1"|"R2"|"R3_SETUP"|"GROW"|"PUBLIC"} **/
export function detectPhase(state) {
    if (!state?.hasCorp) return "NO_CORP";
    if (state.corp?.public) return "PUBLIC";
    const divisions = state.divisions ?? {};
    if (!divisions[AGRI_NAME]) return "R1"; // no Agriculture yet
    const round = state.offer?.round ?? 0;
    if (round === 1) return "R1"; // Agriculture exists, offer 1 not accepted yet
    if (round === 2) return "R2"; // Chemical not created yet OR created, waiting for offer 2
    if (round >= 3 && !divisions[TOB_NAME]) return "R3_SETUP";
    return "GROW"; // round 3/4 pending, or all four accepted (T14 decides going public)
}

/** How this cycle's money should be split, so T15 (advert) and T18 (improve) never double count.
 * @param {object} state @param {{advertShare?:number}} [opts] **/
export function spendPlan(state, opts = {}) {
    const profit = state.corp.revenue - state.corp.expenses;
    const funds = state.corp.funds;
    const advertFocus = profit >= ADVERT_FOCUS_PROFIT;
    const splits = advertFocus ? SPLIT_AFTER_ADVERT_FOCUS : SPLIT_BEFORE_ADVERT_FOCUS;
    const B = 0.9 * funds; // guide: >= 90% of funds to product division + corporation upgrades
    const advertBudget = advertFocus ? Math.max(0.2, opts.advertShare ?? 0.2) * funds : B * splits.wilsonAdvert;
    const improveBudget = B - advertBudget;
    return { advertFocus, productDivisionShare: 0.9, advertBudget, improveBudget, splits };
}

/** Decide the desired services and the one job (if any) for this cycle.
 * @param {object} state parsed /Temp/corp-state.txt (T04)
 * @param {{cycle:number, installed:Set<string>, runningJob:boolean, lastJobCycle?:Object, options?:object}} ctx
 * @returns {{phase:string, services:{script:string,args:any[]}[], job:{script:string,args:any[],reason:string}|null, notes:string[]}} **/
export function decide(state, ctx) {
    const opts = ctx.options ?? {};
    const phase = detectPhase(state);
    const notes = [];
    if (!state?.hasCorp) return { phase, services: [], job: null, notes };

    const divisions = state.divisions ?? {};
    const round = state.offer?.round ?? 0;
    const funds = state.corp.funds;
    const profit = state.corp.revenue - state.corp.expenses;
    const productCity = opts.productCity ?? "Sector-12";

    // --- services: the desired set; the daemon starts the missing ones, never duplicates ---
    const services = [{ script: R_UPKEEP, args: [] }];
    if (opts.customSupply && ctx.installed?.has(R_SUPPLY)) services.push({ script: R_SUPPLY, args: [] });
    const anyFinished = Object.values(divisions).some((d) => (d.products ?? []).some((p) => p.developmentProgress >= 100));
    if (anyFinished || phase === "GROW" || phase === "PUBLIC")
        services.push({ script: R_PRICING, args: ["--product-city", productCity] });
    if (phase === "GROW" || phase === "PUBLIC") {
        services.push({ script: R_PRODUCTS, args: ["--product-city", productCity] });
        services.push({ script: R_OFFERS, args: ["--product-city", productCity] });
        if (round >= 4) services.push({ script: R_RESEARCH, args: [] }); // §19.4.2 p79: no research in round 3
    }

    // --- jobs: at most ONE, and none while another is running ---
    if (ctx.runningJob) return { phase, services, job: null, notes };
    const installed = ctx.installed ?? new Set();
    let job = pickJob(state, ctx, phase, opts, { divisions, round, funds, profit });
    if (job && !installed.has(job.script)) {
        notes.push(`MISSING ${job.script} — phase blocked`);
        job = null;
    }
    return { phase, services, job, notes };
}

/** @returns {{script:string,args:any[],reason:string}|null} **/
function pickJob(state, ctx, phase, opts, { divisions, round, funds, profit }) {
    const last = (script) => ctx.lastJobCycle?.[script] ?? -Infinity;
    const relaunchable = (script) => ctx.cycle - last(script) >= PHASE_RELAUNCH;
    const productCity = opts.productCity ?? "Sector-12";
    const matRatio = opts.matRatio ?? 0.8;

    if (phase === "R1") {
        if (!relaunchable(R_R1)) return null;
        const args = ["--mat-ratio", String(opts.matRatio ?? 0.8)];
        if (opts.customSupply) args.push("--custom-supply");
        return { script: R_R1, args, reason: "round 1: create corporation + Agriculture, accept offer 1" };
    }
    if (phase === "R2") {
        if (!relaunchable(R_R2)) return null;
        return { script: R_R2, args: [], reason: "round 2: Export, Chemical, Agriculture upgrades, accept offer 2" };
    }
    if (phase === "R3_SETUP") {
        if (!relaunchable(R_R3)) return null;
        return { script: R_R3, args: ["--product-city", productCity], reason: "round 3 setup: Tobacco + exports + first product" };
    }

    // --- GROW / PUBLIC: one improve-cadence job per improveEvery cycles ---
    const every = opts.improveEvery ?? 5;
    const due = (script) => ctx.cycle - last(script) >= every;

    const tob = divisions[TOB_NAME];
    const tobFinished = (tob?.products ?? []).some((p) => p.developmentProgress >= 100);
    const tobRevenue = (tob?.lastCycleRevenue ?? 0) > 0;
    const numDivisions = Object.keys(divisions).length;
    const hasDummy = Object.keys(divisions).some((name) => name.startsWith("z-"));
    const plan = spendPlan(state, opts);

    const chemBudget = Math.min(profit * (round <= 4 ? 0.1 : 0.01), funds * 0.01);
    const agriBudget = Math.min(profit * (round <= 4 ? 0.9 : 0.99), funds * 0.09);
    const dummyBudget = Math.min(funds * 0.5, (MAX_DIVISIONS - numDivisions) * DUMMY_DIVISION_COST);

    // Longest cadence first: only one job runs per cycle, so the 10/15-cycle support jobs would
    // otherwise be starved by the improveEvery jobs (which are due at every multiple of `every`).
    const candidates = [
        {
            due: ctx.cycle % SUPPORT_CADENCE[CHEM_NAME] === 0 && tobRevenue && chemBudget >= 1e9,
            script: R_IMPROVE,
            args: ["--division", CHEM_NAME, "--support", "--budget", String(chemBudget), "--round", String(round), "--mat-ratio", String(matRatio)],
            reason: `support division ${CHEM_NAME} (every ${SUPPORT_CADENCE[CHEM_NAME]} cycles)`,
        },
        {
            due: ctx.cycle % SUPPORT_CADENCE[AGRI_NAME] === 0 && tobRevenue && agriBudget >= 1e9,
            script: R_IMPROVE,
            args: ["--division", AGRI_NAME, "--support", "--budget", String(agriBudget), "--round", String(round), "--mat-ratio", String(matRatio)],
            reason: `support division ${AGRI_NAME} (every ${SUPPORT_CADENCE[AGRI_NAME]} cycles)`,
        },
        {
            due: due(R_DUMMIES) && tobFinished && numDivisions < MAX_DIVISIONS && !hasDummy && dummyBudget >= DUMMY_DIVISION_COST,
            script: R_DUMMIES,
            args: ["--budget", String(dummyBudget)],
            reason: "dummy divisions to inflate the round 3/4 offer (§18.5)",
        },
        {
            due: due(R_ADVERT) && plan.advertBudget > 0,
            script: R_ADVERT,
            args: ["--budget", String(plan.advertBudget)],
            reason: "Wilson + Advert (§13, §19.4.2)",
        },
        {
            due: due(R_IMPROVE) && (tobRevenue || round <= 3) && plan.improveBudget > 0,
            script: R_IMPROVE,
            args: ["--division", TOB_NAME, "--budget", String(plan.improveBudget), "--round", String(round), "--mat-ratio", String(matRatio), "--product-city", productCity],
            reason: `improve product division ${TOB_NAME} + corporation upgrades`,
        },
    ];
    for (const c of candidates) if (c.due) return { script: c.script, args: c.args, reason: c.reason };
    return null;
}

// ---------------------------------------------------------------------------------------------
// Offline self-check (fabricated snapshots only — proves control flow, NOT in-game correctness).

/** @returns {object} a division slice with sane defaults @param {object} [o] **/
function div(o = {}) {
    return { industry: "Agriculture", products: [], lastCycleRevenue: 0, offices: {}, warehouses: {}, ...o };
}
/** @returns {object} a snapshot @param {object} [o] **/
function fakeState(o = {}) {
    const base = {
        t: 0,
        hasCorp: true,
        corp: { name: "Erebos", funds: 1e12, revenue: 1e6, expenses: 2e5, public: false, divisions: [] },
        offer: { funds: 0, round: 1, shares: 0 },
        unlocks: {},
        upgrades: {},
        divisions: {},
    };
    const s = { ...base, ...o };
    if (o.corp) s.corp = { ...base.corp, ...o.corp };
    if (o.offer) s.offer = { ...base.offer, ...o.offer };
    return s;
}
/** @returns {object} a ctx @param {object} [o] **/
function fakeCtx(o = {}) {
    return {
        cycle: 1,
        installed: new Set(),
        runningJob: false,
        lastJobCycle: {},
        options: { improveEvery: 5, advertShare: 0.2, customSupply: false, productCity: "Sector-12", matRatio: 0.8, dryRun: false },
        ...o,
    };
}
const withTob = (round) => fakeState({ divisions: { [AGRI_NAME]: div(), [CHEM_NAME]: div(), [TOB_NAME]: div() }, offer: { round } });

/** Throws on the first failed assertion, returns true otherwise. Run in node (see header). **/
export function selfCheck() {
    const eq = (got, want, label) => {
        if (got !== want) throw new Error(`${label}: got ${got}, want ${want}`);
    };
    const ok = (cond, label) => {
        if (!cond) throw new Error(label);
    };
    const scripts = (plan) => plan.services.map((s) => s.script);

    // 1. no corporation
    eq(detectPhase({ hasCorp: false }), "NO_CORP", "detectPhase NO_CORP");

    // 2. phase table
    eq(detectPhase(fakeState({ divisions: {}, offer: { round: 1 } })), "R1", "R1 empty");
    eq(detectPhase(fakeState({ divisions: { [AGRI_NAME]: div() }, offer: { round: 1 } })), "R1", "R1 agri only");
    eq(detectPhase(fakeState({ divisions: { [AGRI_NAME]: div() }, offer: { round: 2 } })), "R2", "R2 no chem");
    eq(detectPhase(fakeState({ divisions: { [AGRI_NAME]: div(), [CHEM_NAME]: div() }, offer: { round: 2 } })), "R2", "R2 with chem");
    eq(detectPhase(fakeState({ divisions: { [AGRI_NAME]: div(), [CHEM_NAME]: div() }, offer: { round: 3 } })), "R3_SETUP", "R3 setup");
    eq(detectPhase(withTob(3)), "GROW", "GROW round 3");
    eq(detectPhase(fakeState({ corp: { public: true } })), "PUBLIC", "PUBLIC");

    // 3. R1 job: blocked with a note when the script is not installed, launched when it is
    const r1State = fakeState({ divisions: {}, offer: { round: 1 } });
    const blocked = decide(r1State, fakeCtx());
    eq(blocked.job, null, "R1 blocked job");
    ok(blocked.notes.some((n) => n.startsWith("MISSING Corp/phase-round1.js")), "R1 MISSING note");
    const launched = decide(r1State, fakeCtx({ installed: new Set([R_R1]) }));
    eq(launched.job?.script, R_R1, "R1 launches phase-round1");
    ok(launched.job.args.includes("--mat-ratio"), "R1 passes --mat-ratio");
    eq(decide(r1State, fakeCtx({ installed: new Set([R_R1]), options: { ...fakeCtx().options, customSupply: true } })).job.args.includes("--custom-supply"), true, "R1 --custom-supply");

    // 4. GROW with a job already running -> no job
    eq(decide(withTob(3), fakeCtx({ runningJob: true })).job, null, "runningJob suppresses job");

    // 5. spendPlan split switch at the advert-focus threshold
    const before = spendPlan(fakeState({ corp: { revenue: 5e17, expenses: 0 } }), {});
    eq(before.advertFocus, false, "advertFocus below threshold");
    ok(Math.abs(before.splits.wilsonAdvert - 4 / 23) < 1e-12, "wilsonAdvert 4/23 before");
    const after = spendPlan(fakeState({ corp: { revenue: 2e18, expenses: 0 } }), {});
    eq(after.advertFocus, true, "advertFocus above threshold");
    eq(after.splits.wilsonAdvert, 0, "wilsonAdvert 0 after");
    const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
    ok(Math.abs(sum(before.splits) - 1) < 1e-12 && Math.abs(sum(after.splits) - 1) < 1e-12, "splits sum to 1");

    // 6. research service gated on offer.round >= 4
    ok(!scripts(decide(withTob(3), fakeCtx())).includes(R_RESEARCH), "no research in round 3");
    ok(scripts(decide(withTob(4), fakeCtx())).includes(R_RESEARCH), "research in round 4");

    // 7. The GROW improve job carries the daemon's own --mat-ratio / --product-city. Without them corp-improve and
    //    corp-offices silently fall back to 0.8 / Sector-12, so `run corp.js --mat-ratio 0.5` would only half apply.
    const grown = decide(
        withTob(3),
        fakeCtx({ installed: new Set([R_IMPROVE]), lastJobCycle: { "Corp/corp-advert.js": 1 }, options: { ...fakeCtx().options, productCity: "Aevum", matRatio: 0.5 } }),
    );
    eq(grown.job?.script, R_IMPROVE, "GROW picks the improve job once advert is not due");
    eq(grown.job.args[grown.job.args.indexOf("--mat-ratio") + 1], "0.5", "improve gets --mat-ratio");
    eq(grown.job.args[grown.job.args.indexOf("--product-city") + 1], "Aevum", "improve gets --product-city");

    return true;
}
