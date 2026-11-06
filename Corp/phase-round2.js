/** T10 - Corp/phase-round2.js: round-2 JOB for BN3 - Export + Chemical support division + Agriculture upgrades,
 * then take offer 2 (guide §19.3). Runs to completion and exits; the daemon (corp.js, T07) launches it once
 * round 1 has accepted its offer and may relaunch it after a crash, so every step re-reads game state and only
 * buys the delta (T03's ensure* helpers).
 *
 * The round-2 deviations of the old corp.js (corp.js.og.js expandToChem, lines 148-217) this fixes:
 *   1. upgradeOfficeSize(Agriculture, 27) and upgradeOfficeSize(Chemical, 37) - ~900e9 of offices against an
 *      expected offer of 340-550e9 -> step 1 grows Agriculture 4 -> 8 only (§4.2 p20: 36.4e9 for 6 cities) and
 *      step 2 never touches the Chemical office (it is the SUPPORT division).
 *   2. no Smart Storage/Factories/Warehouse/Advert plan at all -> step 4 spends the rest of the funds through
 *      T02's bestStorageFactoryWarehouse (the guide's "run optimizer", §4.2 p20).
 *   3. never waited for research points -> step 5 waits for ~700 RP (Agriculture) / ~390 RP (Chemical), which
 *      §4.2 calls mandatory because the quality of Plants/Chemicals depends on RP.
 *   4. R&D=0 with 1 each of Eng/Ops/Biz -> step 7 uses the guide's §19.3.2 job counts.
 *   5. proportional boost-material split -> step 8 reads the industry factors at runtime (CONTEXT §4b) and uses
 *      the §8.3.2 optimum for each division's own warehouse space.
 *
 * Distinct ns.corporation.* APIs referenced (docs figures from CONTEXT §4, NOT measured - run `mem`):
 *   0 GB : hasCorporation nextUpdate
 *   10 GB: getIndustryData getOffice getUpgradeLevel getWarehouse, plus corp-ops.js: getCorporation getDivision
 *          getInvestmentOffer getMaterial getUpgradeLevelCost getUnlockCost hasUnlock getHireAdVertCost
 *          getHireAdVertCount hasWarehouse
 *   20 GB: sellMaterial setSmartSupply setSmartSupplyOption, plus corp-ops.js: acceptInvestmentOffer buyMaterial
 *          buyTea cancelExportMaterial expandCity expandIndustry exportMaterial hireAdVert hireEmployee
 *          levelUpgrade purchaseUnlock purchaseWarehouse setJobAssignment throwParty upgradeOfficeSize
 *          upgradeWarehouse
 *   => 14 x 10 GB + 19 x 20 GB = 520 GB for the corporation API alone, on top of the helpers.js (~16.4 GB),
 *      corp-lib.js (~1.4 GB) and corp-formulas.js (0 GB) unions. exported with `run Corp/phase-round2.js`.
 *
 * Guide refs: §4.2 p20 (round 2 = Export + Agriculture office 8/Advert ~8, Chemical as a support division,
 * "run optimizer", wait 700/390 RP), §19.3 p74 (the two phases), §9.2 p38 (the optimizer output), §18.2 p68
 * (export string `(IPROD+IINV/10)*(-1)`), §2 FAQ p11 ("use leftovers"), §8.6 p31 (the 0.76/0.95 mat ratios).
 * Ported from catloversg/bitburner-scripts (MIT): corporation.ts round2 (buyUnlock Export, upgradeOffices Agri,
 * createDivision Chemical 3/2, both export routes, buyAdvert 8, optimizeStorageAndFactory, RP wait,
 * buyAdvert(max affordable), assignJobs, stockMaterials, waitForOffer(15, 10, 11e12)).
 */
import { formatMoney, getConfiguration } from "../helpers.js";
import { AGRI_NAME, CHEM_NAME, alreadyRunning, corpLog, getCities, offerMode, readBnProfile, scaledOfferExpect } from "./corp-lib.js";
import { bestStorageFactoryWarehouse, maxAffordableAdvertLevel, optimalBoostMaterials, ratiosToCounts, warehouseSize } from "./corp-formulas.js";
import {
    acceptOffer,
    assignJobs,
    assignJobsAllCities,
    ensureAdvert,
    ensureDivision,
    ensureOfficeSize,
    ensureUnlock,
    ensureUpgrade,
    ensureWarehouse,
    setBothExports,
    stockBoostMaterials,
    waitForHappy,
    waitForOffer,
    waitForResearchPoints,
} from "./corp-ops.js";

const AGRI_INDUSTRY = "Agriculture";
const CHEM_INDUSTRY = "Chemical";
const AGRI_OFFICE_SIZE = 8; // §19.3.1: Agriculture 4 -> 8 in every city, i.e. +4 (never the old +27)
const CHEM_OFFICE_SIZE = 3; // §4.2: Chemical is a support division - office stays at 3
const CHEM_WAREHOUSE_LEVEL = 2; // §19.3.1: Chemical warehouse level 2 (~6.9e9 for 6 cities)
const ADVERT_TARGET = 8; // §19.3.1: Advert 8 for Agriculture, none for Chemical
const JOBS_AGRI = { Operations: 3, Engineer: 1, Business: 2, Management: 2, "Research & Development": 0 };
const JOBS_CHEM = { Operations: 1, Engineer: 1, Business: 1, "Research & Development": 0 };
// Round 1's job mix, restored only while this round waits for the Chemical division to become affordable:
// production comes from Ops/Eng/Mgmt (§9.1.1 getDivisionRawProduction returns 0 when they are all 0), so an
// office left entirely on R&D earns nothing and the round would never become affordable.
const JOBS_WHILE_WAITING = { Operations: 1, Engineer: 1, Business: 1, Management: 1, "Research & Development": 0 };
const OFFER_INIT_CYCLES = 15; // reference round2 waitForOffer(15, 10, 11e12)
const OFFER_EXTRA_CYCLES = 10;
const ROUND2_OFFER_EXPECT = 11e12; // the reference's round-2 expectation; a BN3 number, scaled by T08's offerScale

const argsSchema = [
    ["agri-only", false], // LOW mode's round 2: invest only in Agriculture and take offer 2 (no Export, no Chemical)
    ["offer-expect", null], // null => 11e12 (the reference's round-2 number) x the BitNode's offerScale (0 in LOW mode); the guide prints 14.1-14.9e12 (CONTEXT §6)
    ["agri-ratio", 0.76], // §8.6: fraction of an Agriculture warehouse used for boost materials (4522/5950)
    ["chem-ratio", 0.95], // §8.6: same for Chemical (665/700)
    ["rp-agri", 700], // §19.3.1: "waiting for 700 RP in Agriculture is enough"
    ["rp-chem", 390], // §19.3.1: 390 RP in Chemical
];

export function autocomplete(data, _) {
    data.flags(argsSchema);
    return [];
}

// Order of the Ops/Eng/Biz/Mgmt mixes used below. R&D is deliberately not part of a production mix
// (production is Ops+Eng+Mgmt, §9.1.1); setAllOnRnd() is what puts an office on research.
const PRODUCTION_JOB_ORDER = ["Operations", "Engineer", "Business", "Management"];

/** Put every office on a job mix scaled to the office's ACTUAL size. setJobAssignment takes an ABSOLUTE count
 * and throws when there are not enough Unassigned employees, so asking a size-4 office for JOBS_AGRI's 8
 * employees failed once per city - which is what happens on any node that cannot afford to grow the office
 * to 8 (and in an --agri-only round). R&D is zeroed: an office left entirely on R&D produces nothing. **/
function assignProductionJobs(ns, division, cities, jobs) {
    const total = PRODUCTION_JOB_ORDER.reduce((sum, job) => sum + (jobs[job] ?? 0), 0) || 1;
    const ratio = PRODUCTION_JOB_ORDER.map((job) => (jobs[job] ?? 0) / total);
    for (const city of cities) {
        const counts = ratiosToCounts(ratio, ns.corporation.getOffice(division, city).size);
        assignJobs(ns, division, city, Object.fromEntries(PRODUCTION_JOB_ORDER.map((job, i) => [job, counts[i]])));
    }
}

/** The four boost factors of an industry, in the fixed [AI Cores, Hardware, Real Estate, Robots] order.
 * Read at runtime, never hard-coded (CONTEXT §4b: the guide's Tobacco numbers differ from the game data). **/
function factorsOf(industry) {
    return [industry.aiCoreFactor ?? 0, industry.hardwareFactor ?? 0, industry.realEstateFactor ?? 0, industry.robotFactor ?? 0];
}

/** Put every employee of a division on R&D. The count is read back from the office, not assumed: if an office
 * could not be grown, assigning more than its size throws and leaves the staff Unassigned (zero RP). **/
function setAllOnRnd(ns, division, cities) {
    for (const city of cities) assignJobs(ns, division, city, { "Research & Development": ns.corporation.getOffice(division, city).size });
}

/** Built-in Smart Supply for one division with its input materials on "use leftovers" (FAQ p11: always choose
 * leftovers, so an exported material is topped up rather than bought on top of the import). Both calls THROW
 * without the unlock, which is why the caller checks hasUnlock first. **/
function turnOnSmartSupply(ns, division, cities, inputs) {
    for (const city of cities) {
        ns.corporation.setSmartSupply(division, city, true);
        for (const material of inputs) ns.corporation.setSmartSupplyOption(division, city, material, "leftovers");
    }
    corpLog(ns, `${division}: smart supply on in ${cities.length} cities, ${inputs.join("/")} = leftovers`);
}

/** Step 4: spend the rest of the funds on Smart Storage + Smart Factories + the Agriculture warehouse with
 * T02's optimizer - §4.2 p20 "run optimizer to find the best combination of them" (the old corp.js bought
 * nothing here). The Chemical warehouse is deliberately NOT part of this: it stays at level 2 (§19.3.1). **/
function buyStoragePlan(ns, cities, factors, cfg) {
    const budget = ns.corporation.getCorporation().funds;
    const plan = bestStorageFactoryWarehouse(budget, {
        ssFrom: ns.corporation.getUpgradeLevel("Smart Storage"),
        sfFrom: ns.corporation.getUpgradeLevel("Smart Factories"),
        whFrom: Math.min(...cities.map((city) => ns.corporation.getWarehouse(AGRI_NAME, city).level)),
        factors: factors,
        matRatio: cfg.agriRatio,
        cities: cities.length,
    });
    if (plan === null) {
        corpLog(ns, `${AGRI_NAME}: nothing in the storage/factory/warehouse list fits in ${formatMoney(budget)}`, "WARN");
        return;
    }
    corpLog(ns, `plan for ${formatMoney(budget)}: Smart Storage ${plan.smartStorage}, Smart Factories ${plan.smartFactories}, warehouse L${plan.warehouse} (${formatMoney(plan.cost)})`);
    ensureUpgrade(ns, "Smart Storage", plan.smartStorage);
    ensureUpgrade(ns, "Smart Factories", plan.smartFactories);
    for (const city of cities) ensureWarehouse(ns, AGRI_NAME, city, plan.warehouse);
}

/** Step 8: stock the boost materials at the §8.3.2 optimum for each division's ACTUAL warehouse space
 * (warehouseSize(level, Smart Storage) * that division's mat-ratio). `parts` is a [division, factors, ratio]
 * list, so the caller decides which divisions exist: an --agri-only round has no Chemical division yet and
 * getWarehouse would THROW for it. Stocked one after the other, never with Promise.all: T03's
 * stockBoostMaterials awaits nextUpdate() internally. **/
async function stockBoost(ns, cities, parts) {
    const ss = ns.corporation.getUpgradeLevel("Smart Storage");
    const space = (division, city, ratio) => warehouseSize(ns.corporation.getWarehouse(division, city).level, ss) * ratio;
    const targets = (division, factors, ratio) => Object.fromEntries(cities.map((city) => [city, optimalBoostMaterials(factors, space(division, city, ratio))]));
    for (const [division, factors, ratio] of parts) {
        const t = targets(division, factors, ratio);
        corpLog(ns, `${division}: boost for warehouse space ${space(division, cities[0], ratio).toFixed(1)} = ${t[cities[0]].join("/")} in ${cities.length} cities`);
        await stockBoostMaterials(ns, division, t);
    }
}

/** @param {NS} ns @param {ReturnType<typeof argsSchema>} cfg **/
async function run(ns, cfg) {
    const cities = getCities(ns);
    if (!ns.corporation.hasCorporation()) {
        corpLog(ns, "round 2 needs a corporation - run Corp/phase-round1.js first", "ERROR");
        return;
    }
    if (!ns.corporation.getCorporation().divisions.includes(AGRI_NAME)) {
        corpLog(ns, `round 2 needs the "${AGRI_NAME}" division from round 1`, "ERROR");
        return;
    }
    const agriIndustry = ns.corporation.getIndustryData(AGRI_INDUSTRY); // factors + materials at runtime (CONTEXT §4b)
    const chemIndustry = ns.corporation.getIndustryData(CHEM_INDUSTRY);
    const agriFactors = factorsOf(agriIndustry);
    const chemFactors = factorsOf(chemIndustry);

    // LOW mode's round 2 (`--agri-only` - the guide writer's "Round 2: invest in Agriculture. Take offer."):
    // the Agriculture investment IS this round. Export, the Chemical division, the export routes and the R&D
    // switch are all round-3 work below. Nothing here may put the offices on R&D: a round whose only job is to
    // earn has to keep producing (production is Ops+Eng+Mgmt, §9.1.1) or the funds never arrive.
    if (cfg.agriOnly) {
        ensureAdvert(ns, AGRI_NAME, ADVERT_TARGET);
        for (const city of cities) ensureOfficeSize(ns, AGRI_NAME, city, AGRI_OFFICE_SIZE);
        buyStoragePlan(ns, cities, agriFactors, cfg);
        assignProductionJobs(ns, AGRI_NAME, cities, JOBS_AGRI);
        await stockBoost(ns, cities, [[AGRI_NAME, agriFactors, cfg.agriRatio]]);
        await waitForOffer(ns, OFFER_INIT_CYCLES, OFFER_EXTRA_CYCLES, cfg.offerExpect);
        acceptOffer(ns, cfg.offerExpect);
        return;
    }

    // Step 1: Export first (the round's whole point), then Agriculture: Advert 8, office 4 -> 8.
    ensureUnlock(ns, "Export");
    ensureAdvert(ns, AGRI_NAME, ADVERT_TARGET);
    for (const city of cities) ensureOfficeSize(ns, AGRI_NAME, city, AGRI_OFFICE_SIZE);

    // Step 2: Chemical as the support division - office 3, warehouse 2, all on R&D, no Advert, no office growth.
    // Unaffordable is a WAIT here, not an error: §19.3 needs 490e9 for this round, and on a BitNode whose
    // CorporationValuation multiplier shrinks the round-1 offer below the division's fixed price (§17.3: the
    // offer scales with the multiplier, the 70e9 division + 5 offices/warehouses does not) the round has to
    // let the corporation earn it. Keeping Agriculture on production jobs while waiting is what makes that
    // possible - production is Ops/Eng/Mgmt (§9.1.1), so an office left on nothing but R&D earns nothing and
    // the round would never become affordable (the offer, §17.3, is driven by that same AssetDelta).
    if (!ensureDivision(ns, CHEM_INDUSTRY, CHEM_NAME, cities, CHEM_OFFICE_SIZE, CHEM_WAREHOUSE_LEVEL)) {
        assignProductionJobs(ns, AGRI_NAME, cities, JOBS_WHILE_WAITING);
        corpLog(
            ns,
            `${CHEM_NAME}: not affordable yet (${formatMoney(chemIndustry.startingCost)} for the division + 5 offices/warehouses, ${formatMoney(ns.corporation.getCorporation().funds)} in hand) - waiting, ${AGRI_NAME} kept producing`,
            "WARN",
        );
        return;
    }
    // Only now is the research wait worth starting: §19.3.1 wants 700/390 RP, and R&D costs the divisions
    // their production while it runs, so it must not start before the round can actually proceed.
    setAllOnRnd(ns, AGRI_NAME, cities);
    setAllOnRnd(ns, CHEM_NAME, cities);

    // Step 3: Plants Agriculture -> Chemical and Chemicals Chemical -> Agriculture in every city (§18.2
    // export string, T03 cancels each route first so this is re-runnable), and sell the leftover Chemicals.
    // exportMaterial THROWS without the Export unlock, so that is checked rather than assumed.
    if (ns.corporation.hasUnlock("Export")) {
        setBothExports(ns, AGRI_NAME, CHEM_NAME, "Plants", cities);
        setBothExports(ns, CHEM_NAME, AGRI_NAME, "Chemicals", cities);
    } else corpLog(ns, "Export unlock missing - skipping the Plants/Chemicals routes", "WARN");
    for (const city of cities) for (const material of chemIndustry.producedMaterials ?? []) ns.corporation.sellMaterial(CHEM_NAME, city, material, "MAX", "MP");

    buyStoragePlan(ns, cities, agriFactors, cfg); // step 4

    // Steps 5-6: energy/morale at max, then the mandatory RP wait (§4.2), then any leftover funds go into
    // more Agriculture Advert (the reference's second buyAdvert call).
    await waitForHappy(ns, [AGRI_NAME, CHEM_NAME]);
    await waitForResearchPoints(ns, { [AGRI_NAME]: cfg.rpAgri, [CHEM_NAME]: cfg.rpChem });
    ensureAdvert(ns, AGRI_NAME, maxAffordableAdvertLevel(ns.corporation.getHireAdVertCount(AGRI_NAME), ns.corporation.getCorporation().funds));

    assignProductionJobs(ns, AGRI_NAME, cities, JOBS_AGRI); // step 7: the §19.3.2 job counts, fitted to the office
    assignJobsAllCities(ns, CHEM_NAME, JOBS_CHEM);

    await stockBoost(ns, cities, [[AGRI_NAME, agriFactors, cfg.agriRatio], [CHEM_NAME, chemFactors, cfg.chemRatio]]); // step 8

    // Step 9: let the offer peak (15 cycles, then up to 10 more while it keeps rising), accept only within
    // 20% of the expected offer. T03 logs the MILESTONE on success and an ERROR on refusal; a refusal leaves
    // the phase at R2 and the daemon relaunches this job a few cycles later.
    await waitForOffer(ns, OFFER_INIT_CYCLES, OFFER_EXTRA_CYCLES, cfg.offerExpect);
    acceptOffer(ns, cfg.offerExpect);
}

/** @param {NS} ns **/
export async function main(ns) {
    const options = getConfiguration(ns, argsSchema);
    if (!options || alreadyRunning(ns)) return;
    ns.disableLog("ALL");
    const offerScale = Number(readBnProfile(ns).offerScale) || 1; // T08: the BitNode's CorporationValuation multiplier
    const cfg = {
        agriOnly: !!options["agri-only"],
        // --offer-expect is an absolute override; the default is the reference's BN3 number scaled by the BitNode.
        // A LOW-valuation node cannot reach that number at all ("don't aim for a specific number"), so there the
        // offer is taken at whatever it reaches; see offerMode in corp-lib.
        offerExpect: offerMode(offerScale) === "LOW" ? 0 : scaledOfferExpect(ROUND2_OFFER_EXPECT, offerScale, options["offer-expect"]),
        agriRatio: Number(options["agri-ratio"]),
        chemRatio: Number(options["chem-ratio"]),
        rpAgri: Number(options["rp-agri"]),
        rpChem: Number(options["rp-chem"]),
    };
    corpLog(ns, `round 2 starting (agri-ratio=${cfg.agriRatio}, chem-ratio=${cfg.chemRatio}, rp=${cfg.rpAgri}/${cfg.rpChem}, offer-expect=${formatMoney(cfg.offerExpect)} @ BN valuation x${offerScale})`);
    try {
        await run(ns, cfg);
    } catch (e) {
        // An uncaught throw is only reported in the terminal, where the daemon does not look: log the reason
        // into the port/lifecycle log first so a failure shows up in the tail it watches.
        corpLog(ns, `phase-round2 stopped: ${e?.message ?? e}`, "ERROR");
    }
}
