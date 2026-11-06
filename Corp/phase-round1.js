/** T09 - Corp/phase-round1.js: round-1 JOB for BN3 - create the corporation + Agriculture, take offer 1.
 * Runs to completion and exits. The daemon (corp.js, T07) launches it as the single R1 job and may relaunch
 * it after a crash, so every step re-reads game state and only buys the delta (T03's ensure* helpers).
 *
 * The four round-1 deviations of the old corp.js (corp.js.og.js makeNewCorp, lines 79-147) this fixes:
 *   1. never upgraded the office 3->4 / never waited for 55 RP   -> step 3 + step 7 (waitForResearchPoints).
 *   2. assigned no Management employee (and R&D to 0 at once)    -> step 8, JOBS_AFTER_RP.
 *   3. Warehouse level 5 with built-in Smart Supply, i.e. over the 150e9 seed -> step 4 is budget-driven
 *      (the guide's §19.2.2 list costs 148.98e9 and the §19.2.1 one 149.95e9 with the free Sector-12 office
 *      and warehouse, so both only just fit; T02's optimizer spends what is left, see buyStoragePlan).
 *   4. hard-coded 108/120.1/7438.8 boost materials               -> step 9, industry factors read at runtime
 *      from getIndustryData (CONTEXT §4b) and the §8.3.2 optimum.
 * It is also re-runnable and never calls ns.exit(): outside BN3 the seed-money call THROWS, so the
 * self-fund path is chosen from canCreateCorporation() instead (stable/src/Corporation/Actions.ts).
 *
 * Distinct ns.corporation.* APIs referenced (docs figures from CONTEXT §4, NOT measured - run `mem`):
 *   0 GB : hasCorporation canCreateCorporation nextUpdate
 *   10 GB: getIndustryData getOffice getUpgradeLevel getWarehouse, plus corp-ops.js: getCorporation
 *          getDivision getInvestmentOffer getMaterial getUpgradeLevelCost getUnlockCost hasUnlock
 *          getHireAdVertCost getHireAdVertCount hasWarehouse
 *   20 GB: createCorporation sellMaterial setSmartSupply setSmartSupplyOption, plus corp-ops.js:
 *          acceptInvestmentOffer buyMaterial buyTea cancelExportMaterial expandCity expandIndustry
 *          exportMaterial hireAdVert hireEmployee levelUpgrade purchaseUnlock purchaseWarehouse
 *          setJobAssignment throwParty upgradeOfficeSize upgradeWarehouse
 *   => 14 x 10 GB + 20 x 20 GB = 540 GB for the corporation API alone, on top of the helpers.js (~16.4 GB),
 *      corp-lib.js (~1.4 GB) and corp-formulas.js (0 GB) unions, plus 0.1 GB for getServerMoneyAvailable.
 *      That is why this is a JOB and not something the daemon does itself.
 *
 * Guide refs: §4.1/§19.2 p19/73 (the two round-1 columns), §1.1 p7 (per-second purchases, must be cleared),
 * §6.2 p25 ("only focus on Smart Storage and warehouse upgrade. Run optimizer"), §10.3 p31 (tea/party),
 * §17.3 p64 (offers scale with CorporationValuation). Ported from catloversg/bitburner-scripts (MIT):
 * corporation.ts round1 (createDivision, sellMaterial, buyAdvert 2, optimizeStorageAndFactory, RP wait,
 * assignJobs, stockMaterials, waitForOffer(10, 10, 490e9), acceptInvestmentOffer).
 */
import { formatMoney, getConfiguration, instanceCount } from "../helpers.js";
import { AGRI_NAME, CORPORATION_NAME, corpLog, getCities, offerMode, readBnProfile, scaledOfferExpect } from "./corp-lib.js";
import { bestStorageFactoryWarehouse, optimalBoostMaterials, warehouseSize } from "./corp-formulas.js";
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
    stockBoostMaterials,
    waitForHappy,
    waitForOffer,
    waitForResearchPoints,
} from "./corp-ops.js";

const INDUSTRY = "Agriculture"; // §3.3 p17: best starting industry (realEstateFactor 0.72)
const OFFICE_SIZE = 4; // §19.2: upgrade the office from 3 to 4
const RP_TARGET = 55; // §19.2: keep all four employees on R&D until RP >= 55
const JOBS_AFTER_RP = { Operations: 1, Engineer: 1, Business: 1, Management: 1, "Research & Development": 0 };
const ADVERT_TARGET = 2; // §4.1/§19.2: buy 2 Advert levels in this round
const SELF_FUND_COST = 150e9; // stable helpers.ts costOfCreatingCorporation(false); 50e9 only on a restart
const OFFER_INIT_CYCLES = 10; // reference waitForOffer(10, 10, ...) - the offer peaks after ~10 production cycles
const OFFER_EXTRA_CYCLES = 10;
// Guide §19.1 offer means (BN3 numbers): 551.164e9 with a custom Smart Supply script (the reference's 490e9
// expectation), 340.413e9 with the built-in one. 490e9 is the ticket's number and is only reachable on the
// custom path. Both are multiplied by the BitNode's CorporationValuation multiplier (T08 offerScale) below:
// offers scale with it (§17.3 p64), so e.g. BN6/BN7 (x0.2) peak at ~68e9 and the 0.8 accept floor must move
// with them - otherwise the phase refuses its own best offer forever.
const OFFER_EXPECT_CUSTOM = 490e9;
const OFFER_EXPECT_BUILTIN = 340e9;

const argsSchema = [
    ["custom-supply", false], // true => assume Corp/corp-supply.js (T16) feeds the division; skip the 25e9 unlock
    ["self-fund", false], // true => never try the BN3 seed call, always pay the 150e9 from the player's money
    ["mat-ratio", 0.84], // fraction of each warehouse used for boost materials (§6, round-1 ratio)
    ["offer-expect", null], // null => 490e9 custom / 340e9 built-in (guide §19.1)
    ["reserve", null], // player money to keep when self-funding; null => contents of reserve.txt
];

export function autocomplete(data, _) {
    data.flags(argsSchema);
    return [];
}

/** One context line out of T08's profile (/Temp/corp-bn.txt). A missing file is fine - canCreateCorporation
 * is the real gate. **/
function bnNote(ns) {
    return readBnProfile(ns).note ?? "no BN profile";
}

/** Step 1: make sure a corporation exists. Seed money only where the game allows it (BN3); otherwise
 * self-fund with the player's 150e9, warning when that dips into the reserve. @returns {boolean} **/
function ensureCorporation(ns, cfg) {
    if (ns.corporation.hasCorporation()) return true;
    const note = bnNote(ns);
    // canCreateCorporation(false) returning "Success" is exactly the case where createCorporation(name, false)
    // does NOT throw (Actions.ts switch). Trying the seed outside BN3 would kill the job instead.
    if (!cfg.selfFund && ns.corporation.canCreateCorporation(false) === "Success" && ns.corporation.createCorporation(CORPORATION_NAME, false)) {
        corpLog(ns, `created corporation "${CORPORATION_NAME}" with seed money (${note})`, "MILESTONE");
        return true;
    }
    const selfFundCheck = ns.corporation.canCreateCorporation(true);
    if (selfFundCheck !== "Success") {
        corpLog(ns, `cannot create corporation: ${selfFundCheck} (${note})`, "ERROR");
        return false;
    }
    const money = ns.getServerMoneyAvailable("home"); // 0.1 GB, direct - never a helper that can stall
    if (money < SELF_FUND_COST) {
        corpLog(ns, `self-funding "${CORPORATION_NAME}" needs ${formatMoney(SELF_FUND_COST)}, home has ${formatMoney(money)}`, "ERROR");
        return false;
    }
    if (money - SELF_FUND_COST < cfg.reserve) corpLog(ns, `self-funding leaves ${formatMoney(money - SELF_FUND_COST)} on home, under the ${formatMoney(cfg.reserve)} reserve`, "WARN");
    if (!ns.corporation.createCorporation(CORPORATION_NAME, true)) {
        corpLog(ns, `self-funded creation of "${CORPORATION_NAME}" was refused (${formatMoney(SELF_FUND_COST)})`, "ERROR");
        return false;
    }
    corpLog(ns, `created corporation "${CORPORATION_NAME}" self-funded with ${formatMoney(SELF_FUND_COST)} (${note})`, "MILESTONE");
    return true;
}

/** Step 3: office 3 -> 4 in every city, everybody on R&D (§19.2). The count is read back from the office
 * instead of assuming 4: if the upgrade could not be afforded, assigning 4 would throw and leave the staff
 * Unassigned, i.e. zero RP, and waitForResearchPoints() would never finish. */
function startOnRnd(ns, cities) {
    for (const city of cities) {
        ensureOfficeSize(ns, AGRI_NAME, city, OFFICE_SIZE);
        assignJobs(ns, AGRI_NAME, city, { "Research & Development": ns.corporation.getOffice(AGRI_NAME, city).size });
    }
}

/** Step 4: the guide's round-1 upgrade list, spent as far as the funds reach. §4.1 says "only focus on
 * Smart Storage and warehouse upgrade. Run optimizer to find the best combination of them" - that is T02's
 * bestStorageFactoryWarehouse, which also decides Smart Factories. Measured offline at a fresh 150e9 seed
 * (85e9 division + 5 offices + 5 warehouses, 8.47e9 office 3->4, 2.06e9 Advert, +25e9 Smart Supply on the
 * built-in path) the optimizer lands on the guide's OWN columns: built-in SS3/SF0/WH4 for 148.98e9 total,
 * custom SS8/SF2/WH5 for 149.95e9 - under 1e9 of the seed left over, which is exactly why this is
 * budget-driven instead of a hard-coded level list. Fixes deviation 3 (the old corp.js forced warehouse 5). */
function buyStoragePlan(ns, cities, factors, cfg) {
    const budget = ns.corporation.getCorporation().funds;
    const plan = bestStorageFactoryWarehouse(budget, {
        ssFrom: ns.corporation.getUpgradeLevel("Smart Storage"),
        sfFrom: ns.corporation.getUpgradeLevel("Smart Factories"),
        whFrom: Math.min(...cities.map((city) => ns.corporation.getWarehouse(AGRI_NAME, city).level)),
        factors: factors,
        matRatio: cfg.matRatio,
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

/** Step 5: built-in Smart Supply, with the input materials on "use leftovers" (FAQ p11). Both calls THROW
 * without the unlock, which is why this runs only when it is there (the custom-supply path has neither). **/
function turnOnSmartSupply(ns, cities, inputs) {
    for (const city of cities) {
        ns.corporation.setSmartSupply(AGRI_NAME, city, true);
        for (const material of inputs) ns.corporation.setSmartSupplyOption(AGRI_NAME, city, material, "leftovers");
    }
    corpLog(ns, `smart supply on in ${cities.length} cities, ${inputs.join("/")} = leftovers`);
}

/** Step 6: sell what the industry makes at Market Price in every city (amount and price are STRINGS).
 * The materials come from the industry data, never a hard-coded list. **/
function sellProduce(ns, cities, produced) {
    for (const city of cities) for (const material of produced) ns.corporation.sellMaterial(AGRI_NAME, city, material, "MAX", "MP");
    corpLog(ns, `selling ${produced.join("/")} at MP in ${cities.length} cities`);
}

/** Step 9: stock the boost materials at the §8.3.2 optimum for each city's ACTUAL warehouse space
 * (warehouseSize(level, Smart Storage) * mat-ratio) - never the guide's per-second constants. T03 buys
 * per-second and always clears the orders afterwards (§1.1). **/
async function stockBoost(ns, cities, factors, matRatio) {
    const smartStorage = ns.corporation.getUpgradeLevel("Smart Storage");
    const targets = {};
    const sizes = {};
    for (const city of cities) {
        const size = warehouseSize(ns.corporation.getWarehouse(AGRI_NAME, city).level, smartStorage) * matRatio;
        sizes[city] = size;
        targets[city] = optimalBoostMaterials(factors, size);
    }
    const sample = cities[0];
    corpLog(ns, `boost targets for warehouse space ${sizes[sample].toFixed(1)} (Smart Storage ${smartStorage}): ${targets[sample].join(" / ")} in all ${cities.length} cities`);
    await stockBoostMaterials(ns, AGRI_NAME, targets);
}

/** @param {NS} ns @param {ReturnType<typeof argsSchema>} cfg **/
async function run(ns, cfg) {
    const cities = getCities(ns);
    if (!ensureCorporation(ns, cfg)) return;

    // Step 2: Agriculture in all 6 cities with a warehouse and 3 employees each (T03, idempotent).
    if (!ensureDivision(ns, INDUSTRY, AGRI_NAME, cities, 3, 1)) {
        corpLog(ns, `${AGRI_NAME}: could not be set up - not enough funds?`, "ERROR");
        return;
    }
    const industry = ns.corporation.getIndustryData(INDUSTRY); // factors + materials at runtime (CONTEXT §4b)
    const factors = [industry.aiCoreFactor ?? 0, industry.hardwareFactor ?? 0, industry.realEstateFactor ?? 0, industry.robotFactor ?? 0];

    startOnRnd(ns, cities); // step 3: office 3 -> 4, all on R&D

    // Step 4: the fixed-cost items first (they are not part of the optimizer's list), then the upgrades.
    if (!cfg.customSupply) ensureUnlock(ns, "Smart Supply");
    ensureAdvert(ns, AGRI_NAME, ADVERT_TARGET);
    buyStoragePlan(ns, cities, factors, cfg);

    if (ns.corporation.hasUnlock("Smart Supply")) turnOnSmartSupply(ns, cities, Object.keys(industry.requiredMaterials ?? {}));
    sellProduce(ns, cities, industry.producedMaterials ?? []);

    // Steps 7-8: happy employees, RP >= 55, then the real job setup before the boost materials are bought.
    await waitForHappy(ns, [AGRI_NAME]);
    await waitForResearchPoints(ns, { [AGRI_NAME]: RP_TARGET });
    assignJobsAllCities(ns, AGRI_NAME, JOBS_AFTER_RP);

    await stockBoost(ns, cities, factors, cfg.matRatio); // step 9

    // Steps 10-11: let the offer peak (waitForOffer: 10 cycles, then up to 10 more while it keeps rising),
    // then accept it - but only if it is within 20% of the guide's number (§19, FAQ p10). T03 logs the
    // MILESTONE on success and an ERROR when it refuses; a refusal leaves the phase at R1 and the daemon
    // relaunches this job a few cycles later.
    await waitForOffer(ns, OFFER_INIT_CYCLES, OFFER_EXTRA_CYCLES, cfg.offerExpect);
    acceptOffer(ns, cfg.offerExpect);
}

/** @param {NS} ns **/
export async function main(ns) {
    const options = getConfiguration(ns, argsSchema);
    if (!options || (await instanceCount(ns)) > 1) return;
    ns.disableLog("ALL");
    const customSupply = !!options["custom-supply"];
    const offerScale = Number(readBnProfile(ns).offerScale) || 1; // T08: the BitNode's CorporationValuation multiplier
    const cfg = {
        customSupply: customSupply,
        selfFund: !!options["self-fund"],
        matRatio: Number(options["mat-ratio"]),
        // --offer-expect is an absolute override; the defaults are the guide's BN3 means scaled by the BitNode.
        // A LOW-valuation node cannot reach those means at all ("don't aim for a specific number" - the guide
        // writer), so there the offer is taken at whatever amount it reaches; see offerMode in corp-lib.
        offerExpect: offerMode(offerScale) === "LOW" ? 0 : scaledOfferExpect(customSupply ? OFFER_EXPECT_CUSTOM : OFFER_EXPECT_BUILTIN, offerScale, options["offer-expect"]),
        reserve: options.reserve == null ? Number(ns.read("reserve.txt") || 0) : Number(options.reserve),
    };
    corpLog(ns, `round 1 starting (custom-supply=${cfg.customSupply}, mat-ratio=${cfg.matRatio}, offer-expect=${formatMoney(cfg.offerExpect)} @ BN valuation x${offerScale})`);
    try {
        await run(ns, cfg);
    } catch (e) {
        // An uncaught throw is only reported in the terminal, where the daemon does not look: log the
        // reason into the port/lifecycle log first so a failure is visible in the tail it watches.
        corpLog(ns, `phase-round1 stopped: ${e?.message ?? e}`, "ERROR");
    }
}
