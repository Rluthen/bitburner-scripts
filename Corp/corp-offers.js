/** T14 - Corp/corp-offers.js: the investment-offer SERVICE - accept offers 3 and 4, then go public + set a
 * dividend (guide §4.3 p22, §17.3-§17.5 p64-67, §19.4.2 p76-79).
 * One instance, loops on ns.corporation.nextUpdate(), acts on the START boundary; the daemon (T07) keeps it
 * alive. A SERVICE and not a JOB because it parks for the 10-15 cycles of waitForOffer, and the daemon's
 * single JOB slot must stay free.
 *
 * Why (review evidence): the old corp.js accepted offers 1 and 2 with a naive "wait 12 cycles then accept" and
 * NEVER accepted offer 3 or 4 (FAQ p9: "There are 4 rounds and you should take all of them"), never went
 * public and never issued a dividend - so the corporation generated profit and the player's money stayed flat
 * (§17.4 p64 / FAQ p10: "My corporation generates profit. Why does my money not increase? -> Go public and set
 * a dividend"). Offers 3/4 are driven by the last cycles' profit, so the offices must be switched to the
 * "profit" setup (and the product division must stop doing R&D) right before accepting (§19.4.2 p78).
 *
 * 1P/2P plan (§4.3 p22, §19.4.2 p78): develop 1 product, take offer 3; develop 1 more, take offer 4. T13
 * develops the products and stops at the ceiling of the current round, so the gate here is simply
 * "the round's product count is reached AND every product has finished". After offer 4 (round 5) the same
 * cyclic check turns into "go public, then issue the dividend" - once.
 *
 * Distinct ns.corporation.* APIs referenced by THIS file (docs figures from CONTEXT §4, NOT measured - `mem`):
 *   0 GB : hasCorporation nextUpdate
 *   10 GB: getCorporation getDivision getInvestmentOffer getOffice getProduct
 *   20 GB: acceptInvestmentOffer goPublic issueDividends setJobAssignment
 *   => 5 x 10 GB + 4 x 20 GB = 130 GB for the corporation API alone, plus the imports: helpers.js (~16.4 GB),
 *      corp-lib.js (ns.run 1, ns.getScriptRam 0.1, ns.isRunning 0.1, ns.getServerMaxRam/UsedRam 0.05 each,
 *      rest 0 GB) and corp-formulas.js (pure, 0 GB). Deliberately does NOT import Corp/corp-ops.js: its
 *      13-read/16-action union would blow this service's budget for four small inline helpers (assignJobs,
 *      waitForOffer, acceptOffer) that cost nothing extra - all four calls they need are already in the list
 *      above. `acceptInvestmentOffer` needs an offer; `issueDividends` needs a public corporation; both are
 *      wrapped.
 *
 * Guide refs: §17.3 p64 (Offer = Valuation x FundingRoundShares[0.1,0.35,0.25,0.2] x
 * FundingRoundMultiplier[3,2,2,1.5] - milestone values offer 3 >= 1e16, offer 4 >= 1e20), §17.2 p63
 * (valuation = mean of the last 10 cycles), §19.4.2 p77-79 (profit-setup ratios of round 3/4; "right before
 * accepting offer, switch to 'profit' setup"; sample log offers 1.457e16 / 4.758e20), §4.3 p22 (1P/2P),
 * §17.4-§17.5 p64-67 (dividends, going public: initial price = TargetSharePrice, buyback premium 10%; "if we
 * increase DividendRate, corporation's valuation is dwindled" -> set the dividend only AFTER offer 4).
 * Ported from catloversg/bitburner-scripts (MIT): corporation.ts 738-825 (preparingToAcceptOffer on
 * 98 < progress < 100, all-products-finished gate, expectedOffer 1e16/1e20, waitForOffer(10, 5, expected),
 * acceptInvestmentOffer) and switchAllOfficesToProfitSetup (994-1074, including the "reuse the main office
 * ratio but keep >= 1 employee in each of Operations/Engineer/Business" rule for the support offices).
 */
import { formatMoney, getConfiguration, instanceCount } from "../helpers.js";
import { BN_FILE, JOBS, OFFER_PREP_FILE, TOB_NAME, corpLog, runWorker } from "./corp-lib.js";
import { allowedProductCeiling, parseProductId, ratiosToCounts } from "./corp-formulas.js";

const OFFICES_SCRIPT = "Corp/corp-offices.js"; // T19 (P4): restores the normal office setup after an offer
const RESTORE_NORMAL_ARGS = ["--restore-normal"];
const PREP_PROGRESS_LOW = 98; // reference corporation.ts 772-777: newest product progress in (98,100) => almost done
const OFFER_WAIT_CYCLES = 10; // reference waitForOffer(ns, 10, 5, expected)
const OFFER_WAIT_EXTRA = 5;
const WARN_INTERVAL = 50; // re-log the same WARN at most once per this many cycles
// BN3 expectation table: rounds 3/4 are the guide's §19.4.2 milestones, rounds 1/2 are the reference's own
// waitForOffer expectations (corporation.ts 355/525). Scaled by T08's offerScale (CorporationValuation) at
// runtime. Rounds 1/2 are INERT here (this service returns before touching them; T09/T10 own those) - and
// note 490e9 is the CUSTOM-Smart-Supply column: the built-in path measures ~340e9 (guide §19.2.2), which is
// why phase-round1.js picks 490e9/340e9 by path instead of hard-coding the reference's number.
const EXPECTED_OFFER = { 1: 490e9, 2: 11e12, 3: 1e16, 4: 1e20 };
// §19.4.2 p77-78, order [Operations, Engineer, Business, Management]. Round 3: 49/138 5/138 51/138 33/138.
const PROFIT_RATIO_ROUND_3 = [49 / 138, 5 / 138, 51 / 138, 33 / 138];
const PROFIT_RATIO_ROUND_4 = [68 / 369, 12 / 369, 244 / 369, 45 / 369];
const SETTABLE_JOBS = Object.values(JOBS).filter((job) => job !== JOBS.none); // Unassigned is not settable

const argsSchema = [
    ["product-city", "Sector-12"], // the city whose office develops the products (T13's --product-city)
    ["dividend-rate", 0.5], // §17.4: 0..1; only issued after offer 4 (a higher rate lowers the valuation)
    ["go-public", true], // §17.5 p64: going public is what makes the dividend (and the money) exist
    ["min-fraction", 0.8], // refuse an offer below this fraction of the expected one (FAQ p10: "below 80%")
];

export function autocomplete(data, _) {
    data.flags(argsSchema);
    return [];
}

/** Job ratios for the "profit" setup of a round, order [ops, eng, biz, mgmt]. Pure, §19.4.2 p77-78. **/
export function profitRatio(offerRound) {
    return [...(offerRound <= 3 ? PROFIT_RATIO_ROUND_3 : PROFIT_RATIO_ROUND_4)];
}

/** Expected offer funds for a round, scaled by the BitNode's CorporationValuation (T08 offerScale). Pure. **/
export function expectedOfferFor(offerRound, offerScale) {
    return (EXPECTED_OFFER[offerRound] ?? 0) * offerScale;
}

/** Turn a [ops, eng, biz, mgmt] count array into the job dict assignOfficeJobs takes, R&D zeroed. **/
function jobDict([ops, eng, biz, mgmt]) {
    return { [JOBS.ops]: ops, [JOBS.eng]: eng, [JOBS.biz]: biz, [JOBS.mgmt]: mgmt, [JOBS.rnd]: 0 };
}

/** Support-office jobs: the main office's ratio, floored, but with >= 1 employee in each of
 * Operations/Engineer/Business and Management taking the remainder (reference 1046-1074). Pure. **/
export function profitOfficeJobs(ratio, size) {
    const [ops, eng, biz] = ratio.slice(0, 3).map((r) => Math.max(Math.floor(r * size), 1));
    return jobDict([ops, eng, biz, Math.max(size - (ops + eng + biz), 0)]);
}

/** The 1P/2P gate, pure: for rounds 3/4 the round's product count must be reached AND every product finished
 * (T13 develops one at a time and stops at the ceiling; T14 accepts the offer). `products` are the division's
 * product objects ({name, developmentProgress}). A name without a generated id still occupies a slot, so the
 * count is compared both ways (same rule as T13). **/
export function offerGate(products, offerRound) {
    const ceiling = allowedProductCeiling(offerRound);
    const named = products.map((p) => parseProductId(p.name)).filter(Number.isFinite);
    const developed = named.length === 0 ? 0 : Math.max(...named) + 1;
    const count = Math.max(developed, products.length);
    const allFinished = products.length > 0 && products.every((p) => p.developmentProgress >= 100);
    return { open: count >= ceiling && allFinished, developed: count, ceiling, allFinished };
}

/** Session memory of the running service. Every decision is re-derived from the game, so a restart costs
 * nothing but a repeated log line; this only stops duplicate INFO/WARN/MILESTONE spam. **/
function newMemory() {
    return {
        cycle: 0,
        accepted: new Set(), // offer rounds already accepted (belt and braces against a double accept)
        waiting: new Set(), // rounds whose "waiting" line was already printed
        warned: new Map(), // warn key -> the cycle it was last logged
    };
}

/** @param {NS} ns **/
export async function main(ns) {
    const options = getConfiguration(ns, argsSchema);
    if (!options || (await instanceCount(ns)) > 1) return;
    ns.disableLog("ALL");

    // Step 7: in BN8 (and any BN whose CorporationValuation is 0) every offer is worthless - stop the service.
    let profile = null;
    try {
        profile = JSON.parse(ns.read(BN_FILE)); // 0 GB; written by T08. Missing file => BN3 defaults.
    } catch {
        profile = null;
    }
    const offerScale = Number(profile?.offerScale ?? 1);

    const cfg = {
        productCity: String(options["product-city"]),
        dividendRate: Number(options["dividend-rate"]),
        goPublic: options["go-public"] !== false,
        minFraction: Number(options["min-fraction"]),
        offerScale: offerScale,
        division: TOB_NAME,
    };
    if (!(offerScale > 0)) {
        corpLog(ns, `offerScale is ${offerScale} (BN8 or no CorporationValuation): offers are worthless here - not accepting any offer`, "ERROR");
        return;
    }
    const mem = newMemory();
    corpLog(
        ns,
        `offer service starting (division=${cfg.division}, product-city=${cfg.productCity}, offerScale=${offerScale}, go-public=${cfg.goPublic}, dividend-rate=${cfg.dividendRate}, min-fraction=${cfg.minFraction})`,
    );

    while (true) {
        if (!ns.corporation.hasCorporation()) {
            await ns.sleep(5000); // the daemon may start services before the corporation exists
            continue;
        }
        // nextUpdate() resolves with the state that JUST happened: on START a whole cycle has been processed,
        // so the offer round, the product progress and the last cycle's profit are as fresh as they get.
        const state = await ns.corporation.nextUpdate();
        if (state !== "START") continue;
        mem.cycle++;
        try {
            await runCycle(ns, cfg, mem);
        } catch (e) {
            // An uncaught throw is only reported in the terminal, where the daemon does not look.
            corpLog(ns, `offer cycle failed: ${e?.message ?? e}`, "ERROR");
        }
    }
}

/** One START -> PURCHASE window. Async: it may park in waitForOffer. Exported for the offline selfCheck.
 * @param {NS} ns @param {object} cfg @param {object} mem **/
export async function runCycle(ns, cfg, mem) {
    const division = cfg.division;
    const corp = ns.corporation.getCorporation();
    if (!corp.divisions.includes(division)) {
        warnOnce(ns, mem, `nodiv:${division}`, `${division} does not exist yet - nothing to do`);
        return;
    }

    // Step 1: the offer round decides everything. funds 0 means "no offer left / corporation is public"
    // (getCorporation() has no round field, CONTEXT §4).
    const offer = ns.corporation.getInvestmentOffer();
    const offerRound = offer.funds === 0 ? 5 : offer.round;

    // Step 6: all four rounds are taken (or the corporation is already public) -> go public + set the dividend.
    if (offerRound > 4 || corp.public) {
        goPublicAndDividends(ns, cfg, corp, mem);
        return;
    }

    // Rounds 1/2 belong to T09/T10 (phase-round1/2 accept those themselves).
    if (offerRound < 3) {
        warnOnce(ns, mem, `round:${offerRound}`, `${division}: round ${offerRound} offer is ${formatMoney(offer.funds)} - rounds 1/2 are phase-round1/2's job, not this service's`);
        return;
    }
    if (mem.accepted.has(offerRound)) return; // never prepare or accept the same round twice

    const div = ns.corporation.getDivision(division);
    // getProduct needs the CITY. A product that cannot be read yet (still being created) counts as
    // "not finished": progress 0, rating 0.
    const products = div.products.map((name) => readProduct(ns, division, cfg.productCity, name) ?? { name, developmentProgress: 0, effectiveRating: 0 });
    const newest = products.length > 0 ? products[products.length - 1] : null;

    // Step 2: the 1P/2P gate. Step 3: the pre-accept signal - while the newest product is in its last 2% or
    // while we are already preparing to accept, OFFER_PREP_FILE is "1" so T19 leaves the product division's
    // office jobs alone (the reference's documented race, corporation.ts 688-690). Cleared in step 5.
    const gate = offerGate(products, offerRound);
    if (gate.open || (newest !== null && newest.developmentProgress > PREP_PROGRESS_LOW && newest.developmentProgress < 100)) {
        writeFlag(ns, OFFER_PREP_FILE, "1");
    } else {
        // The imminent-offer condition ended without an accept. Round 4 develops several products, so the newest
        // one leaving its last 2% (or being replaced) must NOT latch the flag: T18 would skip that division's
        // offices for the rest of the round. writeFlag() compares first, so this costs one 0 GB read per cycle.
        writeFlag(ns, OFFER_PREP_FILE, "0");
    }
    if (!gate.open) {
        warnOnce(
            ns,
            mem,
            `gate:${offerRound}`,
            `${division}: round ${offerRound} accepts at ${gate.ceiling} product(s) fully developed, ${gate.developed} developed, all finished: ${gate.allFinished}`,
        );
        return;
    }

    // Step 4: the reference waits one more cycle after the product finishes - a product created this cycle
    // still has effectiveRating 0.
    if (newest === null || newest.effectiveRating === 0) {
        warnOnce(ns, mem, "rating", `${division}: ${newest?.name ?? "newest product"} has effectiveRating 0 - waiting one more cycle before the profit setup`);
        return;
    }

    // Step 4: switch the product division to the "profit" setup (main office + support offices), then let the
    // offer grow (it is driven by the last cycles' profit) and accept it.
    applyProfitSetup(ns, division, cfg.productCity, offerRound);
    const expected = expectedOfferFor(offerRound, cfg.offerScale);
    await waitForOffer(ns, OFFER_WAIT_CYCLES, OFFER_WAIT_EXTRA, expected); // lets the offer grow on the profit setup
    if (!acceptOffer(ns, offerRound, expected, cfg.minFraction)) return; // below the floor: retry next cycle
    mem.accepted.add(offerRound);

    // Acceptance 3: the round is re-read after the accept. When the game consumed the offer it has advanced
    // (or the funds are 0), and every gate above is keyed on the round, so the same round cannot be accepted
    // again - on top of the structural guarantees (one acceptOffer call per runCycle, runCycle once per START).
    const roundAfter = readOfferRound(ns);
    if (roundAfter <= offerRound) corpLog(ns, `offer round is still ${roundAfter} after accepting round ${offerRound} - not accepting again`, "WARN");

    // Step 5: the offer is taken - drop the pre-accept signal and restore the normal office setup.
    writeFlag(ns, OFFER_PREP_FILE, "0");
    await restoreNormalSetup(ns, division);
}

/** Step 1/6 helper: the offer round after an action. funds 0 => 5 (no offer left / public). **/
function readOfferRound(ns) {
    const offer = ns.corporation.getInvestmentOffer();
    return offer.funds === 0 ? 5 : offer.round;
}

/** Step 4: profit setup for the product division. Main office = the round's ratio applied to its own employee
 * count (T02 ratiosToCounts, largest remainder); every other city of the division gets the same ratio with
 * >= 1 employee in each of Operations/Engineer/Business (reference 1046-1074) and R&D zeroed. Support
 * divisions are untouched. **/
function applyProfitSetup(ns, division, productCity, offerRound) {
    const ratio = profitRatio(offerRound);
    const main = ns.corporation.getOffice(division, productCity);
    assignOfficeJobs(ns, division, productCity, jobDict(ratiosToCounts(ratio, main.numEmployees)));
    corpLog(ns, `${division}/${productCity}: round ${offerRound} profit setup (${main.numEmployees} employees, R&D 0)`);
    for (const city of ns.corporation.getDivision(division).cities) {
        if (city === productCity) continue;
        const size = ns.corporation.getOffice(division, city).numEmployees;
        assignOfficeJobs(ns, division, city, profitOfficeJobs(ratio, size));
    }
}

/** Step 5: hand the offices back to T19 when it is installed; otherwise say plainly that they stay on the
 * profit setup. T19 is a P4 ticket and may be missing for a long time. AWAITED: runWorker parks on
 * ns.sleep while it polls, and a floating second ns context is what the game kills (CONTEXT §3 ENGINE RULE). **/
async function restoreNormalSetup(ns, division) {
    if (!ns.fileExists(OFFICES_SCRIPT)) {
        corpLog(ns, `${OFFICES_SCRIPT} is not installed (T19) - ${division}'s offices stay on the profit setup until the next Corp/corp-improve.js run`, "WARN");
        return;
    }
    await runWorker(ns, OFFICES_SCRIPT, ["--division", division, ...RESTORE_NORMAL_ARGS]);
}

/** Inline port of Corp/corp-ops.js assignJobs (that module is too heavy to import here, see the header):
 * setJobAssignment is an ABSOLUTE count per job and THROWS when there are not enough Unassigned employees,
 * so every unlisted job is zeroed first and the listed ones are applied in ASCENDING target count - only
 * REDUCING a job hands employees back to Unassigned, so R&D: 0 must run before Operations grows off it (a
 * round-3 office has everybody on R&D; without the order the R&D: 0 throws and the office stays on R&D).
 * @returns {boolean} false when any single assignment failed **/
function assignOfficeJobs(ns, division, city, jobs) {
    const before = ns.corporation.getOffice(division, city).employeeJobs;
    let ok = true;
    const set = (job, count) => {
        try {
            if (ns.corporation.setJobAssignment(division, city, job, count) === false) ok = false;
        } catch (e) {
            ok = false;
            corpLog(ns, `${division}/${city}: cannot set ${job}=${count}: ${e?.message ?? e}`, "WARN");
        }
    };
    for (const job of SETTABLE_JOBS) if (!(job in jobs)) set(job, 0);
    for (const [job, count] of Object.entries(jobs).sort((a, b) => a[1] - b[1])) set(job, count);
    if (!ok) corpLog(ns, `${division}/${city}: some job assignments failed`, "WARN");
    else if (Object.entries(jobs).some(([job, count]) => before[job] !== count)) corpLog(ns, `${division}/${city}: jobs ${JSON.stringify(jobs)}`);
    return ok;
}

/** Inline port of Corp/corp-ops.js waitForOffer: let the current offer grow for initCycles, then up to
 * maxExtraCycles more while it keeps rising by >= 0.1% per cycle. @returns {number} funds left on the table **/
async function waitForOffer(ns, initCycles, maxExtraCycles, expectedFunds) {
    const funds = () => ns.corporation.getInvestmentOffer().funds;
    for (let i = 0; i < initCycles; i++) await ns.corporation.nextUpdate();
    let offer = funds();
    for (let i = 0; i < maxExtraCycles; i++) {
        await ns.corporation.nextUpdate();
        const now = funds();
        if (i % 2 === 0) corpLog(ns, `offer ${formatMoney(now)}`);
        if (now < offer * 1.001) break; // it stopped growing - take what is on the table
        offer = now;
    }
    const final = funds();
    if (final < expectedFunds) corpLog(ns, `offer ${formatMoney(final)} is below the expected ${formatMoney(expectedFunds)}`, "WARN");
    return final;
}

/** Inline port of Corp/corp-ops.js acceptOffer: refuse an offer below minFraction of the expected one
 * (§19 FAQ p10) instead of accepting it. @returns {boolean} **/
function acceptOffer(ns, offerRound, expectedFunds, minFraction) {
    const offered = ns.corporation.getInvestmentOffer().funds;
    if (offered < minFraction * expectedFunds) {
        corpLog(ns, `refused round ${offerRound} offer ${formatMoney(offered)}: under ${Math.round(minFraction * 100)}% of the expected ${formatMoney(expectedFunds)}`, "ERROR");
        return false;
    }
    let accepted = false;
    try {
        accepted = ns.corporation.acceptInvestmentOffer(); // THROWS when there is no offer left
    } catch (e) {
        corpLog(ns, `acceptInvestmentOffer() threw for ${formatMoney(offered)}: ${e?.message ?? e}`, "ERROR");
        return false;
    }
    if (!accepted) {
        corpLog(ns, `acceptInvestmentOffer() returned false for ${formatMoney(offered)}`, "ERROR");
        return false;
    }
    corpLog(ns, `accepted round ${offerRound} offer of ${formatMoney(offered)}`, "MILESTONE");
    return true;
}

/** Step 6: after offer 4, go public with 0 new shares (§17.5 p64 - the dividend is the point; the player's
 * shares are never sold) and set the dividend rate (§17.4 p64: issue it only AFTER offer 4, it lowers the
 * valuation). Idempotent: once corp.public is true this is a no-op. Never touches sellShares/issueNewShares/
 * sellDivision/bribe - those are consequential and the user's decision. **/
function goPublicAndDividends(ns, cfg, corp, mem) {
    if (!cfg.goPublic || corp.public) return;
    let ok = false;
    try {
        ok = ns.corporation.goPublic(0);
    } catch (e) {
        warnOnce(ns, mem, "gopublic", `goPublic(0) threw: ${e?.message ?? e}`);
        return;
    }
    if (!ok) {
        warnOnce(ns, mem, "gopublic", "goPublic(0) returned false - still private, will retry");
        return;
    }
    try {
        ns.corporation.issueDividends(cfg.dividendRate); // requires a public corporation
    } catch (e) {
        corpLog(ns, `corporation is public, but issueDividends(${cfg.dividendRate}) threw: ${e?.message ?? e}`, "ERROR");
        return;
    }
    corpLog(ns, `corporation is public (0 new shares) with dividend rate ${cfg.dividendRate} - the profit now reaches the player`, "MILESTONE");
}

/** OFFER_PREP_FILE is "1" while the product division's offices are being prepared for an offer. Written only
 * on a change (0 GB, but no reason to rewrite every cycle). **/
function writeFlag(ns, file, value) {
    try {
        if (ns.read(file) !== value) ns.write(file, value, "w");
    } catch (e) {
        corpLog(ns, `could not write ${file}: ${e?.message ?? e}`, "WARN");
    }
}

/** Step 2/4: getProduct needs the CITY and THROWS before the product is readable. @returns {object|null} **/
function readProduct(ns, division, city, name) {
    try {
        return ns.corporation.getProduct(division, city, name);
    } catch {
        return null;
    }
}

/** corpLog a WARN at most once per `key` per WARN_INTERVAL cycles, and once for a fixed warning. **/
function warnOnce(ns, mem, key, message) {
    const last = mem.warned.get(key);
    if (last !== undefined && mem.cycle - last < WARN_INTERVAL) return;
    mem.warned.set(key, mem.cycle);
    corpLog(ns, message, "WARN");
}

// ---------------------------------------------------------------------------------------------
// Offline self-check (fabricated game state + mock ns - proves the wiring, NOT in-game correctness).

/** Minimal fake NS for the check below: only the APIs this file touches. setJobAssignment follows the real
 * semantics (absolute count, counted against the PENDING assignment, throws when there are not enough
 * Unassigned employees); nextUpdate() makes the pending assignment live, like a START does. **/
function mockNs(state) {
    const calls = { setJob: [], accept: 0, goPublic: [], dividends: [] };
    const lines = [];
    const files = { [OFFER_PREP_FILE]: state.prepFlag ?? "" };
    const offices = Object.fromEntries(
        Object.entries(state.offices).map(([city, o]) => {
            const pending = {};
            for (const job of SETTABLE_JOBS) pending[job] = 0;
            pending[o.job ?? JOBS.rnd] = o.size;
            return [city, { city, size: o.size, numEmployees: o.size, employeeJobs: { ...pending }, pending }];
        }),
    );
    return {
        calls,
        lines,
        files,
        print: () => {},
        getScriptName: () => "Corp/corp-offers.js",
        getPortHandle: () => ({ write: (line) => lines.push(line) }),
        fileExists: () => state.officesScript === true,
        read: (file) => files[file] ?? "",
        write: (file, data) => {
            files[file] = data;
        },
        sleep: () => Promise.resolve(),
        run: () => 1,
        isRunning: () => false,
        getScriptRam: () => 1,
        getServerMaxRam: () => 1e6,
        getServerUsedRam: () => 1,
        corporation: {
            nextUpdate: async () => {
                for (const o of Object.values(offices)) o.employeeJobs = { ...o.pending }; // assignments become live at START
                state.round = state.roundAfterAccept ?? state.round;
                if (state.offerFundsAfterAccept !== undefined) state.offerFunds = state.offerFundsAfterAccept;
                return "START";
            },
            hasCorporation: () => true,
            getCorporation: () => ({ ...state.corp, public: state.corp.public }),
            getInvestmentOffer: () => ({ funds: state.offerFunds, round: state.round, shares: 0 }),
            getDivision: () => ({ name: TOB_NAME, cities: Object.keys(offices), products: state.products.map((p) => p.name) }),
            getOffice: (_d, city) => offices[city],
            getProduct: (_d, _c, name) => {
                const p = state.products.find((x) => x.name === name);
                if (p === undefined) throw new Error(`no such product: ${name}`);
                return { ...p };
            },
            setJobAssignment: (_d, city, job, count) => {
                const office = offices[city];
                const delta = count - office.pending[job];
                const unassigned = office.size - SETTABLE_JOBS.reduce((sum, j) => sum + office.pending[j], 0);
                if (delta > unassigned) throw new Error(`Requires ${delta} unassigned employees`);
                office.pending[job] = count;
                calls.setJob.push({ city, job, count });
            },
            acceptInvestmentOffer: () => {
                calls.accept++;
                state.round = state.roundAfterAccept ?? state.round;
                if (state.offerFundsAfterAccept !== undefined) state.offerFunds = state.offerFundsAfterAccept;
                return true;
            },
            goPublic: (shares) => {
                calls.goPublic.push(shares);
                state.corp.public = true;
                return true;
            },
            issueDividends: (rate) => calls.dividends.push(rate),
        },
    };
}

const product = (name, developmentProgress = 100, effectiveRating = 1) => ({ name, developmentProgress, effectiveRating });

/** A round-3/4 Tobacco corporation: Sector-12 main office (138 employees, all R&D) + one support office. **/
function fakeState({ products = [], ...rest } = {}) {
    return {
        corp: { funds: 1e12, divisions: [TOB_NAME], public: false },
        round: 3,
        offerFunds: 1e16,
        offices: { "Sector-12": { size: 138 }, Aevum: { size: 33 } },
        products,
        ...rest,
    };
}

const CFG = { productCity: "Sector-12", dividendRate: 0.5, goPublic: true, minFraction: 0.8, offerScale: 1, division: TOB_NAME };

/** Runnable check (no game needed):
 *   node --input-type=module -e "import('./Corp/corp-offers.js').then(m=>m.selfCheck()).then(r=>console.log('selfCheck:',r))"
 * Throws on the first failure. Proves the pure math + the service wiring with a mock NS - NOT in-game correctness. **/
export async function selfCheck() {
    const must = (ok, label) => {
        if (!ok) throw new Error(`selfCheck: ${label}`);
    };
    const same = (a, b, label) => must(JSON.stringify(a) === JSON.stringify(b), `${label}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
    const run = (state, mem = newMemory(), cfg = CFG) => {
        const ns = mockNs(state);
        return runCycle(ns, cfg, mem).then(() => ({ ns, mem }));
    };

    // Acceptance 1, verbatim: ratiosToCounts(profitRatio(round), size) on the ratio table's own denominators.
    same(ratiosToCounts(profitRatio(3), 138), [49, 5, 51, 33], "ratiosToCounts(profitRatio(3), 138)");
    same(ratiosToCounts(profitRatio(4), 369), [68, 12, 244, 45], "ratiosToCounts(profitRatio(4), 369)");
    // ...and the support-office rule agrees with it at those sizes, so one ratio serves both offices.
    same(Object.values(profitOfficeJobs(profitRatio(3), 138)).slice(0, 4), [49, 5, 51, 33], "profitOfficeJobs round 3 @138");
    same(Object.values(profitOfficeJobs(profitRatio(4), 369)).slice(0, 4), [68, 12, 244, 45], "profitOfficeJobs round 4 @369");
    // The ">= 1 each of ops/eng/biz" rule: size 20 sums to 20 with no zero job (round 4 alone floors Engineer to 0).
    for (const round of [3, 4]) {
        const jobs = profitOfficeJobs(profitRatio(round), 20);
        const counts = [jobs[JOBS.ops], jobs[JOBS.eng], jobs[JOBS.biz], jobs[JOBS.mgmt]];
        must(counts.reduce((a, b) => a + b, 0) === 20, `round ${round} jobs sum to 20: ${JSON.stringify(counts)}`);
        must(counts.every((c) => c >= 1), `round ${round} every job >= 1: ${JSON.stringify(counts)}`);
        must(jobs[JOBS.rnd] === 0, `round ${round} R&D is 0`);
    }
    same(expectedOfferFor(3, 1), 1e16, "expectedOfferFor(3, 1)");
    same(expectedOfferFor(4, 0.001), 1e17, "expectedOfferFor(4, 0.001)");

    // The product-count gate (1P/2P).
    const done = (id) => product(`Ebon Stick-0000${id}-1.00000e+9`);
    must(!offerGate([], 3).open, "round 3 with no product is closed");
    must(!offerGate([product("Ebon Stick-00000-1.00000e+9", 42)], 3).open, "round 3 with a developing product is closed");
    must(offerGate([done(0)], 3).open, "round 3 with one finished product is open");
    must(!offerGate([done(0)], 4).open, "round 4 with one product is closed (2P)");
    must(!offerGate([done(0), product("Ebon Stick-00001-1.00000e+9", 99)], 4).open, "round 4 with a developing second product is closed");
    must(offerGate([done(0), done(1)], 4).open, "round 4 with two finished products is open");

    // Rounds 1/2 belong to the phase jobs: nothing is touched and nothing is accepted.
    for (const round of [1, 2]) {
        const { ns } = await run(fakeState({ round, offerFunds: 5e11, products: [done(0)] }));
        must(ns.calls.setJob.length === 0 && ns.calls.accept === 0, `round ${round} does nothing`);
        must(ns.files[OFFER_PREP_FILE] === "", `round ${round} writes no prep flag`);
    }

    // Round 3, one finished product: the profit setup (main office 49/5/51/33 of 138, support >= 1 each, R&D 0),
    // the offer is waited for and accepted once, the prep flag is cleared and T19 is missing -> WARN.
    let r = await run(fakeState({ products: [done(0)] }));
    must(r.ns.calls.accept === 1, `round 3 accepts once: ${r.ns.calls.accept}`);
    must(r.ns.lines.some((l) => l.includes("accepted round 3 offer")), `round 3 MILESTONE: ${r.ns.lines}`);
    must(r.ns.files[OFFER_PREP_FILE] === "0", `prep flag cleared: ${r.ns.files[OFFER_PREP_FILE]}`);
    must(r.ns.lines.some((l) => l.includes("not installed (T19)")), `missing T19 is a WARN: ${r.ns.lines}`);
    const main = Object.fromEntries(r.ns.calls.setJob.filter((c) => c.city === "Sector-12").map((c) => [c.job, c.count]));
    must(
        main[JOBS.ops] === 49 && main[JOBS.eng] === 5 && main[JOBS.biz] === 51 && main[JOBS.mgmt] === 33 && main[JOBS.rnd] === 0,
        `main office round-3 profit setup: ${JSON.stringify(main)}`,
    );
    const support = Object.fromEntries(r.ns.calls.setJob.filter((c) => c.city === "Aevum").map((c) => [c.job, c.count]));
    must(support[JOBS.rnd] === 0 && support[JOBS.ops] >= 1 && support[JOBS.eng] >= 1 && support[JOBS.biz] >= 1, `support office setup: ${JSON.stringify(support)}`);

    // The same round is never accepted twice: after the accept the offer round advances, and even a stale round
    // reading is blocked by mem.accepted.
    const stale = await run(fakeState({ products: [done(0)] }), r.mem); // round is still 3 in this fabricated state
    must(stale.ns.calls.accept === 0, `a stale round reading is not accepted again: ${stale.ns.calls.accept}`);
    const after = await run(fakeState({ round: 4, offerFunds: 1e20, products: [done(0), done(1)] }), r.mem);
    must(after.ns.calls.accept === 1, `round 4 is accepted once: ${after.ns.calls.accept}`);

    // A product in its last 2% writes the pre-accept flag (T19 must not rebalance those offices).
    r = await run(fakeState({ products: [product("Ebon Stick-00000-1.00000e+9", 99)] }));
    must(r.ns.calls.accept === 0 && r.ns.files[OFFER_PREP_FILE] === "1", `pre-accept flag: ${r.ns.files[OFFER_PREP_FILE]}`);
    must(!r.ns.lines.some((l) => l.includes("refused")), "a developing product is not an offer error");

    // ...and the flag must not LATCH: once the newest product is out of its last 2% without an accept (round 4
    // develops several products), the next cycle clears it - otherwise T18/T19 freeze that division's offices
    // for the whole round. Starting run reads the flag left by the run above.
    r = await run(fakeState({ products: [product("Ebon Stick-00000-1.00000e+9", 42)], prepFlag: "1" }));
    must(r.ns.files[OFFER_PREP_FILE] === "0", `stale prep flag cleared: ${r.ns.files[OFFER_PREP_FILE]}`);

    // A finished product whose effectiveRating is still 0 waits one more cycle (reference 792).
    r = await run(fakeState({ products: [product("Ebon Stick-00000-1.00000e+9", 100, 0)] }));
    must(r.ns.calls.accept === 0 && r.ns.calls.setJob.length === 0, "effectiveRating 0 waits");

    // An offer under the floor is refused, not accepted (FAQ p10), and the profit setup stays in place.
    r = await run(fakeState({ offerFunds: 1e15, products: [done(0)] }));
    must(r.ns.calls.accept === 0, "an offer under 80% is refused");
    must(r.ns.lines.some((l) => l.includes("refused round 3 offer")), `refusal is logged: ${r.ns.lines}`);

    // Round 5 (offer 4 taken / public): go public with 0 new shares, set the dividend once, never sell shares.
    // One state object for both runs: goPublic makes it public for the second one.
    const publicState = fakeState({ round: 5, offerFunds: 0, products: [done(0), done(1)] });
    r = await run(publicState);
    same(r.ns.calls.goPublic, [0], "goPublic(0)");
    same(r.ns.calls.dividends, [0.5], "issueDividends(0.5)");
    must(r.ns.lines.some((l) => l.includes("is public (0 new shares) with dividend rate 0.5")), `public MILESTONE: ${r.ns.lines}`);
    must(r.ns.calls.setJob.length === 0, "no office work after offer 4");
    const again = await run(publicState, r.mem);
    must(again.ns.calls.goPublic.length === 0 && again.ns.calls.dividends.length === 0, "a public corporation is not re-floated");

    // --go-public false: the dividend is never issued on its own.
    r = await run(fakeState({ round: 5, offerFunds: 0 }), newMemory(), { ...CFG, goPublic: false });
    must(r.ns.calls.goPublic.length === 0, "go-public false stays private");

    return true;
}
