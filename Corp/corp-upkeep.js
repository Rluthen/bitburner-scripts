/** T05 - corp-upkeep.js: the tea + party SERVICE (one instance, loops on nextUpdate forever).
 *
 * Replaces the hard-coded 99 / 99.5 loop at the bottom of the old corp.js. Thresholds come from the office
 * itself (office.maxEnergy / office.maxMorale), so they keep working after "Go-Juice" (max energy +) or
 * "Sti.mu" (max morale +) raise the maxima to ~110 (guide §10.3). One big party is less cost-effective than
 * several small ones, so the per-employee cost stays at the guide's 500e3 and the party is just repeated
 * every cycle. Offices with < 9 employees do not lose energy/morale at all; the check is still cheap.
 *
 * Distinct ns.corporation.* APIs referenced by THIS file (docs figure, NOT measured). Deliberately does NOT
 * import Corp/corp-ops.js: importing it would charge this light service the union of ~30 corporation APIs.
 *   0 GB : nextUpdate hasCorporation
 *   10 GB: getOffice
 *   20 GB: buyTea throwParty            docs total = 50 GB  (corp-lib.js / corp-formulas.js add 0 cor APIs)
 *
 * Guide refs: §10.3 (energy/morale, tea 500e3/employee, party costPerEmployee/1e6, "buy every cycle in round 3+"),
 * §19.1 (mandatory), FAQ p12 (recommended over wasting employees on Intern). Ported logic:
 * corporationUtils.ts buyTeaAndThrowParty (epsilon 0.5, party 500000, loop on nextUpdate).
 */
import { getConfiguration, instanceCount } from "../helpers.js";
import { corpLog, getCities, STATE_FILE } from "./corp-lib.js";

const PARTY_COST = 500e3; // per employee, per party (§10.3); same for tea (game Constants teaCostPerEmployee)
const TEA_COST = 500e3;
const argsSchema = [
    ["epsilon", 0.5], // buy tea / throw party once the office average is this far below its maximum
    ["party-cost", PARTY_COST],
];

/** §10.3: act once the average drops `eps` below the office's own maximum (100, or ~110 after Go-Juice/Sti.mu). **/
export function needsTea(avgEnergy, maxEnergy, eps = 0.5) {
    return avgEnergy < maxEnergy - eps;
}
export function needsParty(avgMorale, maxMorale, eps = 0.5) {
    return avgMorale < maxMorale - eps;
}

export function autocomplete(data, _) {
    data.flags(argsSchema);
    return [];
}

/** @param {NS} ns **/
export async function main(ns) {
    const options = getConfiguration(ns, argsSchema);
    if (!options || (await instanceCount(ns)) > 1) return;
    ns.disableLog("ALL");
    const eps = Number(options.epsilon);
    const partyCost = Number(options["party-cost"]);

    let cycles = 0;
    const stats = { tea: 0, party: 0, spent: 0 };
    while (true) {
        if (!ns.corporation.hasCorporation()) {
            await ns.sleep(5000); // the daemon may start services before the corporation exists
            continue;
        }
        // nextUpdate() resolves with the state that JUST happened, and energy/morale are recalculated in
        // START, so act right after it - the tea/party then takes effect on the following START (§10.3).
        const state = await ns.corporation.nextUpdate();
        if (state !== "START") continue;
        cycles++;
        const divisions = divisionsFrom(ns.read(STATE_FILE));
        if (!divisions) continue; // no snapshot yet: skip this cycle rather than pay 10 GB for getCorporation
        const cities = getCities(ns);
        for (const division of divisions) {
            for (const city of cities) {
                const office = ns.corporation.getOffice(division, city);
                if (needsTea(office.avgEnergy, office.maxEnergy, eps)) {
                    ns.corporation.buyTea(division, city);
                    stats.tea++;
                    stats.spent += office.numEmployees * TEA_COST;
                }
                if (needsParty(office.avgMorale, office.maxMorale, eps)) {
                    ns.corporation.throwParty(division, city, partyCost);
                    stats.party++;
                    stats.spent += office.numEmployees * partyCost;
                }
            }
        }
        if (cycles % 20 === 0) {
            corpLog(ns, `tea=${stats.tea} party=${stats.party} spent≈${(stats.spent / 1e6).toFixed(1)}m`);
            stats.tea = 0;
            stats.party = 0;
            stats.spent = 0;
        }
    }
}

/** Division names from the T04 snapshot, or null when it is missing / unreadable / corp-less. **/
function divisionsFrom(text) {
    try {
        const snap = JSON.parse(text);
        return snap && snap.hasCorp && Array.isArray(snap.corp?.divisions) ? snap.corp.divisions : null;
    } catch {
        return null;
    }
}

/** Offline check of the decision rule and the snapshot reader (no game, no ns):
 *   node --input-type=module -e "import('./Corp/corp-upkeep.js').then(m=>m.selfCheck()).then(r=>console.log('selfCheck:',r))"
 * Proves the boolean logic only - NOT in-game correctness. **/
export function selfCheck() {
    const must = (ok, label) => {
        if (!ok) throw new Error(`selfCheck: ${label}`);
    };
    must(needsTea(99.4, 100, 0.5) === true, "(99.4,100,0.5) -> true");
    must(needsTea(99.6, 100, 0.5) === false, "(99.6,100,0.5) -> false");
    must(needsTea(109.4, 110, 0.5) === true, "(109.4,110,0.5) -> true (Go-Juice)");
    must(needsParty(99.4, 100, 0.5) === true && needsParty(99.6, 100, 0.5) === false, "party mirrors tea");
    must(needsTea(99.6, 100, 0.3) === true && needsTea(99.6, 100, 0.5) === false, "epsilon is honoured");
    must(divisionsFrom('{"hasCorp":true,"corp":{"divisions":["Dark Soil"]}}')?.length === 1, "divisions from snapshot");
    must(divisionsFrom("") === null && divisionsFrom("{}") === null, "missing/corrupt snapshot -> null");
    return true;
}
