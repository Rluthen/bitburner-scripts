/** T19 - corp-offices.js: office sizes and job ratios for a support division, the product division's main
 * office and its product-support offices (JOB - runs to completion, exits; idempotent "ensure target").
 *
 * Distinct ns.corporation.* APIs used (RAM is charged per DISTINCT name; docs figures, NOT measured):
 *   10 GB: getOffice
 *   20 GB: upgradeOfficeSize hireEmployee setJobAssignment
 *   => docs sum 70 GB + script base. Deliberately absent:
 *   - `getOfficeSizeUpgradeCost` is not needed: the cost and the highest affordable size are the pure
 *     formulas from Corp/corp-formulas.js (office cost is §10.2 p40).
 *   - `getDivision`/`getCorporation`/`getInvestmentOffer` are not in this job's API budget: the division's
 *     cities, the offer round, the profit and whether the first product is done all come from the T04
 *     snapshot (/Temp/corp-state.txt, ns.read = 0 GB).
 *   - Corp/corp-ops.js is NOT imported: that shared module would charge this job its own 13-read +
 *     16-action union (~470 GB docs) for two inlined calls (growOffice/assignJobs).
 *
 * Ratios: guide §19.4.2 p76-78 (tables below), §4.3 p21-22 (which setup belongs to which role/round),
 * §10.2 p40 (office cost), §11.2 p45 (Engineer dominates quality in round 3+).
 * Ported from catloversg/bitburner-scripts (MIT): corporation.ts improveSupportDivision,
 * improveProductDivisionMainOffice, improveProductDivisionSupportOffices, needToUpgradeDivision.
 *
 * Run: `run Corp/corp-offices.js --division "Dark Soil" --budget 30e9 --mode support --round 3`
 *      `run Corp/corp-offices.js --division "Ebon Stick" --budget 500e9 --mode product --round 3`
 *      (T18 launches it with the office share of its budget; T14 launches `--restore-normal` after an offer.)
 */
import { formatMoney, getConfiguration, instanceCount } from "../helpers.js";
import { JOBS, OFFER_PREP_FILE, STATE_FILE, corpLog, getCities } from "./corp-lib.js";
import { maxAffordableOfficeSize, officeUpgradeCost, ratiosToCounts } from "./corp-formulas.js";

const SETTABLE_JOBS = Object.values(JOBS).filter((job) => job !== JOBS.none); // Unassigned is not settable
const OFFICE_UPGRADE_MIN = 30; // reference needToUpgradeDivision: never buy a smaller gain than this...
const OFFICE_MIN_SIZE = 6; // ...unless the office is still tiny, where §19.4.2's 4-job split needs 6 places
const SUPPORT_RND_SHARE = 0.2; // §19.4.2: a support division's office keeps 20% of its employees on R&D
const SUPPORT_NON_RND_RATIO = [0.22, 0.632, 0, 0.148]; // its non-R&D split, order [ops, eng, biz, mgmt]
const SUPPORT_MAIN_SHARE_ROUND_3 = 0.75; // §19.4.2: main office : support offices = 75:25 in round 3...
const SUPPORT_MAIN_SHARE_LATER = 0.5; // ...50:50 from round 4

// §19.4.2 p76-78 main-office ratios, order [Operations, Engineer, Business, Management]; the main office
// never has R&D. "progress" while a product is being developed, "profit-progress" after the last offer of a
// round, split at the guide's 1e30 profit (profit-focus). All four sum to 1.
const MAIN_ROUND_3 = [0.037, 0.513, 0.011, 0.44];
const MAIN_ROUND_4 = [0.03, 0.531, 0.003, 0.436];
const MAIN_PROFIT_PROGRESS = [0.032, 0.462, 0.067, 0.439];
const MAIN_PROFIT_PROGRESS_RICH = [0.064, 0.317, 0.298, 0.321];
// The "profit" setup, identical to profitRatio in Corp/corp-offers.js (T14) - duplicated because importing
// that service would pull its corporation-API union into this job. §19.4.2: round 3 49/5/51/33, round 4+ 68/12/244/45.
const PROFIT_ROUND_3 = [49 / 138, 5 / 138, 51 / 138, 33 / 138];
const PROFIT_ROUND_4 = [68 / 369, 12 / 369, 244 / 369, 45 / 369];

const argsSchema = [
    ["division", ""], // the division whose offices to set up ("Dark Soil", "Ebon Stick", ...)
    ["budget", 0], // money for these offices; the daemon (T06) and T18 own the amount
    ["mode", "product"], // support | product | profit
    ["round", 3], // investment round: picks the ratio table and the "is a small upgrade worth it" threshold
    ["product-city", "Sector-12"], // the city whose office develops the products (T13's --product-city)
    ["profit-focus", 1e30], // §19.4.2: above this profit the main office switches to the rich ratio
    ["restore-normal", false], // T14: put the offices back on the current state's normal setup, without buying
];

export function autocomplete(data, _) {
    data.flags(argsSchema);
    return [];
}

/** The four non-R&D job counts out of a [ops, eng, biz, mgmt] ratio (R&D is added by the caller). Pure. **/
function countsOf(ratios, size) {
    const [ops, eng, biz, mgmt] = ratiosToCounts(ratios, size);
    return { ops, eng, biz, mgmt };
}

/** Main (product-developing) office ratio [ops, eng, biz, mgmt] for a round. Pure, §19.4.2 p76-78.
 * Round 3 and 4 are the guide's "progress" tables; after round 4 the ratio depends on the profit against
 * `profitFocus` (1e30): below it the product still matters ("profit-progress"), above it profit does. **/
export function mainOfficeRatio(round, profit, profitFocus = 1e30) {
    if (round <= 3) return [...MAIN_ROUND_3];
    if (round === 4) return [...MAIN_ROUND_4];
    return [...(profit < profitFocus ? MAIN_PROFIT_PROGRESS : MAIN_PROFIT_PROGRESS_RICH)];
}

/** Jobs of one of the 5 product-support offices, per §19.4.2 p77-78:
 * round 3 before the first product finishes - all R&D (the office exists to raise RP);
 * round 3 after it and round 4 - 1 each of Operations/Engineer/Business/Management, the rest R&D;
 * after round 4 - half R&D, the rest by the round-4 profit ratio. Pure. **/
export function supportOfficeRule({ round, firstProductDone, size }) {
    // The 4-job split needs 4 employees; anything smaller stays on R&D (setJobAssignment would throw).
    const allRnD = { rnd: size, ops: 0, eng: 0, biz: 0, mgmt: 0 };
    if ((round <= 3 && !firstProductDone) || size < 4) return allRnD;
    if (round <= 4) return { rnd: size - 4, ops: 1, eng: 1, biz: 1, mgmt: 1 };
    const rnd = Math.floor(size / 2);
    return { rnd, ...countsOf(PROFIT_ROUND_4, size - rnd) };
}

/** Jobs of one office of a SUPPORT division (Agriculture, Chemical): §19.4.2 p77 - R&D takes
 * min(floor(20%), size-3) of the employees, the rest is split by the precalculated non-R&D ratio
 * (Operations 0.22, Engineer 0.632, Business 0, Management 0.148 - Engineer carries production and quality,
 * §11.2 p45). Pure. **/
export function supportDivisionOfficeRule(size) {
    const rnd = Math.min(Math.floor(size * SUPPORT_RND_SHARE), Math.max(size - 3, 0));
    return { rnd, ...countsOf(SUPPORT_NON_RND_RATIO, size - rnd) };
}

/** Support offices in the "profit" setup: the main ratio floored but with at least 1 employee in each of
 * Operations/Engineer/Business and Management taking the remainder, R&D 0 - the same numbers T14
 * (Corp/corp-offers.js profitOfficeJobs) applies before accepting an offer. Pure, §19.4.2 p77-78. **/
export function profitSupportJobs(ratio, size) {
    const [ops, eng, biz] = ratio.slice(0, 3).map((r) => Math.max(Math.floor(r * size), 1));
    return { rnd: 0, ops, eng, biz, mgmt: Math.max(size - (ops + eng + biz), 0) };
}

/** Profit-setup ratio for a round (round 3 and earlier vs round 4+). Pure; same constants as T14. **/
export function profitRatio(round) {
    return [...(round <= 3 ? PROFIT_ROUND_3 : PROFIT_ROUND_4)];
}

/** What a per-office budget buys, and whether buying it is worth it. Pure.
 * `null` means "leave this office as it is": the budget buys nothing, or the gain is too small to bother
 * (reference needToUpgradeDivision - at least min(size/2, 30) places in rounds <= 4, else 30, because a
 * tiny upgrade wastes a purchase on the 1.09^(size/3) ladder). An office below OFFICE_MIN_SIZE is always
 * worth growing: that is where workers stop being unassigned.
 * @returns {{size: number, cost: number}|null} target size and what it costs **/
export function officeUpgrade(fromSize, budget, round) {
    const want = maxAffordableOfficeSize(fromSize, budget);
    if (want <= fromSize) return null;
    const minGain = round <= 4 ? Math.min(fromSize / 2, OFFICE_UPGRADE_MIN) : OFFICE_UPGRADE_MIN;
    if (fromSize >= OFFICE_MIN_SIZE && want - fromSize < minGain) return null;
    return { size: want, cost: officeUpgradeCost(fromSize, want) };
}

/** The T04 snapshot, or null when it is missing/unreadable. 0 GB (ns.read), so this job never pays the
 * 10 GB getters for the round, the profit or the product progress. **/
function readSnapshot(ns) {
    try {
        return JSON.parse(ns.read(STATE_FILE));
    } catch {
        return null;
    }
}

/** The round the current state is in, out of the snapshot: its offer round, or 5 when no offer is left
 * (public corporation / every offer accepted) - the same encoding T14 uses. Only meaningful for
 * --restore-normal, which re-applies "the current state's setup" and gets no --round from T14. **/
function snapshotRound(state) {
    const offer = state?.offer;
    if (!offer || !(Number(offer.round) > 0)) return null;
    return offer.funds === 0 ? 5 : Number(offer.round);
}

/** Did the product division's first product finish? (All-R&D vs the 4-job split.) From the snapshot, 0 GB. **/
function firstProductDone(state, division) {
    const products = state?.divisions?.[division]?.products ?? [];
    return products.some((product) => Number(product.developmentProgress) >= 100);
}

/** "30" when every office holds the same size, "30-36" when they differ, "-" for no office at all. **/
function rangeLabel(sizes) {
    if (sizes.length === 0) return "-";
    const min = Math.min(...sizes);
    const max = Math.max(...sizes);
    return min === max ? String(min) : `${min}-${max}`;
}

/** Grow one office to what its budget can afford and hire up to the size the game applied.
 * Inline of T03's corp-ops.ensureOfficeSize (see the header for why it is not imported): `upgradeOfficeSize`
 * takes an INCREASE and is silent when the funds are short, so the size is re-read afterwards and the spend
 * comes from the pure cost formula instead of a funds getter. `buy` false = jobs only (T14's restore).
 * @returns {{from: number, size: number, employees: number, spent: number}} **/
function growOffice(ns, division, city, budget, round, buy) {
    let office = ns.corporation.getOffice(division, city);
    const from = office.size;
    let spent = 0;
    if (buy) {
        const plan = officeUpgrade(from, budget, round);
        if (plan !== null) {
            ns.corporation.upgradeOfficeSize(division, city, plan.size - from);
            office = ns.corporation.getOffice(division, city); // the game applied only what the funds allowed
            spent = officeUpgradeCost(from, office.size);
        }
        const toHire = office.size - office.numEmployees;
        for (let i = 0; i < toHire; i++) if (!ns.corporation.hireEmployee(division, city)) break;
        if (toHire > 0) office = ns.corporation.getOffice(division, city);
    }
    return { from, size: office.size, employees: office.numEmployees, spent };
}

/** Put an office's employees into exactly these counts. setJobAssignment takes an ABSOLUTE count per job and
 * THROWS when there are not enough Unassigned employees, so every unlisted job is zeroed first and the
 * wanted ones are applied in ASCENDING count: only SHRINKING a job hands employees back to Unassigned, so
 * R&D (which a round-3 product office is full of) must shrink before Operations can grow off it.
 * Inline port of T03's corp-ops.assignJobs. @returns {boolean} false when any single assignment failed **/
function assignJobs(ns, division, city, counts) {
    const jobs = { [JOBS.rnd]: counts.rnd, [JOBS.ops]: counts.ops, [JOBS.eng]: counts.eng, [JOBS.biz]: counts.biz, [JOBS.mgmt]: counts.mgmt };
    const before = ns.corporation.getOffice(division, city).employeeJobs;
    let ok = true;
    const set = (job, count) => {
        try {
            if (ns.corporation.setJobAssignment(division, city, job, count) === false) ok = false;
        } catch (e) {
            ok = false;
            corpLog(ns, `${division}/${city}: cannot set ${job}=${count}: ${e?.message ?? e}`, "WARN");
        }
    };
    for (const job of SETTABLE_JOBS) if (!(job in jobs)) set(job, 0);
    for (const [job, count] of Object.entries(jobs).sort((a, b) => a[1] - b[1])) set(job, count);
    if (!ok) corpLog(ns, `${division}/${city}: some job assignments failed`, "WARN");
    else if (Object.entries(jobs).some(([job, count]) => before[job] !== count)) corpLog(ns, `${division}/${city}: jobs ${JSON.stringify(jobs)}`);
    return ok;
}

/** @param {NS} ns @param {object} cfg **/
function run(ns, cfg) {
    // Step 1: never rebalance while T14 is switching the product division around for an offer.
    if (cfg.mode !== "profit" && ns.read(OFFER_PREP_FILE).trim() === "1") {
        corpLog(ns, "T14 is preparing to accept an offer - leaving the offices alone", "INFO");
        return;
    }
    const state = readSnapshot(ns);
    // The division's own city list, from the snapshot (0 GB) - getOffice throws for a city the division is
    // not in, and getDivision is not part of this job's API budget (header).
    const known = state?.divisions?.[cfg.division]?.cities;
    const cities = Array.isArray(known) && known.length > 0 ? known : getCities(ns);
    const round = (cfg.restoreNormal ? snapshotRound(state) : null) ?? cfg.round;
    const profit = Number(state?.corp?.profit) || 0; // per second, same convention as T15's profit-focus
    const profitMode = cfg.mode === "profit";
    const buy = !cfg.restoreNormal && !profitMode; // --restore-normal and --mode profit set jobs only
    if (buy && !(cfg.budget > 0)) {
        corpLog(ns, `nothing to do: --budget is ${cfg.budget} but mode ${cfg.mode} buys (the daemon passes --budget, T06)`, "WARN");
        return;
    }

    if (cfg.mode === "support") {
        const perCity = cfg.budget / cities.length;
        // Step 3: the reference throws when a city's share buys fewer than 6 employees (§19.4.2's split needs
        // 6); we warn and leave every office untouched instead. Probed before anything is bought.
        const probe = ns.corporation.getOffice(cfg.division, cities[0]);
        if (buy && maxAffordableOfficeSize(probe.size, perCity) < OFFICE_MIN_SIZE) {
            corpLog(ns, `offices ${cfg.division}: ${formatMoney(perCity)} per city buys fewer than ${OFFICE_MIN_SIZE} employees - leaving the offices alone`, "WARN");
            return;
        }
        const before = [];
        const after = [];
        let spent = 0;
        for (const city of cities) {
            const office = growOffice(ns, cfg.division, city, perCity, round, buy);
            before.push(office.from);
            after.push(office.size);
            spent += office.spent;
            assignJobs(ns, cfg.division, city, supportDivisionOfficeRule(office.employees));
        }
        corpLog(ns, `offices ${cfg.division} (support, round ${round}): ${cities.length} offices ${rangeLabel(before)}→${rangeLabel(after)}, spent ${formatMoney(spent)}`);
        return;
    }

    // Step 2: 1 main office (the product city) + the other 5 cities as product-support offices.
    const supportCities = cities.filter((city) => city !== cfg["product-city"]);
    const mainShare = round <= 3 ? SUPPORT_MAIN_SHARE_ROUND_3 : SUPPORT_MAIN_SHARE_LATER;
    const supportBudget = supportCities.length > 0 ? (cfg.budget * (1 - mainShare)) / supportCities.length : 0;
    const firstDone = firstProductDone(state, cfg.division);
    const main = growOffice(ns, cfg.division, cfg["product-city"], cfg.budget * mainShare, round, buy);
    const mainRatio = profitMode ? profitRatio(round) : mainOfficeRatio(round, profit, cfg["profit-focus"]);
    assignJobs(ns, cfg.division, cfg["product-city"], { rnd: 0, ...countsOf(mainRatio, main.employees) });
    const before = [];
    const after = [];
    let spent = main.spent;
    for (const city of supportCities) {
        const office = growOffice(ns, cfg.division, city, supportBudget, round, buy);
        before.push(office.from);
        after.push(office.size);
        spent += office.spent;
        assignJobs(
            ns,
            cfg.division,
            city,
            profitMode ? profitSupportJobs(mainRatio, office.employees) : supportOfficeRule({ round, firstProductDone: firstDone, size: office.employees }),
        );
    }
    corpLog(
        ns,
        `offices ${cfg.division} (${cfg.mode}, round ${round}): main size ${main.from}→${main.size}, support size ${rangeLabel(before)}→${rangeLabel(after)}, spent ${formatMoney(spent)}`,
    );
}

/** @param {NS} ns **/
export async function main(ns) {
    const options = getConfiguration(ns, argsSchema);
    if (!options || (await instanceCount(ns)) > 1) return;
    ns.disableLog("ALL");
    const cfg = {
        division: String(options.division),
        budget: Number(options.budget),
        mode: String(options.mode),
        round: Number(options.round),
        "product-city": String(options["product-city"]),
        "profit-focus": Number(options["profit-focus"]),
        restoreNormal: !!options["restore-normal"],
    };
    if (!cfg.division) {
        corpLog(ns, "nothing to do: --division is empty", "ERROR");
        return;
    }
    try {
        run(ns, cfg);
    } catch (e) {
        // An uncaught throw is only reported in the terminal, where the daemon does not look (CONTEXT §3).
        corpLog(ns, `corp-offices stopped: ${e?.message ?? e}`, "ERROR");
    }
}

/** Offline self-check of the ratio tables and the office-size decision (this file's `main` holds no
 * top-level ns use, so it loads under node: `node --input-type=module -e "import('./Corp/corp-offices.js').then(m=>m.selfCheck())"`
 * from the repo folder). Throws on the first failure. **/
export function selfCheck() {
    const eq = (actual, expected, label) => {
        if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
    };
    const near = (actual, expected, tol, label) => {
        if (!(Math.abs(actual - expected) <= tol)) throw new Error(`${label}: ${actual} != ${expected} (tol ${tol})`);
    };
    const total = (counts) => counts.rnd + counts.ops + counts.eng + counts.biz + counts.mgmt;

    // 1. Main office ratios: the guide's round-3 progress, a table that sums to 1, and the rich profit ratio.
    eq(ratiosToCounts([0.037, 0.513, 0.011, 0.44], 30), [1, 16, 0, 13], "ratiosToCounts round-3 progress");
    near(mainOfficeRatio(4, 1e10).reduce((a, b) => a + b, 0), 1, 1e-9, "mainOfficeRatio(4) sums to 1");
    eq(mainOfficeRatio(5, 5e30), [0.064, 0.317, 0.298, 0.321], "mainOfficeRatio(5, 5e30)");
    eq(mainOfficeRatio(3, 5e30), [0.037, 0.513, 0.011, 0.44], "round 3 is 'progress' whatever the profit");
    eq(mainOfficeRatio(6, 1e29), [0.032, 0.462, 0.067, 0.439], "profit below the focus threshold");
    eq(mainOfficeRatio(6, 1e30), [0.064, 0.317, 0.298, 0.321], "profit at the focus threshold");

    // 2. Product-support offices.
    eq(supportOfficeRule({ round: 3, firstProductDone: false, size: 30 }), { rnd: 30, ops: 0, eng: 0, biz: 0, mgmt: 0 }, "round 3, no product yet");
    eq(supportOfficeRule({ round: 4, firstProductDone: true, size: 30 }), { rnd: 26, ops: 1, eng: 1, biz: 1, mgmt: 1 }, "round 4 support office");
    eq(supportOfficeRule({ round: 3, firstProductDone: true, size: 30 }), { rnd: 26, ops: 1, eng: 1, biz: 1, mgmt: 1 }, "round 3 after the first product");
    const late = supportOfficeRule({ round: 5, firstProductDone: true, size: 20 });
    if (late.rnd !== 10) throw new Error(`round 5 support rnd: ${late.rnd} != 10`);
    eq([late.ops, late.eng, late.biz, late.mgmt], ratiosToCounts(PROFIT_ROUND_4, 10), "round 5 support split");
    eq(total(late), 20, "round 5 support office is fully staffed");
    eq(supportOfficeRule({ round: 4, firstProductDone: true, size: 3 }), { rnd: 3, ops: 0, eng: 0, biz: 0, mgmt: 0 }, "a 3-person office stays on R&D");

    // 3. Support-division office: R&D = min(floor(20%), size-3), the rest by the non-R&D ratio (Business 0).
    const support = supportDivisionOfficeRule(16);
    eq(support, { rnd: 3, ops: 3, eng: 8, biz: 0, mgmt: 2 }, "support division office of 16");
    eq(total(support), 16, "support division office sums to its size");
    eq(support.biz, 0, "Business stays 0 in a support division");

    // The profit setup has to match T14's own split, or restoring/entering it would move employees around.
    eq(profitSupportJobs(PROFIT_ROUND_4, 20), { rnd: 0, ops: 3, eng: 1, biz: 13, mgmt: 3 }, "profit support office of 20");
    eq(profitRatio(3), PROFIT_ROUND_3, "profit ratio round 3");
    eq(profitRatio(4), PROFIT_ROUND_4, "profit ratio round 4");

    // 4. The office-size decision (the money path): nothing affordable, the always-grow-below-6 rule, and
    // the tiny-upgrade guard that makes the same purchase worth it in round 4 but not after.
    eq(officeUpgrade(3, 1e9, 3), null, "1e9 buys no office place at size 3");
    eq(officeUpgrade(30, 0, 5), null, "no budget, no upgrade");
    const small = officeUpgrade(3, 5e9, 3);
    if (small === null || small.size !== 6) throw new Error(`an office below ${OFFICE_MIN_SIZE} always grows: ${JSON.stringify(small)}`);
    near(small.cost, officeUpgradeCost(3, 6), 1e-9, "officeUpgrade cost");
    const round4 = officeUpgrade(45, 1.8e11, 4);
    if (round4 === null) throw new Error("a 26-place gain is worth buying in round 4");
    near(round4.cost, officeUpgradeCost(45, round4.size), 1e-9, "round-4 officeUpgrade cost");
    eq(officeUpgrade(45, 1.8e11, 5), null, "the same gain is too small after round 4");

    return true;
}
