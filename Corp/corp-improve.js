/** T18 - Corp/corp-improve.js: spend ONE budget on ONE division by the guide's precalculated ratios (JOB).
 *
 * The daemon (T06 improve rule) and phase-round3.js (T11 step 7) launch this with `--budget`; it runs to
 * completion and exits, so a job never overlaps another. Every purchase is an "ensure target" (T03 buys only
 * the delta), which is what makes a relaunch after a crash safe: no level is ever bought twice or walked back.
 * It is deliberately NOT a no-op on the same budget twice - a 1.06 ladder keeps ~6% of its path affordable,
 * so a second run buys the next level (the same caveat T15 documents). The daemon's one-job-per-cycle cadence
 * is what removes the same-budget-twice window; the guarantee here is "ensure-targets" + "spend <= budget".
 *
 * Budget split (§19.4.2 p76-77):
 *   - product division: the 19-part split the daemon's improveBudget uses (the 4/23 Wilson+Advert share is
 *     T15's): employeeStatUpgrades 8/19 (each of the four gets a quarter), office 8/19 (T19), rawProduction
 *     1/19 (Smart Storage + Smart Factories + warehouse levels, §9.2 optimizer), ABC SalesBots 1/19,
 *     Project Insight 1/19. Each step is capped by its own share, so the sum can never exceed the budget.
 *   - support division (§4.2 p19-20): warehouse 10%, offices 90% (§19.4.2 p77).
 * Order matters: upgrades first, offices second, boost materials LAST - the boost target is the warehouse
 * space as it is AFTER the raw-production step grew it (§8). Boost-material buys are NOT part of `budget`:
 * they are the guide's "go into debt" mechanism (§1.1), so they are capped separately at 90% of the funds.
 *
 * Distinct ns.corporation.* APIs charged to THIS process (docs figures from CONTEXT §4, NOT measured - `mem`):
 *   0 GB : nextUpdate
 *   10 GB: getIndustryData hasResearched getCorporation getDivision getInvestmentOffer getMaterial getOffice
 *          getWarehouse getUpgradeLevel getUpgradeLevelCost getUnlockCost hasUnlock getHireAdVertCost
 *          getHireAdVertCount hasWarehouse
 *   20 GB: acceptInvestmentOffer buyMaterial buyTea cancelExportMaterial expandCity expandIndustry exportMaterial
 *          hireAdVert hireEmployee levelUpgrade purchaseUnlock purchaseWarehouse setJobAssignment throwParty
 *          upgradeOfficeSize upgradeWarehouse
 *   => the 10/20 GB list is the union of Corp/corp-ops.js (imported for ensureUpgrade/ensureWarehouse/
 *      stockBoostMaterials), the same ~470 GB union phase-round3.js pays. The office APIs (getOffice,
 *      upgradeOfficeSize, hireEmployee, setJobAssignment) arrive with that import; Corp/corp-offices.js
 *      (T19) is launched as a SEPARATE process, so its own RAM is not this file's.
 *
 * Guide refs: §19.4.2 p76-78 (ratios; "500b/100b is enough, personally I spend only 150b/30b"), §4.3 p22
 * (Engineer > other jobs; support divisions need only minimal investment), §6.2 p24 (employee upgrades base
 * 1e9 mult 1.06; ABC SalesBots 1e9/1.07; Project Insight 5e9/1.07), §7 (warehouse size + "Drones - Transport"
 * +50%), §8.3.2 (boost-material optimum), §9.2 p38 (storage/factory/warehouse optimizer), §1.1 p7 (per-second
 * boost buys are the deliberate "debt"), §4.2 p19 (no Advert for support after round 2).
 * Ported from catloversg/bitburner-scripts (MIT): corporation.ts improveProductDivision (1657-1744) and
 * improveSupportDivision (1199-1229) - logic only; budgets and cadence are the daemon's (T06).
 *
 * Run: `run Corp/corp-improve.js --division "Ebon Stick" --budget 1e12 --round 3`
 *      `run Corp/corp-improve.js --division "Dark Soil" --support --budget 30e9 --round 3`
 */
import { formatMoney, getConfiguration, instanceCount } from "../helpers.js";
import { BOOST_MATERIALS, OFFER_PREP_FILE, corpLog, getCities, runWorker } from "./corp-lib.js";
import {
    bestStorageFactoryWarehouse,
    maxAffordableLevel,
    maxAffordableWarehouseLevel,
    optimalBoostMaterials,
    warehouseSize,
} from "./corp-formulas.js";
import { ensureUpgrade, ensureWarehouse, stockBoostMaterials } from "./corp-ops.js";

// §6.2 p24 / stable/src/Corporation/data/CorporationUpgrades.ts
const EMPLOYEE_UPGRADES = ["Nuoptimal Nootropic Injector Implants", "Speech Processor Implants", "Neural Accelerators", "FocusWires"];
const EMPLOYEE_BASE = 1e9;
const EMPLOYEE_MULT = 1.06;
const SALES_BOTS = "ABC SalesBots";
const SALES_BASE = 1e9;
const SALES_MULT = 1.07;
const PROJECT_INSIGHT = "Project Insight";
const INSIGHT_BASE = 5e9;
const INSIGHT_MULT = 1.07;
const SMART_STORAGE = "Smart Storage";
const SMART_FACTORIES = "Smart Factories";
const DRONES_TRANSPORT = "Drones - Transport"; // research: warehouse storage x1.5 (ResearchMap.ts)
const STORAGE_RESEARCH_MULT = 1.5;
const OFFICES_SCRIPT = "Corp/corp-offices.js"; // T19 owns the office APIs + job ratios

// §19.4.2 p76 product-division split, 19 parts (the 4/23 Wilson+Advert share is removed by the daemon, T06).
const STATS_SHARE = 8 / 19;
const OFFICE_SHARE = 8 / 19;
const RAW_SHARE = 1 / 19;
const SALES_SHARE = 1 / 19;
const INSIGHT_SHARE = 1 / 19;
// §19.4.2 p77 support division: warehouse : office = 10 : 90.
const SUPPORT_WAREHOUSE_SHARE = 0.1;
const SUPPORT_OFFICE_SHARE = 0.9;
const BOOST_TARGET_SLACK = 1.01; // skip the top-up unless a target beats the stored amount by this much
const FUNDS_CAP = 0.9; // §1.1: the "debt" buys may not take more than this share of the funds

const argsSchema = [
    ["division", ""], // the division to improve ("Ebon Stick", "Dark Soil", ...)
    ["budget", 0], // money for this run; the daemon (T06) / T11 own the amount
    ["support", false], // false = product division (19-part split), true = support division (10:90)
    ["round", 3], // investment round: recorded in the log line, the ratios are the same for every round
    ["mat-ratio", 0.8], // fraction of each warehouse used for boost materials (CONTEXT §6: round 3+ = 0.8)
    ["product-city", "Sector-12"], // the city whose office develops the products (T13's --product-city)
];

export function autocomplete(data, _) {
    data.flags(argsSchema);
    return [];
}

/** The five product-division shares of a budget (§19.4.2 p76). They sum to `budget`. Pure. **/
export function productShares(budget) {
    return {
        stats: budget * STATS_SHARE,
        office: budget * OFFICE_SHARE,
        raw: budget * RAW_SHARE,
        salesBot: budget * SALES_SHARE,
        projectInsight: budget * INSIGHT_SHARE,
    };
}

/** The support-division 10:90 split of a budget (§19.4.2 p77). They sum to `budget`. Pure. **/
export function supportShares(budget) {
    return { warehouse: budget * SUPPORT_WAREHOUSE_SHARE, office: budget * SUPPORT_OFFICE_SHARE };
}

/** Target level for one employee-stat upgrade when the four upgrades split the stats share equally. Pure. **/
export function statTarget(fromLevel, statsBudget) {
    return maxAffordableLevel(EMPLOYEE_BASE, EMPLOYEE_MULT, fromLevel, statsBudget / 4);
}

/** Scale the boost-material targets down so the missing quantity costs at most `funds * FUNDS_CAP` at the live
 * market prices (§1.1). A target is never pushed below what is already stored. Pure (no ns).
 * @param {Record<string, number[]>} targets per city, BOOST_MATERIALS order @param {Record<string, number[]>} storedByCity
 * @param {Record<string, number[]>} priceByCity @param {number} funds
 * @returns {{targets: Record<string, number[]>, clipped: boolean}} **/
export function capBoostTargets(targets, storedByCity, priceByCity, funds) {
    const cap = Math.max(0, funds) * FUNDS_CAP;
    let cost = 0;
    for (const city of Object.keys(targets))
        targets[city].forEach((target, i) => {
            cost += Math.max(0, target - storedByCity[city][i]) * priceByCity[city][i];
        });
    if (cost <= cap) return { targets, clipped: false };
    const factor = cap / cost;
    const scaled = {};
    for (const city of Object.keys(targets))
        scaled[city] = targets[city].map((target, i) => storedByCity[city][i] + Math.max(0, target - storedByCity[city][i]) * factor);
    return { targets: scaled, clipped: true };
}

/** Current warehouse level of a city, 1 when it has no warehouse yet (the optimizer takes one `whFrom`; the
 * reference reads Sector-12 and assumes the ladder is uniform). **/
function currentWarehouseLevel(ns, division, city) {
    return ns.corporation.hasWarehouse(division, city) ? ns.corporation.getWarehouse(division, city).level : 1;
}

/** The industry's four boost factors at runtime, never a hard-coded per-industry table (CONTEXT §4b). **/
function boostFactors(ns, division) {
    const industry = ns.corporation.getIndustryData(ns.corporation.getDivision(division).industry);
    return [industry.aiCoreFactor ?? 0, industry.hardwareFactor ?? 0, industry.realEstateFactor ?? 0, industry.robotFactor ?? 0];
}

/** "30" when every value is equal, "30-36" otherwise. **/
function rangeLabel(values) {
    if (values.length === 0) return "-";
    const min = Math.min(...values);
    const max = Math.max(...values);
    return min === max ? String(min) : `${min}-${max}`;
}

/** Step 5 (always last): re-buy the boost materials at the §8.3.2 optimum for the warehouses as they are NOW
 * - i.e. after step 3 grew them. Only tops up when a target beats the stored amount (BOOST_TARGET_SLACK), and
 * clips the cost to FUNDS_CAP of the funds. T03 buys per-second and always clears the orders (§1.1). **/
async function restockBoostMaterials(ns, cfg, cities, factors) {
    const smartStorage = ns.corporation.getUpgradeLevel(SMART_STORAGE);
    const researchMult = ns.corporation.hasResearched(cfg.division, DRONES_TRANSPORT) ? STORAGE_RESEARCH_MULT : 1;
    const targets = {};
    const storedByCity = {};
    const priceByCity = {};
    let needed = false;
    for (const city of cities) {
        targets[city] = optimalBoostMaterials(factors, warehouseSize(currentWarehouseLevel(ns, cfg.division, city), smartStorage, researchMult) * cfg.matRatio);
        storedByCity[city] = [];
        priceByCity[city] = [];
        BOOST_MATERIALS.forEach((material, i) => {
            const current = ns.corporation.getMaterial(cfg.division, city, material);
            storedByCity[city][i] = current.stored;
            priceByCity[city][i] = current.marketPrice;
            if (targets[city][i] > current.stored * BOOST_TARGET_SLACK) needed = true;
        });
    }
    if (!needed) {
        corpLog(ns, `${cfg.division}: boost materials already at target - no top-up`);
        return;
    }
    const funds = ns.corporation.getCorporation().funds;
    const capped = capBoostTargets(targets, storedByCity, priceByCity, funds);
    if (capped.clipped) corpLog(ns, `${cfg.division}: boost-material cost exceeds ${FUNDS_CAP * 100}% of ${formatMoney(funds)} - targets scaled down (§1.1)`, "WARN");
    await stockBoostMaterials(ns, cfg.division, capped.targets);
}

/** Product division: stats (8/19) -> ABC SalesBots + Project Insight (1/19 each) -> raw production (1/19)
 * -> offices (8/19, delegated to T19) -> boost materials (not part of the budget). **/
async function improveProductDivision(ns, cfg, cities, factors) {
    const shares = productShares(cfg.budget);
    const parts = [];
    let spent = 0;

    // 1. employee stat upgrades, a quarter of the 8/19 share each (§19.4.2 p76; reference 1657-1690)
    for (const name of EMPLOYEE_UPGRADES) {
        const res = ensureUpgrade(ns, name, statTarget(ns.corporation.getUpgradeLevel(name), shares.stats), shares.stats / 4);
        spent += res.spent;
    }
    parts.push(`stats ${EMPLOYEE_UPGRADES.map((name) => ns.corporation.getUpgradeLevel(name)).join("/")}`);

    // 2. ABC SalesBots (+1% sales) and Project Insight (+5% RP): one 19th each
    const bots = ensureUpgrade(ns, SALES_BOTS, maxAffordableLevel(SALES_BASE, SALES_MULT, ns.corporation.getUpgradeLevel(SALES_BOTS), shares.salesBot), shares.salesBot);
    const insight = ensureUpgrade(ns, PROJECT_INSIGHT, maxAffordableLevel(INSIGHT_BASE, INSIGHT_MULT, ns.corporation.getUpgradeLevel(PROJECT_INSIGHT), shares.projectInsight), shares.projectInsight);
    spent += bots.spent + insight.spent;
    parts.push(`bots ${bots.level} insights ${insight.level}`);

    // 3. raw production: the §9.2 optimizer over (Smart Storage, Smart Factories, warehouse level) for 1/19.
    // Warehouse levels are the same target in every city; the per-city cap is the share left over / cities.
    const ssFrom = ns.corporation.getUpgradeLevel(SMART_STORAGE);
    const sfFrom = ns.corporation.getUpgradeLevel(SMART_FACTORIES);
    const whFrom = currentWarehouseLevel(ns, cfg.division, cfg.productCity);
    const researchMult = ns.corporation.hasResearched(cfg.division, DRONES_TRANSPORT) ? STORAGE_RESEARCH_MULT : 1;
    const plan = bestStorageFactoryWarehouse(shares.raw, { ssFrom, sfFrom, whFrom, factors, matRatio: cfg.matRatio, researchStorageMult: researchMult, cities: cities.length });
    if (plan === null) {
        parts.push("no affordable storage/factory/warehouse plan");
    } else {
        const ss = ensureUpgrade(ns, SMART_STORAGE, plan.smartStorage, shares.raw);
        const sf = ensureUpgrade(ns, SMART_FACTORIES, plan.smartFactories, shares.raw - ss.spent);
        const whCap = (shares.raw - ss.spent - sf.spent) / cities.length;
        let whTo = whFrom;
        for (const city of cities) {
            const res = ensureWarehouse(ns, cfg.division, city, plan.warehouse, whCap);
            spent += res.spent;
            if (res.level > whTo) whTo = res.level;
        }
        spent += ss.spent + sf.spent;
        parts.push(`SS ${ssFrom}→${ss.level} SF ${sfFrom}→${sf.level} WH ${whFrom}→${whTo}`);
    }

    // 4. offices: the 8/19 share goes to T19 (its office APIs stay in that process). T14 sets OFFER_PREP_FILE
    // to "1" while it switches the product division around for an offer - leave the offices alone then.
    if (ns.read(OFFER_PREP_FILE).trim() === "1") {
        parts.push("offices skipped (T14 offer prep)");
    } else {
        const res = await runWorker(ns, OFFICES_SCRIPT, ["--division", cfg.division, "--budget", String(Math.floor(shares.office)), "--mode", "product", "--round", String(cfg.round), "--product-city", cfg.productCity]);
        parts.push(`offices ${formatMoney(shares.office)}→T19`);
        if (!res.ok) corpLog(ns, `${cfg.division}: ${OFFICES_SCRIPT} did not run (${res.reason})`, "WARN");
    }

    // 5. boost materials: last, because their target is the warehouse size step 3 just changed (§8)
    await restockBoostMaterials(ns, cfg, cities, factors);

    corpLog(ns, `improve ${cfg.division}: spent ${formatMoney(spent)} of ${formatMoney(cfg.budget)} [${parts.join(", ")}]`);
}

/** Support division: warehouses (10%, per city) -> offices (90%, T19) -> boost materials. **/
async function improveSupportDivision(ns, cfg, cities, factors) {
    const shares = supportShares(cfg.budget);
    const perCity = shares.warehouse / cities.length;
    const from = [];
    const to = [];
    let spent = 0;
    for (const city of cities) {
        const level = currentWarehouseLevel(ns, cfg.division, city);
        const res = ensureWarehouse(ns, cfg.division, city, maxAffordableWarehouseLevel(level, perCity), perCity);
        spent += res.spent;
        from.push(level);
        to.push(res.level);
    }
    const res = await runWorker(ns, OFFICES_SCRIPT, ["--division", cfg.division, "--budget", String(Math.floor(shares.office)), "--mode", "support", "--round", String(cfg.round)]);
    if (!res.ok) corpLog(ns, `${cfg.division}: ${OFFICES_SCRIPT} did not run (${res.reason})`, "WARN");

    await restockBoostMaterials(ns, cfg, cities, factors);

    corpLog(ns, `improve ${cfg.division} (support): spent ${formatMoney(spent)} of ${formatMoney(cfg.budget)} [WH ${rangeLabel(from)}→${rangeLabel(to)}, offices ${formatMoney(shares.office)}→T19]`);
}

/** @param {NS} ns @param {ReturnType<typeof argsSchema>} cfg **/
async function run(ns, cfg) {
    const corp = ns.corporation.getCorporation();
    if (!corp.divisions.includes(cfg.division)) {
        corpLog(ns, `no "${cfg.division}" division (have ${corp.divisions.join(", ")}) - nothing to improve`, "ERROR");
        return;
    }
    const cities = getCities(ns);
    const factors = boostFactors(ns, cfg.division);
    if (cfg.support) await improveSupportDivision(ns, cfg, cities, factors);
    else await improveProductDivision(ns, cfg, cities, factors);
}

/** @param {NS} ns **/
export async function main(ns) {
    const options = getConfiguration(ns, argsSchema);
    if (!options || (await instanceCount(ns)) > 1) return;
    ns.disableLog("ALL");
    const cfg = {
        division: String(options.division),
        budget: Number(options.budget),
        support: !!options.support,
        round: Number(options.round),
        matRatio: Number(options["mat-ratio"]),
        productCity: String(options["product-city"]),
    };
    if (!cfg.division) {
        corpLog(ns, "nothing to do: --division is empty (the daemon passes it, T06)", "ERROR");
        return;
    }
    if (!(cfg.budget > 0)) {
        corpLog(ns, `nothing to do: --budget is ${cfg.budget} (the daemon passes it, T06)`, "ERROR");
        return;
    }
    try {
        await run(ns, cfg);
    } catch (e) {
        // An uncaught throw is only reported in the terminal, where the daemon does not look (CONTEXT §3).
        corpLog(ns, `corp-improve stopped: ${e?.message ?? e}`, "ERROR");
    }
}

/** Offline self-check of the budget arithmetic and the funds cap (no ns at top level, so it loads under node:
 *   node --input-type=module -e "import('./Corp/corp-improve.js').then(m=>m.selfCheck())"
 * from the repo folder). Throws on the first failure. Proves arithmetic only, NOT in-game correctness. **/
export function selfCheck() {
    const near = (actual, expected, tol, label) => {
        if (!(Math.abs(actual - expected) <= tol)) throw new Error(`${label}: ${actual} != ${expected} (tol ${tol})`);
    };
    // 1. The nineteen parts of the product budget sum to the budget; the support 10:90 pair does too.
    const budget = 1e15;
    const p = productShares(budget);
    near(p.stats + p.office + p.raw + p.salesBot + p.projectInsight, budget, 1, "product shares sum");
    near(p.stats, (8 / 19) * budget, 1, "stats share");
    near(p.office, (8 / 19) * budget, 1, "office share");
    near(p.raw, budget / 19, 1, "raw share");
    const s = supportShares(budget);
    near(s.warehouse + s.office, budget, 1, "support shares sum");
    near(s.warehouse, 0.1 * budget, 1, "warehouse share");
    // 2. Each stat upgrade gets a quarter of the stats share; T02's ladder equals the closed form.
    const quarter = p.stats / 4;
    near(statTarget(0, p.stats), Math.floor(Math.log((quarter * (EMPLOYEE_MULT - 1)) / EMPLOYEE_BASE + 1) / Math.log(EMPLOYEE_MULT)), 0, "statTarget closed form");
    if (!(statTarget(5, p.stats) >= 5)) throw new Error("statTarget downgraded a level");
    if (statTarget(0, 0) !== 0) throw new Error("statTarget with no money should buy nothing");
    // 3. Funds cap: unchanged under the cap, scaled (never below stored) and within the cap over it.
    const price = { A: [1e9, 1e9, 1e9, 1e9] };
    const under = capBoostTargets({ A: [1000, 1000, 1000, 1000] }, { A: [0, 0, 0, 0] }, price, 1e15);
    if (under.clipped) throw new Error("cap clipped under the cap");
    near(under.targets.A[0], 1000, 0, "under the cap unchanged");
    const over = capBoostTargets({ A: [1000, 1000, 1000, 1000] }, { A: [0, 0, 0, 0] }, price, 1e9);
    if (!over.clipped) throw new Error("cap did not clip over the cap");
    near(over.targets.A.reduce((acc, qty) => acc + qty * 1e9, 0), 0.9e9, 1, "clipped total cost");
    const floored = capBoostTargets({ A: [1000, 1000, 1000, 1000] }, { A: [900, 900, 900, 900] }, price, 1e9);
    for (const qty of floored.targets.A) if (qty < 900) throw new Error(`cap pushed a target below stored: ${qty}`);
    return true;
}
