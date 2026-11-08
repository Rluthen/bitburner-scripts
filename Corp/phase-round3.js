/** T11 - Corp/phase-round3.js: round-3 setup JOB for BN3 - the two Market unlocks, the Tobacco division,
 * Tobacco-before-Chemical export priority and the first product (guide §4.3 p20-22, §19.4.2 p76-79).
 * Runs to completion and exits; the daemon (corp.js, T07) launches it while the phase is R3_SETUP and
 * relaunches it after a crash, so every step reads game state first and is a no-op on a second run.
 *
 * The round-3 deviations of the old corp.js (corp.js.og.js expandTobacco, lines 218-304) this fixes:
 *   1. it ended after makeProduct() and logged "got third investing round" - it never accepted an offer.
 *      Here the job ends at the product (the offer is T14's), and the log says what actually happened.
 *   2. it exported Agriculture -> Tobacco only, leaving the round-2 Agriculture -> Chemical Plants route
 *      AHEAD of it in the FIFO export list -> step 4 re-adds Tobacco first, then Chemical (§4.3 p22).
 *   3. no "Market Research - Demand" / "Market Data - Competition" unlocks (5e9 each), so custom Market-TA2
 *      (T12) is impossible -> step 1.
 *   4. it bought the boost-material stock of one hard-coded city only -> this file never names a city: step 7
 *      hands the budgets to T18 with --product-city (the old file also spent funds*0.01 on the first product
 *      while the rest of the funds went nowhere).
 *   5. it set the odd per-city jobs of the product city only -> steps 3 + 6 (all-R&D support offices, the
 *      guide's §19.4.2 "progress" ratios for the main office).
 *
 * Distinct ns.corporation.* APIs referenced by THIS file (docs figures from CONTEXT §4, NOT measured - `mem`):
 *   0 GB : hasCorporation nextUpdate
 *   10 GB: getCorporation getDivision getOffice, plus corp-ops.js: getCorporation getDivision getInvestmentOffer
 *          getMaterial getOffice getWarehouse getUpgradeLevel getUpgradeLevelCost getUnlockCost hasUnlock
 *          getHireAdVertCost getHireAdVertCount hasWarehouse
 *   20 GB: makeProduct, plus corp-ops.js: acceptInvestmentOffer buyMaterial buyTea cancelExportMaterial
 *          expandCity expandIndustry exportMaterial hireAdVert hireEmployee levelUpgrade purchaseUnlock
 *          purchaseWarehouse setJobAssignment throwParty upgradeOfficeSize upgradeWarehouse
 *   => 13 x 10 GB + 17 x 20 GB = 470 GB for the corporation API alone, on top of the helpers.js (~16.4 GB),
 *      corp-lib.js (~1.4 GB) and corp-formulas.js (0 GB) unions. That is why this is a JOB.
 *
 * Guide refs: §4.3 p20-22 (round 3+ = Tobacco, export route for Plants, support offices on R&D until the
 * first product completes, "Market-TA2 ASAP"), §3.3 p17 (Tobacco = best product industry), §19.4.2 p76-79
 * (support budgets 150e9/30e9 at round-3 start, >=90% of funds to the product division, main office round-3
 * "progress" ratios 0.037/0.513/0.011/0.44, product name format `<division>-<5-digit id>-<budget e-notation>`),
 * §18.5 p71 (dummy divisions are T20's job), §2 FAQ p10 (max 20 divisions in BN3).
 * Ported from catloversg/bitburner-scripts (MIT): corporation.ts round3 (buyUnlock x2, division cap check,
 * createDivision Tobacco 3/1, cancel+export Tobacco then Chemical per city, wait for productionMult != 0,
 * improveProductDivision(funds*0.99 - 150e9 - 30e9 - 1e9), developNewProduct(..., 1e9), improveSupportDivision
 * 150e9/30e9, buyBoostMaterials).
 */
import { formatMoney, getConfiguration } from "../helpers.js";
import { AGRI_NAME, CHEM_NAME, TOB_NAME, alreadyRunning, corpLog, getCities, readBnProfile, runWorker } from "./corp-lib.js";
import { allowedProductCeiling, nextProductName, ratiosToCounts } from "./corp-formulas.js";
import { assignJobs, ensureDivision, ensureUnlock, setBothExports } from "./corp-ops.js";

const TOB_INDUSTRY = "Tobacco";
// This job runs in round 3 on a BN3-scale node, but in round 4 on a LOW-offer one (Tobacco moves a round
// later - see Corp/corp-rules.js detectPhase - and its --round reaches T18/T19's office ratios), so the round
// is read from the live offer at run time. Same convention as corp-offers/corp-products/corp-offices:
// funds 0 means "no offer left / public" => 5.
const TOB_OFFICE_SIZE = 3; // reference createDivision(Tobacco, 3, 1): a new division's office is 3
const TOB_WAREHOUSE_LEVEL = 1;
const EXPORT_MATERIAL = "Plants"; // Agriculture's product, needed by Tobacco and by Chemical (§4.3 p22)
const MARKET_UNLOCKS = ["Market Research - Demand", "Market Data - Competition"]; // 5e9 each: demand/competition
const RND = "Research & Development";
const MAIN_OFFICE_JOBS = ["Operations", "Engineer", "Business", "Management"]; // order of the ratio array below
const MAIN_OFFICE_RATIO_ROUND3 = [0.037, 0.513, 0.011, 0.44]; // §19.4.2 p78 round-3 "progress" main office
const IMPROVE_SCRIPT = "Corp/corp-improve.js"; // T18 (P4): owns every office/warehouse/upgrade purchase
const PRODUCTION_MULT_CYCLES = 5; // productionMult is 0 until the first START after creation - wait a few cycles
const DEFAULT_MAX_DIVISIONS = 20; // §2 FAQ p10; T08's maxDivisionsApprox wins when /Temp/corp-bn.txt exists

const argsSchema = [
    ["product-city", "Sector-12"], // the city whose Tobacco office develops the product
    ["agri-budget", 150e9], // §19.4.2: "500b/100b is enough, personally I spend only 150b/30b"
    ["chem-budget", 30e9],
    ["first-product-budget", 1e9], // reference developNewProduct(..., 1e9); half design, half marketing
    ["mat-ratio", 0.8], // round 3+ boost-material share of the warehouse (CONTEXT §6)
];

export function autocomplete(data, _) {
    data.flags(argsSchema);
    return [];
}

/** T08's division cap (/Temp/corp-bn.txt). A missing or unreadable file means BN3's 20. **/
function maxDivisions(ns) {
    return readBnProfile(ns).maxDivisionsApprox ?? DEFAULT_MAX_DIVISIONS;
}

/** The offer round this setup is running in: funds 0 means "no offer left / public" => 5. **/
function offerRound(ns) {
    const offer = ns.corporation.getInvestmentOffer();
    return offer.funds === 0 ? 5 : offer.round;
}

/** Put every employee of a division on R&D (support offices until the first product completes, §4.3).
 * The count is read back from the office, never assumed: assigning more than the office size throws and
 * leaves the staff Unassigned (zero RP). **/
function setAllOnRnd(ns, division, cities) {
    for (const city of cities) assignJobs(ns, division, city, { [RND]: ns.corporation.getOffice(division, city).size });
}

/** Step 4: re-add the Agriculture -> Tobacco Plants route BEFORE the round-2 Agriculture -> Chemical one.
 * Exports are FIFO per (city, material): stable/src/Corporation/Division.ts (EXPORT state) walks the material's
 * `exports` array in order and the first route drains `stored` first, while Actions.ts exportMaterial appends
 * with push(). Running T03's cancel-then-export for Tobacco first therefore puts it ahead of Chemical - which
 * is what §4.3 p22 asks for ("prioritize Tobacco over Chemical"), and what the old script never did.
 * Chemical -> Agriculture is deliberately left alone. **/
function setTobaccoExportPriority(ns, cities) {
    setBothExports(ns, AGRI_NAME, TOB_NAME, EXPORT_MATERIAL, cities);
    setBothExports(ns, AGRI_NAME, CHEM_NAME, EXPORT_MATERIAL, cities);
}

/** Step 5: a new division's productionMult is 0 until its first START (reference round3 comment). **/
async function waitForFirstStart(ns, division) {
    for (let i = 0; i < PRODUCTION_MULT_CYCLES && ns.corporation.getDivision(division).productionMult === 0; i++) await ns.corporation.nextUpdate();
    const mult = ns.corporation.getDivision(division).productionMult;
    if (mult === 0) corpLog(ns, `${division}: productionMult still 0 after ${PRODUCTION_MULT_CYCLES} cycles`, "WARN");
    else corpLog(ns, `${division}: first START done (productionMult ${mult.toFixed(4)})`);
}

/** Step 6: the guide's round-3 main-office ("progress") ratios for the office's actual size. **/
function setMainOfficeJobs(ns, city) {
    const size = ns.corporation.getOffice(TOB_NAME, city).size;
    const counts = ratiosToCounts(MAIN_OFFICE_RATIO_ROUND3, size);
    const jobs = Object.fromEntries(MAIN_OFFICE_JOBS.map((job, i) => [job, counts[i]]));
    corpLog(ns, `${TOB_NAME}/${city}: main office size ${size} -> jobs ${JSON.stringify(jobs)} (§19.4.2 progress)`);
    assignJobs(ns, TOB_NAME, city, jobs);
}

/** Step 7: hand the money to T18, which owns every office/warehouse/upgrade purchase (and re-buys boost
 * materials last, after it has changed the warehouse sizes). One budget per division, spent in this order:
 * product division first, then the two support divisions with their §19.4.2 start-of-round-3 shares.
 * Without T18 nothing is spent - the daemon's improve rule does it on a later cycle. **/
async function spend(ns, cfg, round) {
    if (!ns.fileExists(IMPROVE_SCRIPT)) {
        corpLog(ns, `nothing spent: ${IMPROVE_SCRIPT} is not installed (T18) - skipping the ${TOB_NAME}/${AGRI_NAME}/${CHEM_NAME} office, warehouse and upgrade plan this run`, "WARN");
        return;
    }
    const improveArgs = (division, budget, support) => [
        "--division", division,
        "--budget", String(Math.floor(budget)),
        "--round", String(round),
        "--mat-ratio", String(cfg.matRatio),
        "--product-city", cfg.productCity,
        ...(support ? ["--support"] : []),
    ];
    // §19.4.2: >=90% of the funds to the product division, keeping the support reserve and the first product.
    // Those 150e9/30e9 reserves are BN3 numbers, and on a LOW-offer node this job runs a round later with a
    // fraction of the money - there they would hand the whole treasury to Agriculture. Keep their 5:1 ratio and
    // scale them to this round's funds: at BN3 scale (funds >= 600e9) the factor is 1 and nothing changes.
    const funds = ns.corporation.getCorporation().funds;
    const scale = Math.min(1, (funds * 0.3) / (cfg.agriBudget + cfg.chemBudget));
    const agri = cfg.agriBudget * scale;
    const chem = cfg.chemBudget * scale;
    const total = funds - agri - chem - cfg.firstProductBudget;
    if (total <= 0) corpLog(ns, `no product-division budget: ${formatMoney(funds)} left after the support reserve and the product`, "WARN");
    else await runWorker(ns, IMPROVE_SCRIPT, improveArgs(TOB_NAME, total * 0.99, false));
    await runWorker(ns, IMPROVE_SCRIPT, improveArgs(AGRI_NAME, agri, true));
    await runWorker(ns, IMPROVE_SCRIPT, improveArgs(CHEM_NAME, chem, true));
}

/** Step 8: the first product of round 3 (the reference's developNewProduct(..., 1e9)). Returns its name,
 * or null when nothing was created. Round 3 allows exactly one product (T02 allowedProductCeiling), so a
 * relaunch after a crash finds it here and does not spend the 1e9 twice. **/
function developFirstProduct(ns, cfg, round) {
    const division = ns.corporation.getDivision(TOB_NAME);
    // Exactly one product: this job owns the FIRST product and T13 develops further ones once the offers are
    // gone, so a crash-relaunch must not spend the 1e9 again just because a later round allows more.
    const ceiling = Math.min(allowedProductCeiling(round), division.maxProducts, 1);
    if (division.products.length >= ceiling) {
        corpLog(ns, `${TOB_NAME}: ${division.products.length} product(s) already in development (ceiling ${ceiling}) - not creating another`);
        return division.products[0] ?? null;
    }
    const funds = ns.corporation.getCorporation().funds;
    if (cfg.firstProductBudget < 1e3 || funds < cfg.firstProductBudget) {
        corpLog(ns, `${TOB_NAME}: cannot invest ${formatMoney(cfg.firstProductBudget)} in a product, ${formatMoney(funds)} available`, "ERROR");
        return null;
    }
    const name = nextProductName(division.products, TOB_NAME);
    const invest = cfg.firstProductBudget / 2;
    ns.corporation.makeProduct(TOB_NAME, cfg.productCity, name, invest, invest); // THROWS only when short of funds, checked above
    return name;
}

/** @param {NS} ns @param {ReturnType<typeof argsSchema>} cfg **/
async function run(ns, cfg) {
    const cities = getCities(ns);
    if (!ns.corporation.hasCorporation()) {
        corpLog(ns, "round 3 needs a corporation - run Corp/phase-round1.js first", "ERROR");
        return;
    }
    const divisions = ns.corporation.getCorporation().divisions;
    for (const needed of [AGRI_NAME, CHEM_NAME]) {
        if (!divisions.includes(needed)) {
            corpLog(ns, `round 3 needs the "${needed}" division`, "ERROR");
            return;
        }
    }

    for (const unlock of MARKET_UNLOCKS) ensureUnlock(ns, unlock); // step 1 (5e9 each, needed by T12)

    // Step 2: the cap only blocks CREATING Tobacco; when it already exists the rest of the job still runs.
    if (!divisions.includes(TOB_NAME) && divisions.length >= maxDivisions(ns)) {
        corpLog(ns, `max divisions reached (${divisions.length}) - sell one division`, "ERROR");
        return;
    }

    // Step 3: Tobacco in every city (office 3, warehouse 1), all employees on R&D until the first product.
    if (!ensureDivision(ns, TOB_INDUSTRY, TOB_NAME, cities, TOB_OFFICE_SIZE, TOB_WAREHOUSE_LEVEL)) {
        corpLog(ns, `${TOB_NAME}: could not be set up - not enough funds?`, "ERROR");
        return;
    }
    setAllOnRnd(ns, TOB_NAME, cities);

    // Step 4: exportMaterial/cancelExportMaterial THROW without the Export unlock (bought in round 2).
    if (!ns.corporation.hasUnlock("Export")) corpLog(ns, "Export unlock missing - the Agriculture export routes were not touched", "WARN");
    else setTobaccoExportPriority(ns, cities);

    await waitForFirstStart(ns, TOB_NAME); // step 5

    // Step 6: the product city must have an office (getOffice throws instead of returning undefined).
    if (!ns.corporation.getDivision(TOB_NAME).cities.includes(cfg.productCity)) {
        corpLog(ns, `${TOB_NAME} has no office in ${cfg.productCity} - cannot set the main office jobs`, "ERROR");
        return;
    }
    setMainOfficeJobs(ns, cfg.productCity);

    const round = offerRound(ns); // 3 on a BN3-scale node, 4 on a LOW-offer one - T18/T19 buy per-round ratios

    await spend(ns, cfg, round); // step 7

    const product = developFirstProduct(ns, cfg, round); // step 8

    // Step 9: the product/pricing/offer services are started by the daemon (T12-T14).
    corpLog(ns, product === null ? `${TOB_NAME} created, no product in development yet` : `${TOB_NAME} created, first product ${product} in development`, "MILESTONE");
}

/** @param {NS} ns **/
export async function main(ns) {
    const options = getConfiguration(ns, argsSchema);
    if (!options || alreadyRunning(ns)) return;
    ns.disableLog("ALL");
    const cfg = {
        productCity: String(options["product-city"]),
        agriBudget: Number(options["agri-budget"]),
        chemBudget: Number(options["chem-budget"]),
        firstProductBudget: Number(options["first-product-budget"]),
        matRatio: Number(options["mat-ratio"]),
    };
    corpLog(ns, `round 3 setup starting (product-city=${cfg.productCity}, budgets agri=${formatMoney(cfg.agriBudget)} chem=${formatMoney(cfg.chemBudget)} product=${formatMoney(cfg.firstProductBudget)}, mat-ratio=${cfg.matRatio})`);
    try {
        await run(ns, cfg);
    } catch (e) {
        // An uncaught throw is only reported in the terminal, where the daemon does not look: log the reason
        // into the port/lifecycle log first so a failure shows up in the tail it watches.
        corpLog(ns, `phase-round3 stopped: ${e?.message ?? e}`, "ERROR");
    }
}
