/** T13 - Corp/corp-products.js: the continuous product-development SERVICE (guide §4.3 p20-22, §19.4.2 p76-79).
 * One instance, loops on ns.corporation.nextUpdate() forever; the daemon (T07) keeps it alive.
 *
 * Why: the old corp.js developed exactly ONE product ("BIG CIG") and never another. The guide's whole profit
 * curve (§19.4.2 p79 sample log: products 0 -> 7 in ~370 cycles, 1e90/s after the 7th/8th) comes from
 * continuously replacing products - "new products are almost always better than the old ones" (§15.1 p53).
 * One product at a time, and the default cap of 3 products per division is read from
 * getDivision().maxProducts, never hard-coded (§6.3 p28: the uPgrade: Capacity research that would raise the
 * cap is not worth buying, so the cap stays 3).
 *
 * 1P/2P plan (§19.4.2 p78, reference corporation.ts maxNumberOfProductsInRound3/4 = 1/2 at lines 245/247):
 * round 3 may develop ONE product and round 4 TWO - this service waits for each offer to be accepted (T14's
 * job) before developing the next one. After offer 4 it develops unconditionally.
 *
 * State is fully re-derived from the game every cycle, so a restart costs nothing (no persistent memory).
 *
 * Distinct ns.corporation.* APIs referenced by THIS file (docs figures, NOT measured):
 *   0 GB : hasCorporation nextUpdate
 *   10 GB: getCorporation getDivision getInvestmentOffer getProduct
 *   20 GB: discontinueProduct makeProduct
 *   => docs sum 80 GB + script base. Imports helpers.js (formatMoney, getConfiguration),
 *      corp-lib.js (corpLog) and corp-formulas.js (allowedProductCeiling, nextProductName, parseProductId) -
 *      none of them references a corporation API, so they add nothing. Deliberately does NOT import
 *      Corp/corp-ops.js (that would charge this service the ~30-function union of the shared module).
 *      getProduct/discontinueProduct/makeProduct require the "Warehouse API" unlock (auto-granted in BN3).
 *
 * Guide refs: §15.1 p53 (several products queued, only one developed at a time, "when we reach the limit we
 * need to discontinue a product before developing a new one"), §6.3 p28 (no Capacity research -> cap 3),
 * §19.4.2 p78 (1P/2P), §4.3 p20-22 ("continuously develop new product"; design+marketing "scale very badly,
 * it's fine to spend 1% of your current funds"), §19.4.2 p79 (sample-log product names are
 * `<division>-<5-digit id>-<budget e-notation>`).
 * Ported from catloversg/bitburner-scripts (MIT): corporationUtils.ts developNewProduct (1131-1196) and
 * corporation.ts (779-856) - logic only.
 */
import { formatMoney, getConfiguration } from "../helpers.js";
import { TOB_NAME, alreadyRunning, corpLog, readBnProfile } from "./corp-lib.js";
import { allowedProductCeiling, nextProductName, parseProductId } from "./corp-formulas.js";

const WARN_INTERVAL = 50; // re-log the same WARN / the profit skip at most once per this many cycles
const PROFIT_SKIP = 1e40; // reference corporation.ts ~840: past this profit a new product adds nothing...
const FUNDS_RESUME = 1e72; // ...until the funds are back over 1e72, where the budget is floored at 1e72 too
const MIN_PRODUCT_BUDGET = 1e3; // §4.3: under this the investment is noise - develop a product when the funds allow
// §19.4.2 p79: offer 4 >= 1e20 is the round-4 milestone. The guide's own fallback for a corp that cannot reach
// it with the round's two products is a bigger P/P setup (1P/3P, 2P/4P) - both spend the extra products in ROUND
// 4, and its sample log develops a 3rd product before offer 4 - so ONE product past the round-4 ceiling is
// allowed while the offer is still this far below the milestone. A product's RATING is what drives the profit
// (ratings are frozen at creation, so two cheap early products can never grow into the offer), which is exactly
// the case that fallback exists for. `div.maxProducts` (3 without the Capacity research) caps it anyway, and the
// fraction is the knob: a corp whose offer already clears it is developing on plan and gets no extra product.
const ROUND_4_MILESTONE = 1e20; // BN3 figure - scaled by T08's profile.offerScale below
// The same 80% line T14 uses as its accept floor (FAQ p10): while the offer is NOT acceptable, the round's
// products have provably not got the corp to the milestone, so keep developing. Once the offer IS acceptable
// T13 must not start anything - a product in development closes T14's all-products-finished gate for its whole
// duration, which would delay the accept instead of helping it.
const BEHIND_MILESTONE_FRACTION = 0.8;
const argsSchema = [
    ["product-city", "Sector-12"], // the city whose office develops the products
    ["budget-share", 0.01], // §4.3: 1% of the current funds per product
    ["division", TOB_NAME],
];

export function autocomplete(data, _) {
    data.flags(argsSchema);
    return [];
}

/** Session memory of the running service. Only logging bookkeeping - every decision is re-derived from the
 * game, so a restart costs nothing but a repeated INFO/MILESTONE line at most. **/
function newMemory() {
    return {
        cycle: 0,
        finished: new Set(), // product names already reported as finished
        waiting: new Set(), // offer rounds whose "waiting for the offer" line was already printed
        warned: new Map(), // warn key -> the cycle it was last logged
        skipLogged: -WARN_INTERVAL, // cycle of the last "profit rule" skip line
    };
}

/** @param {NS} ns **/
export async function main(ns) {
    const options = getConfiguration(ns, argsSchema);
    if (!options || alreadyRunning(ns)) return;
    ns.disableLog("ALL");
    const cfg = {
        productCity: String(options["product-city"]),
        budgetShare: Number(options["budget-share"]),
        division: String(options.division),
    };
    const mem = newMemory();
    corpLog(ns, `product development starting (division=${cfg.division}, product-city=${cfg.productCity}, budget-share=${cfg.budgetShare})`);
    while (true) {
        if (!ns.corporation.hasCorporation()) {
            await ns.sleep(5000); // the daemon may start services before the corporation exists
            continue;
        }
        // nextUpdate() resolves with the state that JUST happened: on START a whole cycle has been processed,
        // so developmentProgress and the offer round are as fresh as they get.
        const state = await ns.corporation.nextUpdate();
        if (state !== "START") continue;
        mem.cycle++;
        try {
            runCycle(ns, cfg, mem);
        } catch (e) {
            // An uncaught throw is only reported in the terminal, where the daemon does not look.
            corpLog(ns, `product cycle failed: ${e?.message ?? e}`, "ERROR");
        }
    }
}

/** One START -> PURCHASE window: spec steps 1-8. Exported for the offline selfCheck.
 * @param {NS} ns @param {{productCity:string, budgetShare:number, division:string}} cfg @param {object} mem **/
export function runCycle(ns, cfg, mem) {
    const division = cfg.division;
    const corp = ns.corporation.getCorporation();
    if (!corp.divisions.includes(division)) {
        warnOnce(ns, mem, `nodiv:${division}`, `${division} does not exist yet - nothing to develop`);
        return;
    }

    // Step 1: the offer round decides the ceiling. funds 0 means "no offer left / corporation is public",
    // i.e. all four rounds are taken -> round 5 (getCorporation() has no round field, CONTEXT §4).
    const offer = ns.corporation.getInvestmentOffer();
    const offerRound = offer.funds === 0 ? 5 : offer.round;

    // Step 2 + step 8. Read every product of the division (getProduct needs a CITY) and MILESTONE the ones
    // that just finished. Done BEFORE the gates below: past the round-3 ceiling this service returns every
    // cycle, so a later milestone check would never see the first product finish.
    const div = ns.corporation.getDivision(division);
    const products = div.products.map((name) => readProduct(ns, division, cfg.productCity, name));
    for (const p of products) {
        if (p === null || !(p.developmentProgress >= 100) || mem.finished.has(p.name)) continue;
        mem.finished.add(p.name);
        corpLog(ns, `${p.name} finished, rating ${p.rating}`, "MILESTONE");
    }

    // Step 3: the 1P/2P ceiling - 1 product in round 3, 2 in round 4, unlimited after offer 4 (T02
    // allowedProductCeiling). A name without a generated id (the old "BIG CIG") cannot be numbered, but it
    // still occupies a slot, so both counts are compared.
    const named = div.products.map(parseProductId).filter(Number.isFinite);
    const developed = named.length === 0 ? 0 : Math.max(...named) + 1;
    const ceiling = allowedProductCeiling(offerRound);
    const offerScale = Number(readBnProfile(ns).offerScale ?? 1);
    const behind = offerRound === 4 && offer.funds < ROUND_4_MILESTONE * offerScale * BEHIND_MILESTONE_FRACTION;
    // At the division's hard cap (maxProducts = 3 without the Capacity research) there is no free slot to ADD to,
    // but a replacement is still a better product: the make step below discontinues the worst-rated one first.
    // That is how the guide's own run reached "1e20/s after the 4th/5th product" - its log develops product
    // 00003 before offer 4 - and the replacement is created with today's much stronger offices and RP pool.
    const replace = behind && div.products.length >= div.maxProducts;
    const cap = behind ? ceiling + 1 : ceiling;
    if (cap !== Infinity && !replace && Math.max(developed, div.products.length) >= cap) {
        if (!mem.waiting.has(offerRound)) {
            mem.waiting.add(offerRound);
            corpLog(ns, `${division}: round ${offerRound} develops ${cap} product(s), ${developed} done - waiting for the offer before developing more`);
        }
        return;
    }

    // Step 4: one product at a time (§15.1). A product still being developed blocks everything. A product
    // that could not be read (getProduct threw while it is still being created) is treated the same way.
    if (products.some((p) => p === null || !(p.developmentProgress >= 100))) return;

    // Step 5: profit rule (reference corporation.ts ~840). Near the end of the exponential phase the extra
    // product adds nothing, so skip until the funds are back over 1e72 and log that once per WARN_INTERVAL.
    const funds = corp.funds;
    if (corp.revenue - corp.expenses > PROFIT_SKIP && funds < FUNDS_RESUME) {
        if (mem.cycle - mem.skipLogged >= WARN_INTERVAL) {
            mem.skipLogged = mem.cycle;
            corpLog(ns, `${division}: profit ${formatMoney(corp.revenue - corp.expenses)}/s with ${formatMoney(funds)} - not investing in a new product until the funds are back over ${formatMoney(FUNDS_RESUME)}`, "WARN");
        }
        return;
    }

    // Step 6: budget (§4.3: 1% of the current funds) and the make itself. The game gets half the budget as
    // design and half as marketing investment (reference: makeProduct(..., b/2, b/2)); the NAME is only the
    // division plus a running number ("Ebon Stick-16"), which nextProductName continues past every product the
    // division already has - so a replacement, which is made right after a discontinue, cannot collide.
    let budget = funds * cfg.budgetShare;
    if (funds >= FUNDS_RESUME) budget = Math.max(budget, FUNDS_RESUME); // reference: a 1% budget is noise this late
    if (!(budget >= MIN_PRODUCT_BUDGET)) {
        warnOnce(ns, mem, "budget", `${division}: ${formatMoney(budget)} is too small to invest in a product (funds ${formatMoney(funds)})`);
        return;
    }
    if (div.products.length >= div.maxProducts) {
        // The division is at its cap: free a slot by discontinuing the worst product. Every product is
        // finished here (step 4), so `rating` is a real number. (The reference does the same with min rating.)
        const worst = products.reduce((worst, p) => (p.rating < worst.rating ? p : worst));
        ns.corporation.discontinueProduct(division, worst.name);
        corpLog(ns, `${division}: discontinued ${worst.name} (rating ${worst.rating}) - ${div.products.length} products is the cap`);
    }
    const name = nextProductName(div.products, division);
    const invest = budget / 2;
    ns.corporation.makeProduct(division, cfg.productCity, name, invest, invest); // THROWS when short of funds
    corpLog(ns, `New product ${name} budget ${formatMoney(budget)}${behind ? " (extra product: the offer is under half the round-4 milestone - §19.4.2's 1P/3P fallback)" : ""}`);
}

/** Step 7: getProduct needs the CITY. A product that is still being created may throw - that is "not
 * readable yet", which the caller treats exactly like "still developing". @returns {object|null} **/
function readProduct(ns, division, city, name) {
    try {
        return ns.corporation.getProduct(division, city, name);
    } catch {
        return null;
    }
}

/** corpLog a WARN at most once per `key` per WARN_INTERVAL cycles (never spam the tail). **/
function warnOnce(ns, mem, key, message) {
    const last = mem.warned.get(key);
    if (last !== undefined && mem.cycle - last < WARN_INTERVAL) return;
    mem.warned.set(key, mem.cycle);
    corpLog(ns, message, "WARN");
}

// ---------------------------------------------------------------------------------------------
// Offline self-check (fabricated game state + mock ns - proves the wiring, NOT in-game correctness).

/** Minimal fake NS for the check below: only the APIs this file touches. **/
function mockNs(state) {
    const calls = { make: [], discontinue: [] };
    const lines = [];
    return {
        calls,
        lines,
        print: () => {},
        getScriptName: () => "Corp/corp-products.js",
        getPortHandle: () => ({ write: (line) => lines.push(line) }),
        corporation: {
            getCorporation: () => ({ funds: state.funds, revenue: state.revenue, expenses: state.expenses, divisions: [state.division] }),
            getInvestmentOffer: () => ({ funds: state.offerFunds, round: state.round, shares: 0 }),
            getDivision: () => ({ name: state.division, products: state.products.map((p) => p.name), maxProducts: state.maxProducts }),
            getProduct: (_d, _c, name) => {
                const p = state.products.find((x) => x.name === name);
                if (!p) throw new Error(`no such product: ${name}`);
                return { ...p };
            },
            makeProduct: (division, city, name, design, marketing) => calls.make.push({ division, city, name, design, marketing }),
            discontinueProduct: (division, name) => calls.discontinue.push({ division, name }),
        },
    };
}

/** @returns {{name:string, developmentProgress:number, rating:number}} **/
const product = (name, developmentProgress = 100, rating = 1) => ({ name, developmentProgress, rating, effectiveRating: rating });

/** A finished-or-not Tobacco division. `funds` 1e11 * budget-share 0.01 = a 1e9 budget. **/
function fakeState({ products = [], ...rest } = {}) {
    return {
        division: TOB_NAME,
        funds: 1e11,
        revenue: 0,
        expenses: 0,
        round: 3,
        offerFunds: 1e16,
        maxProducts: 3,
        products,
        ...rest,
    };
}

const CFG = { productCity: "Sector-12", budgetShare: 0.01, division: TOB_NAME };

/** Runnable check (no game needed):
 *   node --input-type=module -e "import('./Corp/corp-products.js').then(m=>m.selfCheck()).then(r=>console.log('selfCheck:',r))"
 * Throws on the first failure. Proves the product state machine with a mock NS - NOT in-game correctness.
 * The fixtures keep the OLD "Ebon Stick-00000-1.00000e+9" names on purpose: those are the products already in
 * the game, and parseProductId has to keep numbering past them. **/
export function selfCheck() {
    const must = (ok, label) => {
        if (!ok) throw new Error(`selfCheck: ${label}`);
    };
    const run = (state, mem = newMemory()) => {
        const ns = mockNs(state);
        runCycle(ns, CFG, mem);
        return { ns, mem };
    };

    // Round 3, nothing developed yet: one product, the first name of the division, total budget 1e9 split evenly.
    let r = run(fakeState());
    must(r.ns.calls.make.length === 1, `empty division develops one product, got ${r.ns.calls.make.length}`);
    must(r.ns.calls.make[0].name === "Ebon Stick-0", `name ${r.ns.calls.make[0].name}`);
    must(r.ns.calls.make[0].design === 5e8 && r.ns.calls.make[0].marketing === 5e8, `half design / half marketing: ${JSON.stringify(r.ns.calls.make[0])}`);
    must(r.ns.calls.make[0].city === "Sector-12" && r.ns.calls.discontinue.length === 0, "product city + nothing discontinued");

    // Round 3 already has its one product (finished or not): the 1P/2P ceiling blocks it, and says so once.
    for (const progress of [100, 42]) {
        r = run(fakeState({ products: [product("Ebon Stick-00000-1.00000e+9", progress)] }));
        must(r.ns.calls.make.length === 0 && r.ns.calls.discontinue.length === 0, `round 3 ceiling blocks (progress ${progress})`);
        must(r.ns.lines.filter((l) => l.includes("waiting for the offer")).length === 1, `round 3 wait is logged once: ${r.ns.lines}`);
    }
    // The milestone fires exactly once, even when the ceiling keeps returning every cycle.
    r = run(fakeState({ products: [product("Ebon Stick-00000-1.00000e+9")] }));
    must(r.ns.lines.filter((l) => l.includes("finished, rating")).length === 1, `milestone once: ${r.ns.lines}`);
    run(fakeState({ products: [product("Ebon Stick-00000-1.00000e+9")] }), r.mem);
    must(r.ns.lines.filter((l) => l.includes("finished, rating")).length === 1, "milestone is not repeated");

    // Round 3 with a product still being developed: nothing happens (one product at a time, §15.1).
    r = run(fakeState({ products: [product("Ebon Stick-00000-1.00000e+9", 60)] }));
    must(r.ns.calls.make.length === 0, "a developing product blocks the next one");

    // Round 4: the second product is allowed, numbered after the first.
    r = run(fakeState({ round: 4, offerFunds: 1e20, products: [product("Ebon Stick-00000-1.00000e+9")] }));
    must(r.ns.calls.make.length === 1 && r.ns.calls.make[0].name === "Ebon Stick-1", `round 4 second product: ${JSON.stringify(r.ns.calls.make)}`);
    // ...and a third is not (2P).
    r = run(
        fakeState({
            round: 4,
            offerFunds: 1e20,
            products: [product("Ebon Stick-00000-1.00000e+9"), product("Ebon Stick-00001-1.00000e+9")],
        }),
    );
    must(r.ns.calls.make.length === 0, "round 4 ceiling blocks the third product");

    // ...but a corp whose round-4 offer is nowhere near the milestone - its two products were developed with the
    // early, cheap offices, and a product's rating is frozen at creation - gets ONE more product: the guide's own
    // fallback (1P/3P / 2P/4P). A healthy corp is untouched, because its offer is already over half of 1e20.
    const twoProducts = [product("Ebon Stick-00000-1.00000e+9"), product("Ebon Stick-00001-1.00000e+9")];
    r = run(fakeState({ round: 4, offerFunds: 9e16, products: twoProducts }));
    must(
        r.ns.calls.make.length === 1 && r.ns.calls.make[0].name === "Ebon Stick-2",
        `round 4 extra product below the milestone: ${JSON.stringify(r.ns.calls.make)}`,
    );
    // At the division's hard cap (3 without the Capacity research) the extra product is a REPLACEMENT: the make
    // step discontinues the worst-rated product to free the slot, which is how the guide's own log reached product
    // 00003 before offer 4 ("1e20/s after the 4th/5th product"). The replacement is created with today's much
    // stronger offices and RP pool, so its rating - and with it the profit - jumps.
    const atCap = [
        product("Ebon Stick-00000-1.00000e+9", 100, 30),
        product("Ebon Stick-00001-1.00000e+9", 100, 10),
        product("Ebon Stick-00002-1.00000e+9", 100, 20),
    ];
    r = run(fakeState({ round: 4, offerFunds: 9e16, products: atCap }));
    must(r.ns.calls.discontinue.length === 1 && r.ns.calls.discontinue[0].name === "Ebon Stick-00001-1.00000e+9", `the replacement frees a slot: ${JSON.stringify(r.ns.calls.discontinue)}`);
    must(r.ns.calls.make.length === 1 && r.ns.calls.make[0].name === "Ebon Stick-3", `the 4th product: ${JSON.stringify(r.ns.calls.make)}`);
    // ...and once the offer IS acceptable (the 80% floor T14 accepts at) no product is touched: a product in
    // development would close T14's all-products-finished gate for its whole duration.
    r = run(fakeState({ round: 4, offerFunds: 9e19, products: atCap }));
    must(r.ns.calls.make.length === 0 && r.ns.calls.discontinue.length === 0, "no product work once the offer is acceptable");

    // After offer 4 (funds 0 -> round 5): unconditional development, capped by maxProducts -> the worst
    // (lowest rating) product is discontinued to free the slot.
    const three = [product("Ebon Stick-00000-1.00000e+9", 100, 30), product("Ebon Stick-00001-1.00000e+9", 100, 10), product("Ebon Stick-00002-1.00000e+9", 100, 20)];
    r = run(fakeState({ round: 5, offerFunds: 0, products: three }));
    must(r.ns.calls.discontinue.length === 1 && r.ns.calls.discontinue[0].name === "Ebon Stick-00001-1.00000e+9", `discontinues the lowest rating: ${JSON.stringify(r.ns.calls.discontinue)}`);
    must(r.ns.calls.make.length === 1 && r.ns.calls.make[0].name === "Ebon Stick-3", `next id after the cap: ${JSON.stringify(r.ns.calls.make)}`);

    // The old hand-made name cannot be numbered, but it still occupies a product slot.
    r = run(
        fakeState({
            round: 5,
            offerFunds: 0,
            products: [product("BIG CIG", 100, 1), product("Ebon Stick-00000-1.00000e+9", 100, 30), product("Ebon Stick-00001-1.00000e+9", 100, 20)],
        }),
    );
    must(r.ns.calls.discontinue.length === 1 && r.ns.calls.discontinue[0].name === "BIG CIG", `non-conforming name counts and is the worst: ${JSON.stringify(r.ns.calls.discontinue)}`);
    must(r.ns.calls.make[0].name === "Ebon Stick-2", `numbering ignores "BIG CIG": ${r.ns.calls.make[0].name}`);

    // Profit rule (reference): 1e40/s or less still develops; above it only once the funds are back over 1e72.
    r = run(fakeState({ round: 5, offerFunds: 0, revenue: 1e40, expenses: 0, products: three }));
    must(r.ns.calls.make.length === 1, "profit of exactly 1e40 still develops");
    const skipState = { round: 5, offerFunds: 0, revenue: 1e45, expenses: 0, funds: 1e60, products: three };
    r = run(fakeState(skipState));
    must(r.ns.calls.make.length === 0 && r.ns.calls.discontinue.length === 0, "profit > 1e40 with funds < 1e72 skips");
    must(r.ns.lines.filter((l) => l.includes("not investing in a new product")).length === 1, `skip logged once: ${r.ns.lines}`);
    r = run(fakeState({ ...skipState, funds: 1e73 }));
    must(r.ns.calls.make[0].design === 5e71 && r.ns.calls.make[0].design + r.ns.calls.make[0].marketing === 1e72, `1e72 budget floor: ${JSON.stringify(r.ns.calls.make[0])}`);

    // Round 2 (or a corporation whose division is gone): no product is ever developed.
    r = run(fakeState({ round: 2, offerFunds: 5e11 }));
    must(r.ns.calls.make.length === 0, "round 2 develops nothing");
    r = run(fakeState({ division: "Nope" }));
    must(r.ns.calls.make.length === 0 && r.ns.lines.some((l) => l.includes("does not exist yet")), "missing division is a WARN, not a throw");

    return true;
}
