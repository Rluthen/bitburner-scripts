/** T17 - corp-research.js: the research-purchase SERVICE (one instance, loops on nextUpdate()).
 *
 * Why: the old corp.js bought no research at all. The guide makes Hi-Tech R&D Laboratory the top priority
 * (prerequisite of all others), the employee-stat research (Overclock/Sti.mu/Go-Juice/CPH4 Injections) raise
 * max energy/morale and stats, and the production research (Drones - Assembly, Self-Correcting Assemblers,
 * uPgrade: Fulcrum) multiplies output. It also warns that DEPLETING the RP pool wrecks product rating, so the
 * reference only buys when the pool is comfortably above the cost ("cost < 50% of the pool", tighter for the
 * per-name multipliers below).
 *
 * This is a port of the reference's buyResearchWithStandardStrategy + getResearchCostMultiplier
 * (corporation.ts 1077-1150) and the two priority lists (corporationUtils.ts 63-81):
 *   rounds 1-3: buy nothing (§19.4.2 p79: "don't buy any research in that round");
 *   round 4   : buy ONLY Hi-Tech R&D Laboratory, and it is fine to spend the whole pool on it (§19.4.2 p79) -
 *               the reference still gates it at cost x multiplier, which for the lab is x1 (product) / x2 (support);
 *   round >= 5: the whole list, stopping at the first item the pool cannot afford (`break`, to keep priority).
 * Support divisions (material industries, i.e. !makesProducts, e.g. Agriculture/Chemical) use a flat x2; product
 * divisions use a per-name multiplier (lab x1, employee-stat x5, Auto Drug x13.5, production x10, Drones x50,
 * Capacity xInf = never). Both lists deliberately exclude AutoBrew/AutoPartyManager/HRBuddy (guide: useless) and
 * Capacity.I/II (guide: not useful).
 *
 * Market-TA.I/.II are OFF by default: the ticket's T12 custom pricing replaces the built-in Market-TA.II.
 * `--buy-market-ta` is a user override that buys them after the priority list (each only when pool >= cost x 2).
 *
 * Guides refs §6.3 p26-29 (cost table + advice), §19.4.2 p79 (no research in round 3, only the lab in round 4).
 * Ported from catloversg/bitburner-scripts (MIT): logic only, plain JS.
 *
 * Distinct ns.corporation.* APIs referenced by THIS file (docs figures, NOT measured):
 *   0 GB : hasCorporation nextUpdate (a SERVICE cannot loop without them; ns.sleep is also 0 GB)
 *   10 GB: getCorporation getInvestmentOffer getDivision hasResearched getResearchCost
 *   20 GB: research
 *   => docs sum 70 GB + script base. Imports corp-lib.js (0 corporation APIs) and helpers.js
 *      (getConfiguration, instanceCount). Deliberately does NOT import Corp/corp-ops.js: importing that shared
 *      module would charge this light service the ~30-function union of its exports.
 *
 * Run: `run Corp/corp-research.js` (or let the daemon start it from round 4 - T07 R_RESEARCH).
 */
import { getConfiguration, instanceCount } from "../helpers.js";
import { corpLog } from "./corp-lib.js";

export const R_RND_LAB = "Hi-Tech R&D Laboratory";
/** §6.3 p27-28 priority order for material (support) divisions (§18.1 p68 needs the lab first). **/
export const RESEARCH_PRIORITIES_FOR_SUPPORT_DIVISION = [
    R_RND_LAB,
    "Overclock",
    "Sti.mu",
    "Automatic Drug Administration",
    "Go-Juice",
    "CPH4 Injections",
    "Self-Correcting Assemblers",
    "Drones",
    "Drones - Assembly",
    "Drones - Transport",
];
/** Product divisions get the same list plus uPgrade: Fulcrum. Capacity.I/II are excluded ("not useful"). **/
export const RESEARCH_PRIORITIES_FOR_PRODUCT_DIVISION = [...RESEARCH_PRIORITIES_FOR_SUPPORT_DIVISION, "uPgrade: Fulcrum"];
export const MARKET_TA_RESEARCHES = ["Market-TA.I", "Market-TA.II"]; // pre-req order: TA.I must come first
export const DUMMY_DIVISION_PREFIX = "z-"; // T20 dummy divisions (reference dummyDivisionNamePrefix)
const ACT_EVERY = 5; // act once per this many START cycles (the pool only moves as RP accrues)
const SERVICE_MULTIPLIER = 2; // material industries: "cost < 50% of the pool" (reference getResearchCostMultiplier)

/** Per-name pool multiplier for PRODUCT divisions (affordability = pool >= cost x multiplier).
 * Cost 5000, x1 = 5000 · Overclock 15000, x5 = 75000 · Auto Drug 10000, x13.5 = 135000 · Drones 5000, x50 =
 * 250000 - the ticket's golden table. Capacity.I/II are MAX_VALUE so they are never affordable. **/
const PRODUCT_MULTIPLIER = {
    [R_RND_LAB]: 1,
    Overclock: 5,
    "Sti.mu": 5,
    "Go-Juice": 5,
    "CPH4 Injections": 5,
    "Automatic Drug Administration": 13.5,
    "Self-Correcting Assemblers": 10,
    "Drones - Assembly": 10,
    "Drones - Transport": 10,
    "uPgrade: Fulcrum": 10,
    Drones: 50,
    "uPgrade: Capacity.I": Number.MAX_VALUE,
    "uPgrade: Capacity.II": Number.MAX_VALUE,
};

const argsSchema = [
    ["buy-market-ta", false], // OFF by default: T12's custom pricing replaces the built-in Market-TA
];

export function autocomplete(data, _) {
    data.flags(argsSchema);
    return [];
}

/** §6.3 affordability multiplier of a research name for the given division kind. `null` = not covered by the
 * standard strategy (Market-TA / Capacity handled by their own rules, never by the generic loop). Pure. **/
export function researchCostMultiplier(name, isProductDivision) {
    if (!isProductDivision) return SERVICE_MULTIPLIER;
    const multiplier = PRODUCT_MULTIPLIER[name];
    return multiplier === undefined ? null : multiplier;
}

/** §6.3 "only buy research if it costs less than half of the RP pool" (tighter per name for product divisions).
 * Pure, exported for the offline golden checks. @returns {boolean} **/
export function affordable(name, isProductDivision, pool, cost) {
    const multiplier = researchCostMultiplier(name, isProductDivision);
    if (multiplier === null) return false; // unknown / Market-TA / Capacity.I/II: never bought through this rule
    return pool >= cost * multiplier;
}

/** Priority list for one division: round 4 buys ONLY the lab; a later round buys the whole list for its kind. Pure. **/
export function priorityList(isProductDivision, offerRound) {
    if (offerRound === 4) return [R_RND_LAB];
    return isProductDivision ? RESEARCH_PRIORITIES_FOR_PRODUCT_DIVISION : RESEARCH_PRIORITIES_FOR_SUPPORT_DIVISION;
}

/** T20 creates dummy divisions named with this prefix; they must never get research. Pure. **/
export function isDummy(divisionName) {
    return divisionName.startsWith(DUMMY_DIVISION_PREFIX);
}

/** @param {NS} ns **/
export async function main(ns) {
    const options = getConfiguration(ns, argsSchema);
    if (!options || (await instanceCount(ns)) > 1) return; // one instance only, like every other service
    ns.disableLog("ALL");
    const buyMarketTa = !!options["buy-market-ta"];

    let cycle = 0;
    while (true) {
        if (!ns.corporation.hasCorporation()) {
            await ns.sleep(5000); // the daemon may start services before the corporation exists
            continue;
        }
        // nextUpdate() resolves with the state that JUST happened (CONTEXT §4);
        const state = await ns.corporation.nextUpdate();
        if (state !== "START") continue;
        cycle++;
        if (cycle % ACT_EVERY !== 0) continue; // act once per ~5 cycles; the RP pool only moves as RP accrues
        const offerRound = ns.corporation.getInvestmentOffer().round; // 5+ = every offer taken / corp is public
        if (offerRound <= 3) continue; // §19.4.2 p79: buy no research in round 3
        for (const division of ns.corporation.getCorporation().divisions) {
            if (isDummy(division)) continue;
            buyDivisionResearch(ns, division, offerRound, buyMarketTa);
        }
    }
}

/** Buy, in priority order, every research of one division that the pool can afford; stop at the first one it
 * cannot (`break`, so a lower-priority cheap item never jumps the queue). Exported for the offline selfCheck.
 * @returns {number} how many researches were bought **/
export function buyDivisionResearch(ns, divisionName, offerRound, buyMarketTa) {
    let division;
    try {
        division = ns.corporation.getDivision(divisionName); // makesProducts + the pool, one 10 GB read
    } catch {
        return 0; // the division vanished between the listing and this read
    }
    const isProduct = !!division.makesProducts;
    let pool = division.researchPoints;
    let bought = 0;

    for (const name of priorityList(isProduct, offerRound)) {
        if (hasResearched(ns, divisionName, name)) continue;
        const cost = researchCostOrNull(ns, divisionName, name); // null = name not in this industry's tree
        if (cost === null) continue;
        if (!affordable(name, isProduct, pool, cost)) break; // priority order: stop at the first unaffordable
        const poolBefore = pool;
        if (!doResearch(ns, divisionName, name)) continue;
        pool -= cost;
        bought++;
        corpLog(ns, `${divisionName}: researched ${name} (pool ${Math.round(poolBefore)} → ${Math.round(pool)})`, "MILESTONE");
    }

    // User override (default OFF): Market-TA, only once all four offers are taken; own rule is "cost < 50%".
    if (buyMarketTa && offerRound >= 5) {
        for (const name of MARKET_TA_RESEARCHES) {
            if (hasResearched(ns, divisionName, name)) continue;
            const cost = researchCostOrNull(ns, divisionName, name);
            if (cost === null || pool < cost * SERVICE_MULTIPLIER) break; // pre-req order: TA.II needs TA.I
            const poolBefore = pool;
            if (!doResearch(ns, divisionName, name)) break;
            pool -= cost;
            bought++;
            corpLog(ns, `${divisionName}: researched ${name} (pool ${Math.round(poolBefore)} → ${Math.round(pool)})`, "MILESTONE");
        }
    }
    return bought;
}

/** research() (Actions.ts) throws if the RP is short or a pre-req is missing; the affordability gate above
 * prevents the first, and the priority order satisfies the second - the try/catch is only a safety net. **/
function doResearch(ns, divisionName, name) {
    try {
        ns.corporation.research(divisionName, name);
        return true;
    } catch (err) {
        corpLog(ns, `${divisionName}: research('${name}') failed: ${err}`, "WARN");
        return false;
    }
}

/** hasResearched is a plain lookup, but the ticket asks for the guard (an unknown name / a stale division must
 * never kill the service). @returns {boolean} **/
function hasResearched(ns, divisionName, name) {
    try {
        return ns.corporation.hasResearched(divisionName, name);
    } catch {
        return false;
    }
}

/** getResearchCost throws "No research named '<name>'" when the name is not in the industry's research tree
 * (Corporation.ts 104-108) - e.g. a product-only name on a material industry. @returns {number|null} **/
function researchCostOrNull(ns, divisionName, name) {
    try {
        return ns.corporation.getResearchCost(divisionName, name);
    } catch {
        return null;
    }
}

// -------------------------------------------------------------------------------------------------------
// Offline self-check (no game, no ns). Proves the affordability arithmetic of the acceptance goldens and the
// priority-list wiring; NOT in-game correctness.
//   node --input-type=module -e "import('./Corp/corp-research.js').then(m=>m.selfCheck()).then(r=>console.log('selfCheck:',r))"

/** Runnable check (no game needed); throws on the first failure. **/
export function selfCheck() {
    const must = (ok, label) => {
        if (!ok) throw new Error(`selfCheck: ${label}`);
    };
    // Acceptance 1, verbatim (product-division multipliers: Overclock x5, Drones x50, Go-Juice x5, lab x1).
    must(affordable("Overclock", true, 74999, 15000) === false, "Overclock product pool 74999 < 75000");
    must(affordable("Overclock", true, 75000, 15000) === true, "Overclock product pool 75000");
    must(affordable("Overclock", false, 30000, 15000) === true, "Overclock support pool 30000 (x2)");
    must(affordable(R_RND_LAB, true, 5000, 5000) === true, "lab product pool 5000 (x1)");
    must(affordable("Drones", true, 249999, 5000) === false, "Drones product pool 249999 < 250000 (x50)");
    must(affordable("uPgrade: Capacity.I", true, 1e12, 20000) === false, "Capacity.I never affordable");
    must(affordable("Go-Juice", true, 124999, 25000) === false, "Go-Juice product pool 124999 < 125000 (x5)");
    // Support-division x2 on every name, and the golden pool-needed column of the ticket's table.
    must(researchCostMultiplier("Automatic Drug Administration", false) === 2, "support multiplier is flat x2");
    must(affordable("Sti.mu", false, 60000, 30000) === true && affordable("Sti.mu", false, 59999, 30000) === false, "Sti.mu support x2");
    must(affordable("Automatic Drug Administration", true, 135000, 10000) === true, "Auto Drug product x13.5");
    must(affordable("Drones - Transport", true, 300000, 30000) === true, "Drones - Transport product x10");
    // The lists themselves: support excludes the product-only names; product adds exactly Fulcrum; Capacity absent.
    must(RESEARCH_PRIORITIES_FOR_SUPPORT_DIVISION.length === 10, "support list length 10");
    must(RESEARCH_PRIORITIES_FOR_PRODUCT_DIVISION.length === 11, "product list length 11");
    must(!RESEARCH_PRIORITIES_FOR_SUPPORT_DIVISION.includes("uPgrade: Fulcrum"), "support excludes Fulcrum");
    must(RESEARCH_PRIORITIES_FOR_PRODUCT_DIVISION.at(-1) === "uPgrade: Fulcrum", "product ends with Fulcrum");
    must(!RESEARCH_PRIORITIES_FOR_PRODUCT_DIVISION.some((n) => n.startsWith("uPgrade: Capacity")), "no Capacity");
    must(!RESEARCH_PRIORITIES_FOR_PRODUCT_DIVISION.includes("AutoBrew"), "no AutoBrew/AutoParty");
    // Round 4 buys ONLY the lab (either division kind); later rounds get the full list.
    must(priorityList(true, 4).length === 1 && priorityList(true, 4)[0] === R_RND_LAB, "round 4 = lab only");
    must(priorityList(false, 4).length === 1, "round 4 support = lab only");
    must(priorityList(true, 5).length === 11 && priorityList(false, 5).length === 10, "round 5+ = full list");
    must(isDummy("z-Research") === true && isDummy("Ebon Stick") === false, "dummy prefix z-");
    return true;
}
