/** Shared, idempotent corporation actions for the Corp/ workers (T03).
 * Every function reads the current level/size first and buys only the delta, so re-running after a crash
 * never double-spends. Nothing here throws on "cannot afford": the unaffordable purchase is skipped and the
 * shortfall is logged.
 *
 * Distinct ns.corporation.* APIs referenced by this file (RAM is per distinct name, summed for every script
 * that imports it - see CONTEXT §4 for the docs figures):
 *   0 GB : nextUpdate
 *   10 GB: getCorporation getDivision getInvestmentOffer getMaterial getOffice getWarehouse getUpgradeLevel
 *          getUpgradeLevelCost getUnlockCost hasUnlock getHireAdVertCost getHireAdVertCount hasWarehouse
 *   20 GB: acceptInvestmentOffer buyMaterial buyTea cancelExportMaterial expandCity expandIndustry
 *          exportMaterial hireAdVert hireEmployee levelUpgrade purchaseUnlock purchaseWarehouse setJobAssignment
 *          throwParty upgradeOfficeSize upgradeWarehouse
 * Ported from catloversg/bitburner-scripts (MIT): corporationUtils.ts (buyUpgrade, buyAdvert, buyUnlock,
 * upgradeWarehouse, upgradeOffices/assignJobs, stockMaterials, waitUntilHavingEnoughResearchPoints,
 * createDivision, waitForOffer). Guide refs: §1.1 (clear per-second purchases), §4.1 (R&D first), §19.1.
 */
import { corpLog, getCities, BOOST_MATERIALS, JOBS, EXPORT_STRING } from "./corp-lib.js";
import { maxAffordableOfficeSize, maxAffordableWarehouseLevel } from "./corp-formulas.js";

// corpConstants (stable/src/Corporation/data/Constants.ts): warehouseInitialCost / officeInitialCost / teaCostPerEmployee
const WAREHOUSE_INITIAL_COST = 5e9;
const OFFICE_INITIAL_COST = 4e9;
const PARTY_COST = 500e3; // per employee, per throwParty call
const HAPPY_EPSILON = 0.5;

// "Unassigned" is not settable through setJobAssignment (it returns false), so it is never reset.
const SETTABLE_JOBS = Object.values(JOBS).filter((job) => job !== JOBS.none);

/** Short money label for log lines. Deliberately not ns.formatNumber: that would charge every importer for it. **/
function money(n) {
    if (n >= 1e12) return `${(n / 1e12).toFixed(2)}t`;
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}b`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}m`;
    return n.toFixed(0);
}

/** Live corporation funds. **/
function funds(ns) {
    return ns.corporation.getCorporation().funds;
}

/** Funds minus the reserve, never negative. @returns {number} **/
export function totalSpendableFunds(ns, reserve = 0) {
    return Math.max(0, funds(ns) - reserve);
}

/** Buy an unlock once. @returns {boolean} true when it is unlocked (already or just now) **/
export function ensureUnlock(ns, name, budgetCap = Infinity) {
    if (ns.corporation.hasUnlock(name)) return true;
    const cost = ns.corporation.getUnlockCost(name);
    const room = Math.min(budgetCap, funds(ns));
    if (cost > room) {
        corpLog(ns, `unlock "${name}" needs ${money(cost)}, only ${money(room)} available`, "WARN");
        return false;
    }
    ns.corporation.purchaseUnlock(name); // THROWS only when already unlocked, which was just checked
    corpLog(ns, `bought unlock "${name}" (${money(cost)})`);
    return true;
}

/** Level a corporation upgrade up to targetLevel, spending at most min(budgetCap, funds). Never downgrades.
 * @returns {{level: number, spent: number}} **/
export function ensureUpgrade(ns, name, targetLevel, budgetCap = Infinity) {
    let level = ns.corporation.getUpgradeLevel(name);
    let spent = 0;
    const toBuy = targetLevel - level;
    for (let i = 0; i < toBuy; i++) {
        const cost = ns.corporation.getUpgradeLevelCost(name);
        if (cost > Math.min(budgetCap - spent, funds(ns))) break;
        ns.corporation.levelUpgrade(name); // THROWS when unaffordable - the check above is what keeps us safe
        spent += cost;
        level++;
    }
    if (spent > 0) corpLog(ns, `upgrade "${name}" -> ${level} (+${money(spent)})`);
    else if (level < targetLevel) corpLog(ns, `cannot afford "${name}" ${level}->${targetLevel} (next ${money(ns.corporation.getUpgradeLevelCost(name))})`, "WARN");
    return { level, spent };
}

/** Advert level of a division, same contract as ensureUpgrade. @returns {{level: number, spent: number}} **/
export function ensureAdvert(ns, division, targetLevel, budgetCap = Infinity) {
    let level = ns.corporation.getHireAdVertCount(division);
    let spent = 0;
    const toBuy = targetLevel - level;
    for (let i = 0; i < toBuy; i++) {
        const cost = ns.corporation.getHireAdVertCost(division);
        if (cost > Math.min(budgetCap - spent, funds(ns))) break;
        ns.corporation.hireAdVert(division); // silent when unaffordable (game source), hence the check
        spent += cost;
        level++;
    }
    if (spent > 0) corpLog(ns, `${division}: advert -> ${level} (+${money(spent)})`);
    else if (level < targetLevel) corpLog(ns, `${division}: cannot afford advert ${level}->${targetLevel} (next ${money(ns.corporation.getHireAdVertCost(division))})`, "WARN");
    return { level, spent };
}

/** Buy the warehouse if the city has none, then level it up to targetLevel.
 * @returns {{level: number, spent: number}} level 0 when the city has no warehouse **/
export function ensureWarehouse(ns, division, city, targetLevel, budgetCap = Infinity) {
    let spent = 0;
    if (!ns.corporation.hasWarehouse(division, city)) {
        if (WAREHOUSE_INITIAL_COST > Math.min(budgetCap, funds(ns))) {
            corpLog(ns, `${division}/${city}: no warehouse and cannot afford one (${money(WAREHOUSE_INITIAL_COST)})`, "WARN");
            return { level: 0, spent: 0 };
        }
        const before = funds(ns);
        ns.corporation.purchaseWarehouse(division, city);
        if (!ns.corporation.hasWarehouse(division, city)) {
            corpLog(ns, `${division}/${city}: warehouse purchase refused`, "WARN");
            return { level: 0, spent: 0 };
        }
        spent = before - funds(ns);
        corpLog(ns, `${division}/${city}: bought warehouse (+${money(spent)})`);
    }
    let level = ns.corporation.getWarehouse(division, city).level;
    if (level < targetLevel) {
        const want = Math.min(targetLevel, maxAffordableWarehouseLevel(level, Math.min(budgetCap - spent, funds(ns))));
        if (want > level) {
            const before = funds(ns);
            ns.corporation.upgradeWarehouse(division, city, want - level);
            level = ns.corporation.getWarehouse(division, city).level; // what the game actually applied
            spent += before - funds(ns);
            corpLog(ns, `${division}/${city}: warehouse -> L${level} (+${money(spent)})`);
        }
    }
    if (level < targetLevel) corpLog(ns, `${division}/${city}: warehouse ${level}/${targetLevel} - cannot afford the next level`, "WARN");
    return { level, spent };
}

/** Grow an office to targetSize (as far as the budget reaches) and hire up to the resulting size.
 * New hires start Unassigned - assignJobs() is what places them into jobs.
 * @returns {{size: number, spent: number}} **/
export function ensureOfficeSize(ns, division, city, targetSize, budgetCap = Infinity) {
    let office = ns.corporation.getOffice(division, city);
    let spent = 0;
    if (office.size < targetSize) {
        const affordable = maxAffordableOfficeSize(office.size, Math.min(budgetCap, funds(ns)));
        if (affordable > office.size) {
            const before = funds(ns);
            ns.corporation.upgradeOfficeSize(division, city, Math.min(targetSize, affordable) - office.size);
            spent = before - funds(ns);
            office = ns.corporation.getOffice(division, city); // upgradeOfficeSize is silent when unaffordable
        }
    }
    const toHire = office.size - office.numEmployees;
    let hired = 0;
    for (let i = 0; i < toHire; i++) if (ns.corporation.hireEmployee(division, city)) hired++;
    if (spent > 0 || hired > 0) corpLog(ns, `${division}/${city}: office size ${office.size}, ${hired} hired (+${money(spent)})`);
    else if (office.size < targetSize) corpLog(ns, `${division}/${city}: office ${office.size}/${targetSize} - cannot afford to grow`, "WARN");
    return { size: office.size, spent };
}

/** Make a division exist in every listed city with a warehouse, employees and an office of officeSize.
 * expandIndustry/expandCity/expandWarehouse THROW on insufficient funds (game source), so they are caught here
 * and reported instead of killing the worker. @returns {boolean} **/
export function ensureDivision(ns, industry, name, cities, officeSize = 3, warehouseLevel = 1) {
    if (!ns.corporation.getCorporation().divisions.includes(name)) {
        try {
            ns.corporation.expandIndustry(industry, name);
            corpLog(ns, `created division "${name}" (${industry})`, "MILESTONE");
        } catch (e) {
            corpLog(ns, `cannot create division "${name}" (${industry}): ${e?.message ?? e}`, "WARN");
            return false;
        }
    }
    const division = ns.corporation.getDivision(name);
    for (const city of cities) {
        if (!division.cities.includes(city)) {
            if (OFFICE_INITIAL_COST > funds(ns)) {
                corpLog(ns, `cannot expand "${name}" into ${city}: needs ${money(OFFICE_INITIAL_COST)}`, "WARN");
                return false;
            }
            ns.corporation.expandCity(name, city); // THROWS when unaffordable - checked just above
            corpLog(ns, `${name}: expanded into ${city}`);
        }
        ensureWarehouse(ns, name, city, warehouseLevel);
        ensureOfficeSize(ns, name, city, officeSize);
    }
    return true;
}

/** Set one job count, turning the game's throw into a WARN. @returns {boolean} **/
function setJob(ns, division, city, job, count) {
    try {
        return ns.corporation.setJobAssignment(division, city, job, count) !== false;
    } catch (e) {
        corpLog(ns, `${division}/${city}: cannot set ${job}=${count}: ${e?.message ?? e}`, "WARN");
        return false;
    }
}

/** Put an office's employees into exactly the given jobs. setJobAssignment takes an absolute count per job and
 * throws when there are not enough Unassigned employees, so every job not listed is zeroed first.
 * @param {Record<string, number>} jobs e.g. {"Operations": 2, "Engineer": 9}
 * @returns {boolean} false when any assignment failed **/
export function assignJobs(ns, division, city, jobs) {
    const office = ns.corporation.getOffice(division, city);
    let ok = true;
    for (const job of SETTABLE_JOBS) if (!(job in jobs) && !setJob(ns, division, city, job, 0)) ok = false;
    for (const [job, count] of Object.entries(jobs)) if (!setJob(ns, division, city, job, count)) ok = false;
    const changed = ok && Object.entries(jobs).some(([job, count]) => office.employeeJobs[job] !== count);
    if (!ok) corpLog(ns, `${division}/${city}: some job assignments failed`, "WARN");
    else if (changed) corpLog(ns, `${division}/${city}: jobs ${JSON.stringify(jobs)}`);
    return ok;
}

/** assignJobs for every city. @returns {boolean} **/
export function assignJobsAllCities(ns, division, jobs) {
    let ok = true;
    for (const city of getCities(ns)) if (!assignJobs(ns, division, city, jobs)) ok = false;
    return ok;
}

/** Point the four boost materials at target quantities: per-second order = (target - stored) / 10 (§19.1:
 * "1000 Hardware = 100 units/second for 1 cycle"). Quantities already reached get a 0 order. **/
export function setBoostMaterialOrders(ns, division, city, targetQty) {
    BOOST_MATERIALS.forEach((material, i) => {
        const stored = ns.corporation.getMaterial(division, city, material).stored;
        ns.corporation.buyMaterial(division, city, material, Math.max(0, (targetQty[i] - stored) / 10));
    });
}

/** Stop buying the four boost materials. A per-second purchase left in place "buys forever until you run out
 * of storage space" (§1.1), so this always runs after stockBoostMaterials. **/
export function clearBoostMaterialOrders(ns, division, city) {
    for (const material of BOOST_MATERIALS) ns.corporation.buyMaterial(division, city, material, 0);
}

/** true when every listed material is at (or within 0.1% of) its target quantity. **/
function isStocked(ns, division, city, targetQty) {
    return BOOST_MATERIALS.every((material, i) => targetQty[i] <= 0 || ns.corporation.getMaterial(division, city, material).stored >= targetQty[i] * 0.999);
}

/** Stock the boost materials in every city and ALWAYS clear the purchase orders afterwards (guide §1.1).
 * @param {Record<string, number[]>} targetQtyByCity city -> [AI Cores, Hardware, Real Estate, Robots]
 * @returns {Record<string, number[]>} per-city missing quantities; empty when everything was stocked **/
export async function stockBoostMaterials(ns, division, targetQtyByCity, maxCycles = 6) {
    const entries = Object.entries(targetQtyByCity);
    try {
        for (let cycle = 0; cycle < maxCycles; cycle++) {
            const short = entries.filter(([city, targetQty]) => !isStocked(ns, division, city, targetQty));
            if (short.length === 0) break;
            for (const [city, targetQty] of short) setBoostMaterialOrders(ns, division, city, targetQty);
            await ns.corporation.nextUpdate(); // the PURCHASE state applies the per-second orders
        }
    } finally {
        for (const [city] of entries) clearBoostMaterialOrders(ns, division, city);
    }
    const shortfall = {};
    for (const [city, targetQty] of entries) {
        const stored = BOOST_MATERIALS.map((material) => ns.corporation.getMaterial(division, city, material).stored);
        if (!stored.every((s, i) => targetQty[i] <= 0 || s >= targetQty[i] * 0.999)) shortfall[city] = BOOST_MATERIALS.map((_, i) => Math.max(0, targetQty[i] - stored[i]));
    }
    if (Object.keys(shortfall).length > 0) corpLog(ns, `${division}: boost materials short after ${maxCycles} cycles in ${Object.keys(shortfall).join(", ")}`, "WARN");
    else corpLog(ns, `${division}: boost materials stocked in ${entries.length} cities, orders cleared`);
    return shortfall;
}

/** Wait until every listed division has reached its research point target. Note that jobs applied this cycle
 * only take effect at the next START (§4.1 FAQ). @returns {boolean} false on timeout **/
export async function waitForResearchPoints(ns, divisionTargets, maxCycles = Infinity) {
    const pending = () => Object.entries(divisionTargets).filter(([division, rp]) => ns.corporation.getDivision(division).researchPoints < rp);
    let cycles = 0;
    let waiting = pending();
    while (waiting.length > 0) {
        if (cycles >= maxCycles) {
            corpLog(ns, `gave up waiting for research points: ${waiting.map(([d, rp]) => `${d} ${Math.floor(ns.corporation.getDivision(d).researchPoints)}/${rp}`).join(", ")}`, "WARN");
            return false;
        }
        if (cycles % 10 === 0) corpLog(ns, `waiting for research points: ${waiting.map(([d, rp]) => `${d}->${rp}`).join(", ")}`);
        await ns.corporation.nextUpdate();
        cycles++;
        waiting = pending();
    }
    corpLog(ns, `research points reached: ${Object.keys(divisionTargets).join(", ")}`);
    return true;
}

/** Export `material` from srcDiv to dstDiv in every listed city. exportMaterial THROWS on a duplicate route,
 * so each route is cancelled first - that is what makes this safe to re-run. **/
export function setBothExports(ns, srcDiv, dstDiv, material, cities) {
    for (const city of cities) {
        ns.corporation.cancelExportMaterial(srcDiv, city, dstDiv, city, material);
        ns.corporation.exportMaterial(srcDiv, city, dstDiv, city, material, EXPORT_STRING);
    }
    corpLog(ns, `export ${material}: ${srcDiv} -> ${dstDiv} in ${cities.length} cities`);
}

/** Let the current investment offer grow: initCycles, then up to maxExtraCycles more while it keeps rising.
 * @returns {number} the offer funds left on the table (0 when there is none) **/
export async function waitForOffer(ns, initCycles, maxExtraCycles, expectedFunds) {
    for (let i = 0; i < initCycles; i++) await ns.corporation.nextUpdate();
    let offer = ns.corporation.getInvestmentOffer().funds;
    for (let i = 0; i < maxExtraCycles; i++) {
        await ns.corporation.nextUpdate();
        const now = ns.corporation.getInvestmentOffer().funds;
        if (i % 2 === 0) corpLog(ns, `offer ${money(now)}`);
        if (now < offer * 1.001) break; // it stopped growing - take what is on the table
        offer = now;
    }
    const final = ns.corporation.getInvestmentOffer().funds;
    if (final < expectedFunds) corpLog(ns, `offer ${money(final)} is below the expected ${money(expectedFunds)}`, "WARN");
    return final;
}

/** Accept the offer, but only when it is at least minFraction of what the guide expects (§19, FAQ p10:
 * "below 80% of the number means something is wrong"). @returns {boolean} **/
export function acceptOffer(ns, expectedFunds, minFraction = 0.8) {
    const offered = ns.corporation.getInvestmentOffer().funds;
    if (offered < minFraction * expectedFunds) {
        corpLog(ns, `refused offer ${money(offered)}: under ${Math.round(minFraction * 100)}% of the expected ${money(expectedFunds)}`, "ERROR");
        return false;
    }
    const accepted = ns.corporation.acceptInvestmentOffer();
    if (accepted) corpLog(ns, `accepted offer of ${money(offered)}`, "MILESTONE");
    else corpLog(ns, `acceptInvestmentOffer() returned false for ${money(offered)}`, "ERROR");
    return accepted;
}

/** One tea + party pass over a division. @returns {boolean} true when every office was already within
 * 0.5 of its max energy and morale BEFORE anything was bought **/
export function teaAndPartyOnce(ns, division) {
    let allHappy = true;
    for (const city of getCities(ns)) {
        const office = ns.corporation.getOffice(division, city);
        if (office.avgEnergy < office.maxEnergy - HAPPY_EPSILON) {
            ns.corporation.buyTea(division, city);
            allHappy = false;
        }
        if (office.avgMorale < office.maxMorale - HAPPY_EPSILON) {
            ns.corporation.throwParty(division, city, PARTY_COST);
            allHappy = false;
        }
    }
    return allHappy;
}

/** Tea + party every division until they are all happy (energy/morale recover over cycles, not instantly).
 * @returns {boolean} false on timeout **/
export async function waitForHappy(ns, divisions, maxCycles = 30) {
    for (let cycle = 0; cycle < maxCycles; cycle++) {
        const happy = divisions.map((division) => teaAndPartyOnce(ns, division)).every(Boolean);
        if (happy) return true;
        await ns.corporation.nextUpdate();
    }
    corpLog(ns, `still not at max energy/morale after ${maxCycles} cycles: ${divisions.join(", ")}`, "WARN");
    return false;
}

/** Minimal fake NS for the check below. Only the APIs corp-ops.js touches; `s` is asserted against.
 * It follows the game's own semantics for the two traps: setJobAssignment counts against
 * employeeNextJobs.Unassigned and THROWS when there are not enough, and a per-second purchase order moves
 * 10x its amount per cycle. **/
function mockNs() {
    const s = {
        funds: 100e9,
        upgrade: { level: 0, cost: (level) => [10e9, 20e9, 40e9][level] ?? Infinity },
        advert: { level: 0, cost: (level) => [1e9, 2.06e9][level] ?? Infinity },
        office: {
            size: 3,
            numEmployees: 3,
            employeeJobs: { Operations: 0, Engineer: 0, Business: 0, Management: 0, "Research & Development": 3, Intern: 0, Unassigned: 0 },
            nextJobs: { Operations: 0, Engineer: 0, Business: 0, Management: 0, "Research & Development": 3, Intern: 0, Unassigned: 0 },
        },
        warehouse: null,
        stored: { "AI Cores": 0, Hardware: 0, "Real Estate": 0, Robots: 0 },
        buyOrders: { "AI Cores": 0, Hardware: 0, "Real Estate": 0, Robots: 0 },
        hired: 0,
        logs: [],
    };
    return {
        enums: { CityName: { Aevum: "Aevum", "Sector-12": "Sector-12" } },
        getScriptName: () => "Corp/corp-ops.js",
        print: () => {},
        getPortHandle: () => ({ write: (line) => s.logs.push(line) }),
        corporation: {
            __state: s,
            getCorporation: () => ({ funds: s.funds, divisions: ["Dark Soil"] }),
            getUpgradeLevel: () => s.upgrade.level,
            getUpgradeLevelCost: () => s.upgrade.cost(s.upgrade.level),
            levelUpgrade: () => {
                const cost = s.upgrade.cost(s.upgrade.level);
                if (s.funds < cost) throw new Error("Could not upgrade: not enough money");
                s.funds -= cost;
                s.upgrade.level++;
            },
            getHireAdVertCount: () => s.advert.level,
            getHireAdVertCost: () => s.advert.cost(s.advert.level),
            hireAdVert: () => {
                const cost = s.advert.cost(s.advert.level);
                if (s.funds < cost) return;
                s.funds -= cost;
                s.advert.level++;
            },
            hasWarehouse: () => s.warehouse !== null,
            purchaseWarehouse: () => {
                if (s.funds < WAREHOUSE_INITIAL_COST || s.warehouse !== null) return;
                s.funds -= WAREHOUSE_INITIAL_COST;
                s.warehouse = { level: 1 };
            },
            getWarehouse: () => s.warehouse,
            upgradeWarehouse: (_div, _city, amt) => {
                const cost = 2e9 * amt;
                if (s.funds < cost) return;
                s.funds -= cost;
                s.warehouse.level += amt;
            },
            getOffice: () => ({
                city: "Sector-12",
                size: s.office.size,
                numEmployees: s.office.numEmployees,
                maxEnergy: 100,
                avgEnergy: 100,
                maxMorale: 100,
                avgMorale: 100,
                employeeJobs: { ...s.office.employeeJobs },
                employeeProductionByJob: {},
            }),
            upgradeOfficeSize: (_div, _city, increase) => {
                const cost = 4e9 * increase;
                if (s.funds < cost) return;
                s.funds -= cost;
                s.office.size += increase;
            },
            hireEmployee: () => {
                if (s.office.numEmployees >= s.office.size) return false;
                s.office.numEmployees++;
                s.office.employeeJobs.Unassigned++;
                s.office.nextJobs.Unassigned++;
                s.hired++;
                return true;
            },
            setJobAssignment: (_div, _city, job, amount) => {
                if (job === "Unassigned") return false;
                if (!Number.isInteger(amount) || amount < 0) throw new Error(`Invalid value for amount! Amount:'${amount}'`);
                const diff = amount - s.office.nextJobs[job];
                if (s.office.nextJobs.Unassigned < diff) throw new Error(`Unable to bring '${job}' employees to ${amount}. Requires ${diff} unassigned employees`);
                s.office.nextJobs.Unassigned -= diff;
                s.office.nextJobs[job] = amount;
                return true;
            },
            getMaterial: (_div, _city, material) => ({ stored: s.stored[material] }),
            buyMaterial: (_div, _city, material, amt) => {
                s.buyOrders[material] = amt;
            },
            nextUpdate: async () => {
                for (const material of BOOST_MATERIALS) s.stored[material] += 10 * Math.min(s.buyOrders[material], 5);
                return "START";
            },
        },
    };
}

/** Runnable check of the logic that does not need the game (mock NS above):
 *   node --input-type=module -e "import('./Corp/corp-ops.js').then(m=>m.selfCheck()).then(r=>console.log('selfCheck:',r))"
 * It proves the idempotence and budget behaviour only - arithmetic and control flow, NOT in-game proof. **/
export async function selfCheck() {
    const must = (ok, label) => {
        if (!ok) throw new Error(`selfCheck: ${label}`);
    };
    const ns = mockNs();
    const s = ns.corporation.__state;

    // Upgrade: 10+20+40 = 70b buys 3 levels, the cap is respected, and a second run spends nothing.
    const up1 = ensureUpgrade(ns, "Smart Storage", 3, 70e9);
    must(up1.level === 3 && up1.spent === 70e9, `upgrade ${JSON.stringify(up1)}`);
    const up2 = ensureUpgrade(ns, "Smart Storage", 3, 70e9);
    must(up2.level === 3 && up2.spent === 0, `upgrade idempotent ${JSON.stringify(up2)}`);
    const up3 = ensureUpgrade(ns, "Smart Storage", 5, 25e9);
    must(up3.level === 3 && up3.spent === 0, `upgrade cap ${JSON.stringify(up3)}`);
    must(ensureAdvert(ns, "Dark Soil", 1, 1e9).level === 1, "advert reaches level 1");

    // Office: grows to the target, hires exactly up to size, second run is a no-op.
    ensureOfficeSize(ns, "Dark Soil", "Sector-12", 5, 100e9);
    must(s.office.size === 5 && s.office.numEmployees === 5 && s.hired === 2, `office growth ${JSON.stringify(s.office)} hired ${s.hired}`);
    const office2 = ensureOfficeSize(ns, "Dark Soil", "Sector-12", 5, 100e9);
    must(office2.spent === 0 && s.hired === 2, `office idempotent ${JSON.stringify(office2)} hired ${s.hired}`);

    // Jobs: the unlisted R&D count is zeroed first, so the wanted jobs still fit in 5 employees.
    must(assignJobs(ns, "Dark Soil", "Sector-12", { Operations: 2, Engineer: 1, Business: 2 }), "assignJobs succeeds");
    must(
        s.office.nextJobs["Research & Development"] === 0 && s.office.nextJobs.Operations === 2 && s.office.nextJobs.Business === 2 && s.office.nextJobs.Unassigned === 0,
        `assignJobs ${JSON.stringify(s.office.nextJobs)}`,
    );
    must(assignJobs(ns, "Dark Soil", "Sector-12", { Operations: 99 }) === false, "assignJobs reports the game's throw");

    // Warehouse: bought when missing (5b), leveled, idempotent.
    const wh1 = ensureWarehouse(ns, "Dark Soil", "Aevum", 3, 100e9);
    must(wh1.level === 3 && wh1.spent === WAREHOUSE_INITIAL_COST + 4e9, `warehouse ${JSON.stringify(wh1)}`);
    must(ensureWarehouse(ns, "Dark Soil", "Aevum", 3, 100e9).spent === 0, "warehouse idempotent");

    // Boost materials: (20-0)/10 = 2/second → 20 units in one cycle, then the order is cleared.
    const stocked = await stockBoostMaterials(ns, "Dark Soil", { "Sector-12": [20, 0, 0, 0] }, 6);
    must(s.stored["AI Cores"] === 20 && Object.keys(stocked).length === 0, `stocked ${s.stored["AI Cores"]} shortfall ${JSON.stringify(stocked)}`);
    must(s.buyOrders["AI Cores"] === 0, "stocked run cleared the purchase order");
    // Timeout path: the target is unreachable in 2 cycles → shortfall reported, orders cleared anyway (§1.1).
    const short = await stockBoostMaterials(ns, "Dark Soil", { "Sector-12": [1e6, 0, 0, 0] }, 2);
    must(short["Sector-12"] !== undefined && s.buyOrders["AI Cores"] === 0, `shortfall ${JSON.stringify(short)} order ${s.buyOrders["AI Cores"]}`);

    return true;
}
