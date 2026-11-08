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
 * That same post-public branch is where the bribe lives: on a BitNode whose CorporationSoftcap < 1 the dividend
 * transfer is crushed (`payout^(softcap-0.15)`, Corporation.ts getCycleDividends) to the point where
 * `ns.corporation.bribe` (a flat 1e9 corporation funds per reputation) beats dividend -> donation (1e6 per rep,
 * Faction/formulas/donation.ts), so `--bribe-share` of each cycle's PROFIT goes to the factions
 * faction-manager.js still needs augmentations from (`/Temp/affordable-augs.txt` -> `rep_needed_by_faction`,
 * written at faction-manager.js:222). Additive to the dividend - never a replacement - and derived from profit,
 * so the offers' seed capital (which sits in `funds`) can never be spent on it. `--bribe-share 0` disables it.
 *
 * Distinct ns.corporation.* APIs referenced by THIS file (docs figures from CONTEXT §4, NOT measured - `mem`):
 *   0 GB : hasCorporation nextUpdate getConstants
 *   10 GB: getCorporation getDivision getInvestmentOffer getOffice getProduct
 *   20 GB: acceptInvestmentOffer goPublic issueDividends setJobAssignment bribe
 *   => 5 x 10 GB + 5 x 20 GB = 150 GB for the corporation API alone, plus ns.getPlayer() 0.5 GB (the joined
 *      factions the bribe targets must be members of) and the imports: helpers.js (~16.4 GB),
 *      corp-lib.js (ns.run 1, ns.getScriptRam 0.1, ns.isRunning 0.1, ns.getServerMaxRam/UsedRam 0.05 each,
 *      rest 0 GB) and corp-formulas.js (pure, 0 GB). Deliberately does NOT import Corp/corp-ops.js: its
 *      13-read/16-action union would blow this service's budget for four small inline helpers (assignJobs,
 *      waitForOffer, acceptOffer) that cost nothing extra - all four calls they need are already in the list
 *      above. `acceptInvestmentOffer` needs an offer; `issueDividends` needs a public corporation; both are
 *      wrapped. docs sum ~168 GB.
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
import { formatMoney, getConfiguration } from "../helpers.js";
import { BN_FILE, JOBS, OFFER_PREP_FILE, TOB_NAME, alreadyRunning, corpLog, offerMode, runWorker } from "./corp-lib.js";
import { allowedProductCeiling, parseProductId, ratiosToCounts } from "./corp-formulas.js";

const OFFICES_SCRIPT = "Corp/corp-offices.js"; // T19 (P4): restores the normal office setup after an offer
const AUG_GOALS_FILE = "/Temp/affordable-augs.txt"; // written by ../faction-manager.js:17 (same literal as autopilot.js:136)
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
    ["bribe-share", 0.1], // post-public + harsh-softcap nodes only: share of each market cycle's PROFIT converted to faction reputation via ns.corporation.bribe (additive to --dividend-rate; the two together must stay < 1)
    ["bribe-faction", ""], // comma-separated faction names to bribe instead of faction-manager.js's aug goals; empty = use the goals
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
 * count is compared both ways (same rule as T13).
 *
 * LOW mode: the product COUNT is a money-driven BN3 optimization (1 product in round 3, 2 in round 4), which a
 * low-offer node cannot pay for, so the gate drops it and opens as soon as nothing is mid-development. The
 * phase tables guarantee this service only runs with the round's product division already in place. **/
export function offerGate(products, offerRound, mode = "GENERIC") {
    const ceiling = allowedProductCeiling(offerRound);
    const named = products.map((p) => parseProductId(p.name)).filter(Number.isFinite);
    const developed = named.length === 0 ? 0 : Math.max(...named) + 1;
    const count = Math.max(developed, products.length);
    const allFinished = products.length > 0 && products.every((p) => p.developmentProgress >= 100);
    const open = mode === "LOW" ? products.length === 0 || allFinished : count >= ceiling && allFinished;
    return { open, developed: count, ceiling, allFinished };
}

/** Is this BitNode's dividend transfer harsh enough that a flat faction bribe beats it?
 *
 * The player receives `(dividend payout)^(softcap - 0.15)` (Corporation.getCycleDividends:
 * `Math.pow(dividends, 1 - tributeModifier)`, tributeModifier = 1 - CorporationSoftcap + 0.15), while a bribe
 * pays a flat `bribeAmountPerReputation` (1e9) of corporation funds per reputation
 * (Corporation/Actions.ts bribe). Spending S of corporation funds therefore buys `S/1e9` rep as a bribe but
 * `S^(softcap-0.15)/1e6` rep through dividend -> donation (Faction/formulas/donation.ts), so the bribe only
 * wins above S = 10^(3/(1-e)) with e = softcap - 0.15:
 *   softcap 1.00 (e=0.85, BN1/3/4/5)     -> 1e20  : unreachable - the dividend always wins
 *   softcap 0.90 (e=0.75, BN2/6/7/10/11) -> 1e12  : a matured public corporation exceeds this
 *   softcap 0.80 (e=0.65, BN12)          -> 4e8
 *   softcap 0.75 (e=0.60, BN9)           -> 3e7
 *   softcap 0.40 (e=0.25, BN13)          -> 1e4   : the dividend route is dead
 * so "harsh" is simply "the node haircuts the dividend transfer at all". Pure - checked below. **/
export function softcapIsHarsh(softcap) {
    return Number(softcap ?? 1) < 1;
}

/** The post-public bribe for THIS cycle: which factions, how much each, or why not. PURE.
 *
 * The budget is `--bribe-share` of ONE market cycle's profit - the same anchor the game uses for dividends
 * (`getCycleDividends`: dividendRate x cycleProfit), which is what makes this an addition to the dividend
 * rather than a replacement, and what keeps the offers' seed capital (which sits in `funds`) out of it.
 * @param {{public:boolean, funds:number, revenue:number, expenses:number, valuation:number, dividendRate:number}} corp
 * @param {object} cfg {softcap, bribeShare, bribeThreshold, bribeAmountPerReputation, secondsPerMarketCycle, dividendRate}
 * @param {string[]} factions goal factions for this cycle (see bribeTargets)
 * @returns {{online:boolean, why:string, targets:{faction:string, amount:number}[]}} **/
export function bribePlan(corp, cfg, factions) {
    const off = (why) => ({ online: false, why, targets: [] });
    if (!corp?.public) return off("still pre-offer - the dividend alone until the offers are done");
    if (!softcapIsHarsh(cfg.softcap)) return off(`softcap ${cfg.softcap} is not harsh - the dividend already pays`);
    if (!(cfg.bribeShare > 0)) return off("--bribe-share 0");
    // On the cycle the corporation goes public the live dividendRate is still 0, so the configured one is the
    // number that matters there (issueDividends runs in the same cycle, before this).
    const rate = Math.max(Number(corp.dividendRate ?? 0), Number(cfg.dividendRate ?? 0));
    if (cfg.bribeShare + rate >= 1) return off(`--bribe-share ${cfg.bribeShare} + dividend ${rate} would spend the whole profit`);
    if (Number(corp.valuation) < cfg.bribeThreshold) return off(`valuation is under the game's bribe threshold ${formatMoney(cfg.bribeThreshold)}`);
    const profit = Number(corp.revenue ?? 0) - Number(corp.expenses ?? 0);
    if (!(profit > 0)) return off("no profit to share");
    if (!factions.length) return off("no faction to bribe");
    const spend = profit * cfg.secondsPerMarketCycle * cfg.bribeShare;
    if (spend > corp.funds) return off(`this cycle's share ${formatMoney(spend)} is more than the corporation holds (${formatMoney(corp.funds)})`);
    const perFaction = Math.floor(spend / factions.length);
    if (perFaction < cfg.bribeAmountPerReputation) // less than one whole reputation point per faction is money thrown away
        return off(`this cycle's share ${formatMoney(perFaction)} per faction is under one reputation (${formatMoney(cfg.bribeAmountPerReputation)})`);
    return { online: true, why: "", targets: factions.map((faction) => ({ faction, amount: perFaction })) };
}

/** Session memory of the running service. Every decision is re-derived from the game, so a restart costs
 * nothing but a repeated log line; this only stops duplicate INFO/WARN/MILESTONE spam. **/
function newMemory() {
    return {
        cycle: 0,
        accepted: new Set(), // offer rounds already accepted (belt and braces against a double accept)
        waiting: new Set(), // rounds whose "waiting" line was already printed
        warned: new Map(), // warn key -> the cycle it was last logged
        bribed: 0, // successful bribes this run (first-success MILESTONE + the throttled summary)
        bribedSpent: 0,
        bribeFailed: new Set(), // factions that refused this run - asked at most once per run
    };
}

/** @param {NS} ns **/
export async function main(ns) {
    const options = getConfiguration(ns, argsSchema);
    if (!options || alreadyRunning(ns)) return;
    ns.disableLog("ALL");

    // Step 7: in BN8 (and any BN whose CorporationValuation is 0) every offer is worthless - stop the service.
    let profile = null;
    try {
        profile = JSON.parse(ns.read(BN_FILE)); // 0 GB; written by T08. Missing file => BN3 defaults.
    } catch {
        profile = null;
    }
    const offerScale = Number(profile?.offerScale ?? 1);
    const mode = offerMode(offerScale); // LOW on a BitNode whose CorporationValuation is < 0.3, see corp-lib
    const constants = ns.corporation.getConstants(); // 0 GB; bribeThreshold / bribeAmountPerReputation / secondsPerMarketCycle

    const cfg = {
        productCity: String(options["product-city"]),
        dividendRate: Number(options["dividend-rate"]),
        goPublic: options["go-public"] !== false,
        minFraction: Number(options["min-fraction"]),
        offerScale: offerScale,
        mode: mode,
        division: TOB_NAME,
        softcap: Number(profile?.softcap ?? 1), // T08: a harsh softcap crushes the dividend transfer, the bribe pays
        bribeShare: Number(options["bribe-share"]),
        bribeFactions: String(options["bribe-faction"]).split(",").map((s) => s.trim()).filter(Boolean),
        bribeThreshold: constants.bribeThreshold,
        bribeAmountPerReputation: constants.bribeAmountPerReputation,
        secondsPerMarketCycle: constants.secondsPerMarketCycle,
    };
    if (!(offerScale > 0)) {
        corpLog(ns, `offerScale is ${offerScale} (BN8 or no CorporationValuation): offers are worthless here - not accepting any offer`, "ERROR");
        return;
    }
    const mem = newMemory();
    corpLog(
        ns,
        `offer service starting (division=${cfg.division}, product-city=${cfg.productCity}, offerScale=${offerScale}, mode=${mode}, go-public=${cfg.goPublic}, dividend-rate=${cfg.dividendRate}, min-fraction=${cfg.minFraction}, softcap=${cfg.softcap}, bribe-share=${cfg.bribeShare})`,
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
        bribeFromProfit(ns, cfg, corp, mem); // post-public money-out: --bribe-share of the profit -> faction rep
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
    const gate = offerGate(products, offerRound, cfg.mode);
    // LOW: no amount is targeted (the guide writer: on such a node the offer is a fraction of the guide's
    // number), so everything is "in reach" and acceptOffer(0) takes whatever is on the table.
    const expected = cfg.mode === "LOW" ? 0 : expectedOfferFor(offerRound, cfg.offerScale);
    const newestMidway = newest !== null && newest.developmentProgress > PREP_PROGRESS_LOW && newest.developmentProgress < 100;
    // The guide switches to the profit setup "right before accepting offer" (§19.4.2 p78) - i.e. when the offer
    // is already worth taking. While it is out of reach there is nothing to squeeze, and the profit setup (plus
    // the prep flag that goes with it) freezes the division's Engineer work AND its R&D offices for as long as
    // the offer stays low: T18 skips the offices step and T19 never re-staffs them, so no research points
    // accumulate and no office size is bought. In-game that pinned a round-4 corp to the rich 68/12/244/45
    // ratio with R&D 0 in all six cities for hours (tobacco RP stuck at 17k) while the offer was ~1000x under
    // the round's milestone - the freeze was the reason it could not grow into the offer.
    const inReach = gate.open && offer.funds >= expected * cfg.minFraction;
    writeFlag(ns, OFFER_PREP_FILE, inReach || newestMidway ? "1" : "0");
    if (!gate.open) {
        warnOnce(
            ns,
            mem,
            `gate:${offerRound}`,
            `${division}: round ${offerRound} accepts at ${gate.ceiling} product(s) fully developed, ${gate.developed} developed, all finished: ${gate.allFinished}`,
        );
        return;
    }
    if (!inReach) {
        warnOnce(
            ns,
            mem,
            `reach:${offerRound}`,
            `${division}: round ${offerRound} offer ${formatMoney(offer.funds)} is under ${formatMoney(expected * cfg.minFraction)} - leaving the round's own office setup in place (Engineer production + R&D) instead of the profit setup until the offer is in reach`,
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
    await waitForOffer(ns, OFFER_WAIT_CYCLES, OFFER_WAIT_EXTRA, expected); // lets the offer grow on the profit setup
    if (!acceptOffer(ns, offerRound, expected, cfg.minFraction)) {
        // Below the floor after all (the offer can dip while we wait): hand the offices back, so the corp keeps
        // producing and researching instead of sitting in the profit setup until the next attempt.
        writeFlag(ns, OFFER_PREP_FILE, "0");
        await restoreNormalSetup(ns, division);
        return;
    }
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

/** Wait for `n` WHOLE corporation cycles (a cycle = the 5 states, nextUpdate() resolves per STATE) - the
 * reference's waitForNumberOfCycles counts a state RECURRING, so raw nextUpdate() calls are 5x too short. **/
async function waitForCycles(ns, n) {
    for (let i = 0; i < n; i++) {
        const state = ns.corporation.getCorporation().prevState;
        do {
            await ns.corporation.nextUpdate();
        } while (ns.corporation.getCorporation().prevState !== state);
    }
}

/** Inline port of Corp/corp-ops.js waitForOffer: let the current offer grow for initCycles, then up to
 * maxExtraCycles more while it keeps rising by >= 0.1% per cycle. @returns {number} funds left on the table **/
async function waitForOffer(ns, initCycles, maxExtraCycles, expectedFunds) {
    const funds = () => ns.corporation.getInvestmentOffer().funds;
    await waitForCycles(ns, initCycles);
    let offer = funds();
    for (let i = 0; i < maxExtraCycles; i++) {
        await waitForCycles(ns, 1);
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
        // INFO, not ERROR: this is the normal waiting condition of a round whose offer has not grown yet, and
        // waitForOffer() has just WARNed the same numbers - the daemon tprints (red, in the terminal) every
        // ERROR, which turned a recurring "still too low" into an alert.
        corpLog(ns, `refused round ${offerRound} offer ${formatMoney(offered)}: under ${Math.round(minFraction * 100)}% of the expected ${formatMoney(expectedFunds)}`);
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

/** faction-manager.js's aug-goal summary out of /Temp/affordable-augs.txt (0 GB read), or null when it is
 * missing / empty / unreadable. autopilot.js reads the same file (getFactionManagerOutput). **/
function readAugGoals(ns) {
    try {
        return JSON.parse(ns.read(AUG_GOALS_FILE)) ?? null;
    } catch {
        return null;
    }
}

/** Which factions may be bribed this cycle: `--bribe-faction "A,B"` when given, otherwise the factions
 * faction-manager.js still needs reputation with (`rep_needed_by_faction`) - that map is its "augs we still
 * want" goal, so it self-terminates per faction once that faction's reputation covers what it offers, and it
 * never lists a faction whose augs are all owned. Both paths keep only factions we are actually in (the game
 * requires membership) and drop the ones the game has already refused this run.
 * ponytail: the goal file carries no timestamp, so a stale-but-present file keeps targeting last run's
 * factions; add an `asOf` key to it if that ever shows up in-game. **/
function bribeTargets(ns, cfg, mem) {
    const joined = ns.getPlayer().factions ?? [];
    const want = (faction) => joined.includes(faction) && !mem.bribeFailed.has(faction);
    if (cfg.bribeFactions.length) return cfg.bribeFactions.filter(want);
    const goals = readAugGoals(ns);
    if (!goals) {
        if (mem.cycle % WARN_INTERVAL === 0) corpLog(ns, `no aug goals from faction-manager.js yet (${AUG_GOALS_FILE}) - nothing to bribe for`);
        return [];
    }
    return Object.keys(goals.rep_needed_by_faction ?? {}).filter(want);
}

/** Post-public money-out step: convert `--bribe-share` of this cycle's PROFIT into faction reputation for the
 * factions we still need augs from. Additive to the dividend (a second share of the same profit, never a
 * replacement - see bribePlan for why a bribe pays where the dividend transfer is haircut), and never the
 * offers' seed capital, which sits in `funds` and is only read as a floor. Runs once per cycle from runCycle;
 * every gate is re-derived from the game each cycle, so a restart costs nothing. **/
function bribeFromProfit(ns, cfg, corp, mem) {
    const plan = bribePlan(corp, cfg, bribeTargets(ns, cfg, mem));
    if (!plan.online) {
        if (mem.cycle % WARN_INTERVAL === 0) corpLog(ns, `no faction bribes this cycle: ${plan.why}`);
        return;
    }
    let factionsBribed = 0;
    let spent = 0;
    for (const { faction, amount } of plan.targets) {
        let accepted = false;
        try {
            accepted = ns.corporation.bribe(faction, amount); // 20 GB; returns false (never throws) for a refused faction
        } catch (e) {
            mem.bribeFailed.add(faction);
            warnOnce(ns, mem, `bribe-threw:${faction}`, `bribe(${faction}, ${formatMoney(amount)}) threw: ${e?.message ?? e}`);
            continue;
        }
        if (!accepted) {
            mem.bribeFailed.add(faction);
            warnOnce(ns, mem, `bribe-refused:${faction}`, `${faction} refused a bribe of ${formatMoney(amount)} - skipping it for this run`);
            continue;
        }
        factionsBribed++;
        spent += amount;
    }
    if (factionsBribed === 0) return;
    const firstOfRun = mem.bribed === 0;
    mem.bribed += factionsBribed;
    mem.bribedSpent += spent;
    // Event line, not a healthcheck: the first bribe of a run is the one the player must not have to look for.
    if (firstOfRun)
        corpLog(ns, `first faction bribe: ${factionsBribed} faction(s) for ${formatMoney(spent)} (~${formatMoney(spent / cfg.bribeAmountPerReputation)} rep)`, "MILESTONE");
    else if (mem.cycle % 20 === 0)
        corpLog(ns, `bribed ${factionsBribed} faction(s), spent≈${formatMoney(spent)}, ~${formatMoney(spent / cfg.bribeAmountPerReputation)} rep; total ${formatMoney(mem.bribedSpent)}`);
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
    const calls = { setJob: [], accept: 0, goPublic: [], dividends: [], bribe: [] };
    const lines = [];
    const files = { [OFFER_PREP_FILE]: state.prepFlag ?? "", [AUG_GOALS_FILE]: state.augGoals ?? "" };
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
        getPlayer: () => ({ factions: state.factions ?? [] }),
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
            bribe: (faction, amount) => {
                calls.bribe.push({ faction, amount });
                return !(state.bribeRefuses ?? []).includes(faction);
            },
        },
    };
}

const product = (name, developmentProgress = 100, effectiveRating = 1) => ({ name, developmentProgress, effectiveRating });

/** A round-3/4 Tobacco corporation: Sector-12 main office (138 employees, all R&D) + one support office. **/
function fakeState({ products = [], ...rest } = {}) {
    return {
        corp: { funds: 1e12, divisions: [TOB_NAME], public: false, revenue: 0, expenses: 0, valuation: 1e14, dividendRate: 0.5 },
        factions: ["CyberSec", "NiteSec"],
        round: 3,
        offerFunds: 1e16,
        offices: { "Sector-12": { size: 138 }, Aevum: { size: 33 } },
        products,
        ...rest,
    };
}

const CFG = { productCity: "Sector-12", dividendRate: 0.5, goPublic: true, minFraction: 0.8, offerScale: 1, mode: "GENERIC", division: TOB_NAME, softcap: 1, bribeShare: 0.1, bribeFactions: [], bribeThreshold: 100e12, bribeAmountPerReputation: 1e9, secondsPerMarketCycle: 10 };

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

    // offerGate per mode: GENERIC waits for the round's product COUNT (1P in round 3, 2P in round 4), LOW only
    // for "nothing is mid-development" - the count is a BN3 optimization a low-offer node cannot pay for, and
    // on such a node round 3 has no product division at all (Chemical is round 3's investment there).
    const midProduct = { name: `${TOB_NAME}-00000-1.00000e+9`, developmentProgress: 40 };
    const doneProduct = { name: `${TOB_NAME}-00000-1.00000e+9`, developmentProgress: 100 };
    const doneSecond = { name: `${TOB_NAME}-00001-1.00000e+9`, developmentProgress: 100 };
    must(offerGate([], 3, "LOW").open, "LOW round 3 with no products accepts on the peak alone");
    must(!offerGate([midProduct], 4, "LOW").open, "LOW round 4 waits for its product to finish");
    must(offerGate([doneProduct], 4, "LOW").open, "LOW round 4 accepts one finished product");
    must(!offerGate([doneProduct], 4, "GENERIC").open, "GENERIC round 4 still wants 2 products");
    must(offerGate([doneProduct, doneSecond], 4, "GENERIC").open, "GENERIC round 4 accepts 2 finished products");
    must(offerGate([], 3).open === false, "default mode stays GENERIC");

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

    // The product-count gate (1P/2P). The fixtures carry the pre-2026-11-08 long names on purpose: those are
    // the products already in the game, and parseProductId still numbers past them.
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

    // An offer under the floor is neither prepared for nor accepted (FAQ p10). The profit setup must NOT be
    // applied: holding it (plus the prep flag that goes with it) freezes the division's Engineer work and its
    // R&D offices, which is exactly what a corp that cannot reach the round's milestone needs to grow - it
    // pinned a round-4 corp in-game for hours (R&D 0 everywhere, tobacco RP stuck at 17k).
    r = await run(fakeState({ offerFunds: 1e15, products: [done(0)] }));
    must(r.ns.calls.accept === 0, "an offer under 80% is refused");
    must(r.ns.calls.setJob.length === 0, "an out-of-reach offer does not switch the offices to the profit setup");
    must(r.ns.files[OFFER_PREP_FILE] === "0", `the prep flag stays clear: ${r.ns.files[OFFER_PREP_FILE]}`);
    must(r.ns.lines.some((l) => l.includes("leaving the round's own office setup")), `the reach gate is logged: ${r.ns.lines}`);
    must(!r.ns.lines.some((l) => l.includes("|ERROR|")), `the reach gate is not an ERROR: ${r.ns.lines}`);
    // ...and an offer that IS within reach still gets the profit setup and the accept.
    r = await run(fakeState({ offerFunds: 9e15, products: [done(0)] }));
    must(r.ns.calls.accept === 1, "an offer over 80% of the expectation is accepted");

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

    // ---- the post-public faction bribe (harsh-softcap nodes only) ----
    const joined = ["CyberSec", "NiteSec"];
    const publicCorp = (o = {}) => ({ public: true, funds: 1e12, revenue: 1e11, expenses: 0, valuation: 1e14, dividendRate: 0.5, ...o });
    const harshCfg = { ...CFG, softcap: 0.4, bribeShare: 0.1 }; // 0.4 = BN13's CorporationSoftcap
    must(!softcapIsHarsh(1) && !softcapIsHarsh(undefined), "BN3 (softcap 1) is not harsh");
    must(softcapIsHarsh(0.9) && softcapIsHarsh(0.4) && softcapIsHarsh(0), "any softcap below 1 is harsh");
    must(!bribePlan(publicCorp(), CFG, joined).online, "BN3 post-public does not bribe");
    must(!bribePlan(publicCorp({ public: false }), harshCfg, joined).online, "pre-offer does not bribe");
    must(!bribePlan(publicCorp({ valuation: 1e13 }), harshCfg, joined).online, "valuation under the game's threshold does not bribe");
    must(!bribePlan(publicCorp(), { ...harshCfg, bribeShare: 0.5 }, joined).online, "share + dividend-rate 1.0 is refused");
    same(
        bribePlan(publicCorp(), harshCfg, joined).targets,
        [{ faction: "CyberSec", amount: 5e10 }, { faction: "NiteSec", amount: 5e10 }],
        "10% of a cycle's profit, split over the goal factions",
    );
    must(!bribePlan(publicCorp({ revenue: 1e9 }), harshCfg, joined).online, "a share under one reputation is not spent");
    must(!bribePlan(publicCorp({ funds: 5e8 }), harshCfg, joined).online, "a share larger than the funds on hand is not spent");
    must(!bribePlan(publicCorp(), harshCfg, []).online, "no goal faction = nothing to bribe");

    // ---- bribe targets come from faction-manager's aug goals, not from every joined faction ----
    const augGoals = (map) => JSON.stringify({ rep_needed_by_faction: map });
    const harshState = (o = {}) => fakeState({
        round: 5, offerFunds: 0, factions: ["CyberSec", "NiteSec", "Bladeburners"],
        augGoals: augGoals({ CyberSec: 2e5, NiteSec: 3e5 }),
        corp: { funds: 1e12, divisions: [TOB_NAME], public: true, revenue: 1e11, expenses: 0, valuation: 1e14, dividendRate: 0.5 },
        ...o,
    });
    // Only the factions with a rep deficit are bribed: Bladeburners is joined but has no missing aug.
    r = await run(harshState(), newMemory(), harshCfg);
    same(
        r.ns.calls.bribe,
        [{ faction: "CyberSec", amount: 5e10 }, { faction: "NiteSec", amount: 5e10 }],
        "the bribe share is split over faction-manager's goal factions",
    );
    must(r.ns.lines.some((l) => l.includes("MILESTONE") && l.includes("first faction bribe")), `bribe MILESTONE: ${r.ns.lines}`);
    // A goal faction we are not in is skipped (a stale goal file from before a reset must not be spent on),
    // and the cycle's whole share then goes to the faction that IS left - the share caps the TOTAL spend.
    r = await run(harshState({ augGoals: augGoals({ CyberSec: 2e5, "The Syndicate": 5e5 }), factions: ["CyberSec", "NiteSec"] }), newMemory(), harshCfg);
    same(r.ns.calls.bribe, [{ faction: "CyberSec", amount: 1e11 }], "a goal faction we are not in is skipped");
    // No goal file yet (faction-manager has not run this reset, or just bought its order): spend nothing.
    r = await run(harshState({ augGoals: "" }), newMemory(), harshCfg);
    same(r.ns.calls.bribe, [], "no aug goals = no bribe");
    must(r.ns.lines.some((l) => l.includes("no aug goals from faction-manager.js")), `the missing goal file is logged: ${r.ns.lines}`);
    // --bribe-faction overrides the goal file (still restricted to factions we are in).
    r = await run(harshState({ factions: ["CyberSec", "The Black Hand"] }), newMemory(), { ...harshCfg, bribeFactions: ["The Black Hand"] });
    same(r.ns.calls.bribe, [{ faction: "The Black Hand", amount: 1e11 }], "--bribe-faction overrides the goals");
    // The cycle it goes public: the dividend is issued, the bribe waits one cycle (getCorporation() is a copy
    // taken before goPublic, so corp.public still reads false there).
    r = await run(harshState({ corp: { funds: 1e12, divisions: [TOB_NAME], public: false, revenue: 1e11, expenses: 0, valuation: 1e14, dividendRate: 0.5 } }), newMemory(), harshCfg);
    same(r.ns.calls.dividends, [0.5], "the dividend is still issued on the cycle it goes public");
    same(r.ns.calls.bribe, [], "the bribe waits for the next cycle");
    // BN3 (softcap 1) post-public: the dividend alone, never a bribe.
    must(again.ns.calls.bribe.length === 0, "BN3 post-public never bribes");
    // A refusal is remembered for the rest of the run instead of being asked every cycle.
    const refusedState = () => harshState({ bribeRefuses: ["NiteSec"] });
    r = await run(refusedState(), newMemory(), harshCfg);
    must(r.ns.calls.bribe.length === 2, `both goal factions are asked once: ${r.ns.calls.bribe.length}`);
    must(r.ns.lines.some((l) => l.includes("NiteSec refused a bribe")), `refusal WARN: ${r.ns.lines}`);
    const refusedAgain = await run(refusedState(), r.mem, harshCfg);
    same(refusedAgain.ns.calls.bribe, [{ faction: "CyberSec", amount: 1e11 }], "a refused faction is not asked again (the rest absorb its share)");

    return true;
}
