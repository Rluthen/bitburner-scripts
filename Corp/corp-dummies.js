/** T20 - Corp/corp-dummies.js: create dummy Restaurant divisions to inflate the valuation and the
 * round-3/4 investment offer (JOB). The daemon's T06 dummy rule launches it with `--budget` alone.
 *
 * §17.2 p63: pre-IPO valuation = (1e10 + Funds/3 + AssetDelta*315000) * (12th root of 1.1)^NumberOfOfficesAndWarehouses,
 * and §17.3 p64: that exponent "can be increased by creating dummy division [...] an easy way to get higher
 * offer in round 3+". §18.5 p71: use Restaurant (startingCost 10e9; Spring Water also costs 10e9 but is a
 * "newbie trap"), expand to the 6 cities, buy the 6 warehouses, and invest in NOTHING else (no staff, no
 * upgrades, no Advert). Each dummy adds 6 offices + 6 warehouses = 12 to the exponent, i.e. x1.1, so the
 * 17 dummies that fit in BN3's 20-division cap (3 are real) are worth x1.1^17 = x5.054 of offer.
 *
 * A dummy costs 55e9, not 65e9: the game's Division constructor gives every new division a Sector-12 office
 * (size 3, officeInitialSize) AND warehouse (level 1, warehouseInitialSize) for free, and createDivision
 * charges only `startingCost` (Corporation/Actions.ts, Corporation/Division.ts) - so only 5 offices
 * (5 x 4e9 officeInitialCost) and 5 warehouses (5 x 5e9 warehouseInitialCost) are bought. Same 5-not-6
 * accounting as CONTEXT §6's forced round-1 cost of 85e9. purchaseOffice (expandCity) THROWS when the city
 * already has an office or the funds are short; purchaseWarehouse silently no-ops in both of those cases,
 * so this job buys one city at a time and checks the LIVE funds itself (concurrent services T05/T16 spend
 * between cycles) rather than trusting the number it read at the start.
 *
 * Distinct ns.corporation.* APIs referenced by THIS file (docs figures, CONTEXT §4; NOT measured - `mem`):
 *   10 GB: getCorporation getDivision
 *   20 GB: expandIndustry expandCity purchaseWarehouse
 *   => 2 x 10 GB + 3 x 20 GB = 80 GB for the corporation API alone. Deliberately no Corp/corp-ops.js import:
 *      that shared module would charge this job its whole ~470 GB getter/action union (same reason T15
 *      inlines its two buy loops). Also 0 GB: ns.read of T08's /Temp/corp-bn.txt for the BN's division cap.
 * Guide refs: §17.2 p63, §17.3 p64, §18.5 p71, §2 FAQ p10 (20 divisions in BN3), §19.4 p76 (rounds 3/4).
 * Ported from catloversg/bitburner-scripts (MIT): corporationUtils.ts createDummyDivisions - logic only.
 *
 * Run: `run Corp/corp-dummies.js --budget 1e12`
 */
import { formatMoney, getConfiguration } from "../helpers.js";
import { BN_FILE, alreadyRunning, corpLog, getCities } from "./corp-lib.js";

const DUMMY_PREFIX = "z-"; // reference `dummyDivisionNamePrefix`; T06 gates on names starting with "z-"
const INDUSTRY = "Restaurant"; // §18.5 p71
const MAX_DIVISIONS_BN3 = 20; // §2 FAQ p10: "What's the maximum number of divisions? In BN3 it's 20."
const CITIES_BN3 = 6; // Sector-12 + 5; every new division already owns Sector-12's office and warehouse
const RESTAURANT_STARTING_COST = 10e9; // IndustryData.ts (BN3: seed money only)
const OFFICE_COST = 4e9; // Corporation/data/Constants.ts officeInitialCost
const WAREHOUSE_COST = 5e9; // Corporation/data/Constants.ts warehouseInitialCost
const LOG_EVERY = 5; // CONTEXT §3: <= ~10 log lines per burst, the port queue holds 50

const argsSchema = [
    ["budget", 0], // money this run may spend; 0 = half the funds (§18.5: "if the budget is tight, [...] later")
    ["max-divisions", MAX_DIVISIONS_BN3], // total division cap; T08's profile clamps it down for other BNs
    ["keep-free", 0], // slots to leave unused at the end (the daemon passes 0)
];

export function autocomplete(data, _) {
    data.flags(argsSchema);
    return [];
}

/** Name of dummy division `index`: z-00, z-01, ... (reference: prefix + 2-digit index). Pure.
 * @param {number} index @returns {string} **/
export function dummyName(index) {
    return DUMMY_PREFIX + String(index).padStart(2, "0");
}

/** Cost of ONE fresh dummy division: 10e9 Restaurant + 5 offices + 5 warehouses = 55e9. The 6th office and
 * 6th warehouse are Sector-12's, created free with the division. Pure.
 * @param {number} [cityCount] cities in the game (6 in BN3, where CITIES_BN3 supplies the default)
 * @returns {number} **/
export function dummyCost(cityCount = CITIES_BN3) {
    return RESTAURANT_STARTING_COST + (cityCount - 1) * (OFFICE_COST + WAREHOUSE_COST);
}

/** Valuation multiplier of `count` dummy divisions (§17.2 p63): each adds 12 offices+warehouses to the
 * (12th root of 1.1) exponent, so one dummy = x1.1 and 17 of them = x5.054. Pure.
 * @param {number} count @returns {number} **/
export function valuationBoost(count) {
    return 1.1 ** count;
}

/** How many NEW dummy divisions fit in this run: bounded by the free division slots and by the money
 * (`budget`, or half the funds when no budget is given). Pure - `selfCheck()` pins the ticket's table.
 * @param {number} funds @param {number} budget @param {number} existing current division count
 * @param {number} maxDivisions total cap (not the number of dummies!) @param {number} [cost]
 * @returns {number} **/
export function affordableDummies(funds, budget, existing, maxDivisions, cost = dummyCost()) {
    const money = Math.min(Math.max(0, funds), budget > 0 ? budget : Math.max(0, funds) * 0.5);
    return Math.max(0, Math.min(maxDivisions - existing, Math.floor(money / cost)));
}

/** The BN's division cap from T08's profile (/Temp/corp-bn.txt, 0 GB ns.read); BN3's 20 when that file is
 * missing. Only ever LOWERs the configured cap, so a BN with fewer slots (BN13: 8) cannot make the run
 * throw "too many divisions" half-way through. @param {NS} ns @returns {number} **/
function maxDivisionsFromBn(ns) {
    try {
        const n = JSON.parse(ns.read(BN_FILE)).maxDivisionsApprox;
        return Number.isFinite(n) && n > 0 ? Math.round(n) : MAX_DIVISIONS_BN3;
    } catch {
        return MAX_DIVISIONS_BN3;
    }
}

/** @param {NS} ns @param {{budget:number, maxDivisions:number, keepFree:number}} cfg **/
function run(ns, cfg) {
    const corp = ns.corporation.getCorporation();
    const existing = corp.divisions; // names only; the same getter is re-read per dummy for live funds (below)
    const cities = getCities(ns);
    const cost = dummyCost(cities.length);
    const cap = cfg.budget > 0 ? cfg.budget : corp.funds * 0.5; // §18.5: no budget -> half the funds
    const target = Math.max(0, Math.min(cfg.maxDivisions, maxDivisionsFromBn(ns)) - cfg.keepFree);
    const room = target - existing.length;
    const plan = affordableDummies(corp.funds, cfg.budget, existing.length, target, cost);

    if (room <= 0) {
        corpLog(ns, `${existing.length} divisions already at the ${target}-division cap - no dummy possible`, "INFO");
        return;
    }
    if (plan <= 0) {
        corpLog(ns, `no dummy division fits: ${formatMoney(cost)} each, ${formatMoney(Math.min(corp.funds, cap))} available (${room} slot(s) free)`, "WARN");
        return;
    }

    let added = 0;
    let spent = 0;
    for (let i = 0; added < room; i++) {
        const name = dummyName(i);
        if (existing.includes(name)) continue; // idempotence: a division name is never created twice
        // Live funds, not the figure read above: T05/T16 spend every cycle while this job runs, and a
        // warehouse bought with too little money silently does nothing (see the header).
        const funds = ns.corporation.getCorporation().funds;
        if (funds < cost || spent + cost > cap) break; // one dummy at a time, 55e9 each
        ns.corporation.expandIndustry(INDUSTRY, name); // THROWS if the name/cap/funds would be violated
        // Sector-12 is already there (Division.ts constructor), so the loop pays for the other cities only.
        // expandCity throws on an existing city, hence the check against the division's own city list.
        const division = ns.corporation.getDivision(name);
        for (const city of cities)
            if (!division.cities.includes(city)) {
                ns.corporation.expandCity(name, city);
                ns.corporation.purchaseWarehouse(name, city);
            }
        added++;
        spent += cost;
        if (added % LOG_EVERY === 0) corpLog(ns, `${added} dummy divisions built (${formatMoney(spent)} of ${formatMoney(cap)})`);
    }

    const total = existing.length + added;
    const dummies = existing.filter((n) => n.startsWith(DUMMY_PREFIX)).length + added;
    corpLog(
        ns,
        `${added} dummy division(s) this run: ${total}/${target} divisions, ${formatMoney(spent)} spent (${formatMoney(cost)} each), valuation x${valuationBoost(dummies).toFixed(4)} (§17.2)`,
        total >= target ? "MILESTONE" : "INFO",
    );
}

/** @param {NS} ns **/
export async function main(ns) {
    const options = getConfiguration(ns, argsSchema);
    if (!options || alreadyRunning(ns)) return;
    ns.disableLog("ALL");
    const cfg = {
        budget: Number(options.budget),
        maxDivisions: Number(options["max-divisions"]),
        keepFree: Number(options["keep-free"]),
    };
    try {
        run(ns, cfg);
    } catch (e) {
        // An uncaught throw is only reported in the terminal, where the daemon does not look (CONTEXT §3).
        corpLog(ns, `corp-dummies stopped: ${e?.message ?? e}`, "ERROR");
    }
}

/** Offline self-check of the pure parts (this file has no top-level ns use, so it loads under node):
 *   node --input-type=module -e "import('./Corp/corp-dummies.js').then(m=>m.selfCheck())"
 * from the repo folder. Ticket T20 acceptance 1, verbatim. Arithmetic only, NOT in-game correctness. **/
export function selfCheck() {
    const eq = (got, want, label) => {
        if (got !== want) throw new Error(`${label}: got ${got}, want ${want}`);
    };
    const near = (got, want, tol, label) => {
        if (!(Math.abs(got - want) <= tol)) throw new Error(`${label}: got ${got}, want ${want} (tol ${tol})`);
    };
    // 1. One dummy costs 10e9 + 5 x 4e9 offices + 5 x 5e9 warehouses; 17 of them are 0.935e12.
    eq(dummyCost(), 55e9, "dummyCost");
    eq(dummyCost(6), 55e9, "dummyCost(6)");
    eq(17 * dummyCost(), 0.935e12, "17 dummies cost");
    eq(valuationBoost(17), 1.1 ** 17, "valuationBoost(17)");
    near(valuationBoost(17), 5.05447, 1e-6, "x1.1^17");
    near(valuationBoost(5), 1.61051, 1e-6, "x1.1^5");
    near(valuationBoost(10), 2.593742, 1e-6, "x1.1^10");
    // 2. affordableDummies(funds, budget, existing, max) - the ticket's five rows.
    eq(affordableDummies(1e12, 1e12, 3, 20), 17, "(1e12,1e12,3,20)");
    eq(affordableDummies(2e12, 1e12, 3, 20), 17, "(2e12,1e12,3,20)");
    eq(affordableDummies(2e12, 2e12, 3, 20), 17, "(2e12,2e12,3,20)");
    eq(affordableDummies(50e9, 1e12, 3, 20), 0, "(50e9,1e12,3,20)");
    eq(affordableDummies(200e9, 1e12, 3, 20), 3, "(200e9,1e12,3,20)");
    // 3. Never negative, never more than the cap, and the plan always fits in the money it was given.
    eq(affordableDummies(0, 0, 3, 20), 0, "no funds");
    eq(affordableDummies(-1e9, 0, 3, 20), 0, "negative funds");
    eq(affordableDummies(1e15, 1e15, 20, 20), 0, "cap reached");
    eq(affordableDummies(1e15, 1e15, 0, 2), 2, "capped by max-divisions");
    for (const [funds, budget, existing] of [[1e12, 1e12, 3], [200e9, 1e12, 3], [1e12, 300e9, 8], [200e9, 0, 3]]) {
        const n = affordableDummies(funds, budget, existing, 20);
        if (n * dummyCost() > Math.min(funds, budget > 0 ? budget : funds * 0.5)) throw new Error(`plan exceeds the money: ${n} for ${funds}/${budget}`);
    }
    // 4. Names (the reference's z-00, z-01, ... numbering the daemon's "z-" check depends on).
    eq(dummyName(0), "z-00", "z-00");
    eq(dummyName(7), "z-07", "z-07");
    eq(dummyName(17), "z-17", "z-17");
    return true;
}
