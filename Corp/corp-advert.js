/** T15 - Corp/corp-advert.js: buy Wilson Analytics and Advert with one budget (JOB).
 *
 * Wilson multiplies what every Advert level does (§13.3) and is NOT retroactive, so it is bought first and
 * paid out of last cycle's profit ("buy it as soon as possible, but not too soon" - rounds 1-2 are too
 * expensive, §4.3 p21). Advert is bought with a share of the funds once the profit focus (1e18/s) is
 * reached, and with the T02 optimizer (§13.4) below it - that is the same 4/23 budget the daemon splits off.
 * The daemon (T06 rule) launches this file with `--budget` only, at most once every `improveEvery` cycles.
 *
 * Distinct ns.corporation.* APIs referenced by THIS file (docs figures from CONTEXT §4, NOT measured - `mem`):
 *   10 GB: getCorporation getDivision getHireAdVertCost getHireAdVertCount getIndustryData getUpgradeLevel
 *   20 GB: hireAdVert levelUpgrade
 *   => 6 x 10 GB + 2 x 20 GB = 100 GB for the corporation API alone, on top of helpers.js (~16 GB for
 *      getConfiguration / formatMoney) and corp-lib.js / corp-formulas.js (0 corporation APIs).
 *      Deliberately does NOT import Corp/corp-ops.js: that shared module would charge this job its whole
 *      getter/action union (~470 GB docs). The Wilson price is therefore computed with T02's formula, which
 *      is exactly the game's (Corporation/helpers.ts calculateUpgradeCost = base * mult^level for one level).
 * Guide refs: §13.1 p49 (stop at max awareness/popularity), §13.2 p49 (Advert base 1e9, mult 1.06, awareness
 * `(a + 3m)*1.005m`, popularity `(p + m)*(1+rand(1,3)/200)*m`, m = WilsonBenefit * ResearchAdvertMult),
 * §13.3 p50 (Wilson: multiplier on Advert's benefit, price doubles every level, 4e9 * 2^n), §13.4 p50-51
 * (optimizer tables: < 10e9 -> Advert 8 alone for 9.897e9; < 20e9 -> Advert 11 + Wilson 1 best by factor,
 * nearly-equally-good cheaper 2nd best), §4.3 p21 + §19.4.2 p76 ("buy Wilson with last cycle's profit;
 * after ~1e18/s, after buying Wilson, use at least 20% of current funds to buy Advert" - the guide uses up
 * to 60%), §4.2 p19 (support divisions get no Advert after round 2 - this job only touches the product one).
 * Ported from catloversg/bitburner-scripts (MIT): corporation.ts buyWilsonAndAdvert (~707-731) - logic only.
 */
import { formatMoney, getConfiguration } from "../helpers.js";
import { TOB_NAME, alreadyRunning, corpLog } from "./corp-lib.js";
import { advertCost, bestWilsonAdvert, maxAffordableAdvertLevel, maxAffordableLevel, upgradeCost } from "./corp-formulas.js";

const WILSON = "Wilson Analytics";
const WILSON_BASE = 4e9; // Corporation/data/CorporationUpgrades.ts: WilsonAnalytics basePrice 4e9, priceMult 2
const WILSON_MULT = 2;
const CYCLE_SECONDS = 10; // one corporation cycle is 10 s (1 s with bonus time) = one profit cycle
const MIN_ADVERT_SHARE = 0.2; // §4.3 p21: "after buying Wilson, use at least 20% of current funds"
const MAX_CAPS = Number.MAX_VALUE; // §13.1 p49: awareness/popularity cap; a division is capped when either hits it

const argsSchema = [
    ["budget", 0], // total this run may spend (T06's advertBudget, passed as a string)
    ["division", TOB_NAME], // the product division whose Advert is bought; support divisions get none (§4.2)
    ["advert-share", 0.2], // share of the funds for Advert after the profit focus (guide: up to 0.6)
    ["profit-focus", 1e18], // thresholdOfFocusingOnAdvert §4.3 p21
    ["last-profit", -1], // last cycle's profit; < 0 = the live per-second profit * CYCLE_SECONDS
];

export function autocomplete(data, _) {
    data.flags(argsSchema);
    return [];
}

/** What this run should buy, computed purely from the state it read (the offline table in the report calls
 * this under node; the file has no top-level ns use).
 *
 * Budget accounting: the Wilson step may spend at most min(budget, last cycle's profit) and the Advert step
 * only what is left of `budget`, so the plan always costs <= budget and every purchase is an "ensure target"
 * recomputed from the LIVE level - a relaunch after a crash can never pay twice for the same level and can
 * never walk a level back.
 * It is deliberately not a strict no-op when the same budget is re-run on a state it already spent: a 1.06
 * cost ladder keeps ~6% of its path affordable, so a second run does buy the next level (measured: 8.985b
 * then 9.331b for a 10e9 budget). "Spend this cycle's share on the next levels" is not idempotent by
 * construction - it would need memory of what this cycle already bought. The daemon provides that instead:
 * T06 runs at most ONE job per cycle and re-derives the budget from a fresh snapshot before any relaunch,
 * so the same-budget-twice window does not exist in its cadence.
 *
 * @param {{wilson:number, advert:number, advertFactor:number, funds:number, profit:number, lastProfit?:number}} state
 * @param {{budget:number, advertShare:number, profitFocus:number}} cfg
 * @returns {{focus:boolean, wilsonTarget:number, advertTarget:number, cost:number}} exact intended spend **/
export function planAdvert(state, cfg) {
    // §4.3 p21: Wilson is paid from last cycle's profit, never from the division budget, and never over the
    // run's budget. One cycle = CYCLE_SECONDS, so the live per-second figure is scaled to one cycle.
    const profitBudget = state.lastProfit >= 0 ? state.lastProfit : Math.max(0, state.profit) * CYCLE_SECONDS;
    const wilsonTarget = maxAffordableLevel(WILSON_BASE, WILSON_MULT, state.wilson, Math.min(cfg.budget, profitBudget));
    const wilsonCost = upgradeCost(WILSON_BASE, WILSON_MULT, state.wilson, wilsonTarget);
    const remaining = cfg.budget - wilsonCost;
    if (state.profit >= cfg.profitFocus) {
        // §4.3 p21: past the threshold Advert is worth a share of the funds outright; the budget still wins.
        const advertRoom = Math.min(remaining, Math.max(cfg.advertShare, MIN_ADVERT_SHARE) * state.funds);
        const advertTarget = maxAffordableAdvertLevel(state.advert, advertRoom);
        return { focus: true, wilsonTarget, advertTarget, cost: wilsonCost + advertCost(state.advert, advertTarget) };
    }
    // Below the threshold the optimizer picks the pair out of what is left (§13.4; T02's brute force).
    const best = bestWilsonAdvert(remaining, wilsonTarget, state.advert, state.advertFactor);
    return { focus: false, wilsonTarget: best.wilson, advertTarget: best.advert, cost: wilsonCost + best.cost };
}

/** Buy Wilson levels up to plan.wilsonTarget. `levelUpgrade` THROWS when unaffordable, so the next level's
 * price (the game's own 4e9 * 2^level) is checked against the budget and the funds first.
 * @returns {{level:number, spent:number}} **/
function buyWilson(ns, fromLevel, targetLevel, budgetLeft) {
    let level = fromLevel;
    let spent = 0;
    while (level < targetLevel) {
        const cost = upgradeCost(WILSON_BASE, WILSON_MULT, level, level + 1);
        if (cost > Math.min(budgetLeft - spent, ns.corporation.getCorporation().funds)) break;
        try {
            ns.corporation.levelUpgrade(WILSON);
        } catch (e) {
            corpLog(ns, `${WILSON}: the game refused level ${level + 1} (${e?.message ?? e}) - stopping`, "WARN");
            break;
        }
        spent += cost;
        level++;
    }
    return { level, spent };
}

/** Buy Advert levels up to targetLevel at the game's own prices; `hireAdVert` is silent when unaffordable
 * (Corporation.ts), so the price is checked the same way as Wilson's.
 * @returns {{level:number, spent:number}} **/
function buyAdvert(ns, division, fromLevel, targetLevel, budgetLeft) {
    let level = fromLevel;
    let spent = 0;
    while (level < targetLevel) {
        const cost = ns.corporation.getHireAdVertCost(division);
        if (cost > Math.min(budgetLeft - spent, ns.corporation.getCorporation().funds)) break;
        ns.corporation.hireAdVert(division);
        spent += cost;
        level++;
    }
    return { level, spent };
}

/** @param {NS} ns @param {ReturnType<typeof argsSchema>} cfg **/
function run(ns, cfg) {
    const corp = ns.corporation.getCorporation();
    if (!corp.divisions.includes(cfg.division)) {
        corpLog(ns, `no "${cfg.division}" division (have ${corp.divisions.join(", ")}) - nothing to advertise`, "ERROR");
        return;
    }
    const division = ns.corporation.getDivision(cfg.division);
    if (division.awareness === MAX_CAPS || division.popularity === MAX_CAPS) {
        corpLog(ns, `${cfg.division}: awareness/popularity reached the cap (§13.1) - no more Wilson or Advert`, "INFO");
        return;
    }
    const profit = corp.revenue - corp.expenses; // per second - the figure T06 compares to the focus threshold
    const wilson = ns.corporation.getUpgradeLevel(WILSON);
    const advert = ns.corporation.getHireAdVertCount(cfg.division);
    // §4b: read the industry's own advertisingFactor at runtime, never a hard-coded per-industry table.
    const advertFactor = Number(ns.corporation.getIndustryData(division.industry).advertisingFactor ?? 0);
    const plan = planAdvert({ wilson, advert, advertFactor, funds: corp.funds, profit, lastProfit: cfg.lastProfit }, cfg);

    const wilsonBought = buyWilson(ns, wilson, plan.wilsonTarget, cfg.budget);
    const advertBought = buyAdvert(ns, cfg.division, advert, plan.advertTarget, cfg.budget - wilsonBought.spent);
    const spent = wilsonBought.spent + advertBought.spent;

    corpLog(ns, `Wilson ${wilson}→${wilsonBought.level}, Advert ${advert}→${advertBought.level}, spent ${formatMoney(spent)} (profit ${formatMoney(profit)}/s)`);
    if (wilsonBought.level < plan.wilsonTarget || advertBought.level < plan.advertTarget) {
        corpLog(
            ns,
            `${plan.focus ? "advert focus" : "optimizer"} wanted Wilson ${plan.wilsonTarget}, Advert ${plan.advertTarget} for ${formatMoney(plan.cost)} - budget or funds ran out`,
            "WARN",
        );
    }
}

/** @param {NS} ns **/
export async function main(ns) {
    const options = getConfiguration(ns, argsSchema);
    if (!options || alreadyRunning(ns)) return;
    ns.disableLog("ALL");
    const cfg = {
        budget: Number(options.budget),
        division: String(options.division),
        advertShare: Number(options["advert-share"]),
        profitFocus: Number(options["profit-focus"]),
        lastProfit: Number(options["last-profit"]),
    };
    if (!(cfg.budget > 0) || !cfg.division) {
        corpLog(ns, `nothing to do: budget=${cfg.budget}, division="${cfg.division}" - the daemon passes --budget (T06)`, "ERROR");
        return;
    }
    try {
        run(ns, cfg);
    } catch (e) {
        // An uncaught throw is only reported in the terminal, where the daemon does not look (CONTEXT §3).
        corpLog(ns, `corp-advert stopped: ${e?.message ?? e}`, "ERROR");
    }
}

/** Offline self-check of the decision logic (pure: `node --input-type=module -e "import('./Corp/corp-advert.js').then(m=>m.selfCheck())"`
 * from the repo folder). Throws on the first failure. Pins the guide-golden pair, one measured Tobacco row,
 * and the budget invariant that the daemon relies on. **/
export function selfCheck() {
    const tobacco = { wilson: 0, advert: 8, advertFactor: 0.2, funds: 1e12, profit: 0 };
    const cfg = { budget: 0, advertShare: 0.2, profitFocus: 1e18 };
    const near = (a, b, tol, label) => {
        if (!(Math.abs(a - b) <= tol)) throw new Error(`${label}: ${a} != ${b}`);
    };
    // The guide's §13.4 golden that T02 pins, through this file's plan: budget 9.9e9 buys Advert 8, no Wilson.
    const g = planAdvert({ ...tobacco, advert: 0 }, { ...cfg, budget: 9.9e9 });
    if (g.wilsonTarget !== 0 || g.advertTarget !== 8) throw new Error(`§13.4 9.9e9: got ${JSON.stringify(g)}`);
    near(g.cost, 9.897e9, 1e6, "§13.4 9.9e9 cost");
    // Measured Tobacco rows (offline table in the report): the budget is never exceeded and Advert is monotone.
    const row1t = planAdvert(tobacco, { ...cfg, budget: 1e12 });
    if (row1t.wilsonTarget !== 6 || row1t.advertTarget !== 65) throw new Error(`1e12 row: got ${JSON.stringify(row1t)}`);
    let previous = tobacco.advert;
    for (const budget of [10e9, 20e9, 1e12, 1e18]) {
        const p = planAdvert(tobacco, { ...cfg, budget });
        if (p.cost > budget) throw new Error(`plan exceeds its budget: ${JSON.stringify(p)} for ${budget}`);
        if (p.wilsonTarget < tobacco.wilson || p.advertTarget < previous) throw new Error(`downgraded: ${JSON.stringify(p)}`);
        previous = p.advertTarget;
    }
    // A relaunch (same budget, state as the first run left it) still has to fit in the budget: that, plus the
    // ensure-targets above, is the guarantee the daemon needs - not a no-op (see planAdvert's doc comment).
    const seen = planAdvert(tobacco, { ...cfg, budget: 1e12 });
    const relaunch = planAdvert({ ...tobacco, wilson: seen.wilsonTarget, advert: seen.advertTarget }, { ...cfg, budget: 1e12 });
    const relaunchCost =
        upgradeCost(WILSON_BASE, WILSON_MULT, seen.wilsonTarget, relaunch.wilsonTarget) +
        advertCost(seen.advertTarget, relaunch.advertTarget);
    if (relaunchCost > 1e12) throw new Error(`relaunch exceeds the budget: ${relaunchCost}`);
    // Profit focus: Advert is capped by max(advert-share, 20%) of the funds, Wilson by the budget.
    const focus = planAdvert({ ...tobacco, profit: 1e18, wilson: 5, advert: 0 }, { ...cfg, budget: 1e11 });
    if (!focus.focus) throw new Error("profit 1e18 should be past the focus threshold");
    if (focus.cost > 1e11) throw new Error(`focus plan exceeds the budget: ${JSON.stringify(focus)}`);
    const share = planAdvert({ ...tobacco, profit: 1e18, wilson: 0, advert: 0, funds: 1e12 }, { ...cfg, budget: 1e15 });
    near(share.cost - upgradeCost(WILSON_BASE, WILSON_MULT, 0, share.wilsonTarget), 2e11, 2e9, "advert share of the funds");
    // `last-profit` overrides the per-second figure scaled to one cycle (CYCLE_SECONDS).
    const byProfit = planAdvert({ ...tobacco, profit: 1e9, advert: 0 }, { ...cfg, budget: 1e12 });
    const byLast = planAdvert({ ...tobacco, profit: 1e9, lastProfit: 1e12, advert: 0 }, { ...cfg, budget: 1e12 });
    if (!(byLast.wilsonTarget > byProfit.wilsonTarget)) throw new Error(`last-profit not honoured: ${byProfit.wilsonTarget} / ${byLast.wilsonTarget}`);
    return true;
}
