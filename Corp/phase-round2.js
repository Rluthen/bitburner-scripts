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
import { formatMoney, getConfiguration, instanceCount } from "../helpers.js";
import { AGRI_NAME, CHEM_NAME, corpLog, getCities } from "./corp-lib.js";
import { bestStorageFactoryWarehouse, maxAffordableAdvertLevel, optimalBoostMaterials, warehouseSize } from "./corp-formulas.js";
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
const OFFER_INIT_CYCLES = 15; // reference round2 waitForOffer(15, 10, 11e12)
const OFFER_EXTRA_CYCLES = 10;

const argsSchema = [
    ["offer-expect", 11e12], // reference round2's expectation; the guide prints 14.1-14.9e12 (CONTEXT §6)
    ["agri-ratio", 0.76], // §8.6: fraction of an Agriculture warehouse used for boost materials (4522/5950)
    ["chem-ratio", 0.95], // §8.6: same for Chemical (665/700)
    ["rp-agri", 700], // §19.3.1: "waiting for 700 RP in Agriculture is enough"
    ["rp-chem", 390], // §19.3.1: 390 RP in Chemical
];

export function autocomplete(data, _) {
    data.flags(argsSchema);
    return [];
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
 * (warehouseSize(level, Smart Storage) * that division's mat-ratio). The two divisions are stocked one after
 * the other, never with Promise.all: T03's stockBoostMaterials awaits nextUpdate() internally. **/
async function stockBoost(ns, cities, agriFactors, chemFactors, cfg) {
    const ss = ns.corporation.getUpgradeLevel("Smart Storage");
    const space = (division, city, ratio) => warehouseSize(ns.corporation.getWarehouse(division, city).level, ss) * ratio;
    const targets = (division, factors, ratio) => Object.fromEntries(cities.map((city) => [city, optimalBoostMaterials(factors, space(division, city, ratio))]));
    const agri = targets(AGRI_NAME, agriFactors, cfg.agriRatio);
    const chem = targets(CHEM_NAME, chemFactors, cfg.chemRatio);
    const sample = cities[0];
    corpLog(ns, `${AGRI_NAME}: boost for warehouse space ${space(AGRI_NAME, sample, cfg.agriRatio).toFixed(1)} = ${agri[sample].join("/")} in ${cities.length} cities`);
    corpLog(ns, `${CHEM_NAME}: boost for warehouse space ${space(CHEM_NAME, sample, cfg.chemRatio).toFixed(1)} = ${chem[sample].join("/")} in ${cities.length} cities`);
    await stockBoostMaterials(ns, AGRI_NAME, agri);
    await stockBoostMaterials(ns, CHEM_NAME, chem);
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

    // Step 1: Export first (the round's whole point), then Agriculture: Advert 8, office 4 -> 8 all on R&D.
    ensureUnlock(ns, "Export");
    ensureAdvert(ns, AGRI_NAME, ADVERT_TARGET);
    for (const city of cities) ensureOfficeSize(ns, AGRI_NAME, city, AGRI_OFFICE_SIZE);
    setAllOnRnd(ns, AGRI_NAME, cities);

    // Step 2: Chemical as the support division - office 3, warehouse 2, all on R&D, no Advert, no office growth.
    if (!ensureDivision(ns, CHEM_INDUSTRY, CHEM_NAME, cities, CHEM_OFFICE_SIZE, CHEM_WAREHOUSE_LEVEL)) {
        corpLog(ns, `${CHEM_NAME}: could not be set up - not enough funds?`, "ERROR");
        return;
    }
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

    assignJobsAllCities(ns, AGRI_NAME, JOBS_AGRI); // step 7: the §19.3.2 job counts
    assignJobsAllCities(ns, CHEM_NAME, JOBS_CHEM);

    await stockBoost(ns, cities, agriFactors, chemFactors, cfg); // step 8

    // Step 9: let the offer peak (15 cycles, then up to 10 more while it keeps rising), accept only within
    // 20% of the expected offer. T03 logs the MILESTONE on success and an ERROR on refusal; a refusal leaves
    // the phase at R2 and the daemon relaunches this job a few cycles later.
    await waitForOffer(ns, OFFER_INIT_CYCLES, OFFER_EXTRA_CYCLES, cfg.offerExpect);
    acceptOffer(ns, cfg.offerExpect);
}

/** @param {NS} ns **/
export async function main(ns) {
    const options = getConfiguration(ns, argsSchema);
    if (!options || (await instanceCount(ns)) > 1) return;
    ns.disableLog("ALL");
    const cfg = {
        offerExpect: Number(options["offer-expect"]),
        agriRatio: Number(options["agri-ratio"]),
        chemRatio: Number(options["chem-ratio"]),
        rpAgri: Number(options["rp-agri"]),
        rpChem: Number(options["rp-chem"]),
    };
    corpLog(ns, `round 2 starting (agri-ratio=${cfg.agriRatio}, chem-ratio=${cfg.chemRatio}, rp=${cfg.rpAgri}/${cfg.rpChem}, offer-expect=${formatMoney(cfg.offerExpect)})`);
    try {
        await run(ns, cfg);
    } catch (e) {
        // An uncaught throw is only reported in the terminal, where the daemon does not look: log the reason
        // into the port/lifecycle log first so a failure shows up in the tail it watches.
        corpLog(ns, `phase-round2 stopped: ${e?.message ?? e}`, "ERROR");
    }
}
