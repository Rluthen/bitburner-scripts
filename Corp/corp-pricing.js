/** T12 - corp-pricing.js: the "put products on sale + custom Market-TA.II" SERVICE.
 * One instance, loops on ns.corporation.nextUpdate() forever; the daemon (T07) keeps it alive.
 *
 * Why: nothing in the old corp.js ever called sellProduct, so a finished product could sit with no sell
 * order at all. This service (1) always puts every finished product on sale at market price, (2) hands the
 * division to the game's Market-TA.II when that research is done, and (3) otherwise prices every product and
 * every produced material per city with the guide's §16.3 formula - a hand-rolled Market-TA.II, which the
 * guide calls "the best optimization in round 3+" (§16, FAQ p13-14: TA.I is useless, the custom script wins).
 *
 * ProductMarkup is not exposed through the NS API, so it is MEASURED once per product+city (§16.3 p61): set
 * an absurd price so MaxSalesVolume < ExpectedSalesVolume (range 4 of the markup multiplier), wait one cycle,
 * read product.actualSellAmount, and back-solve MarkupLimit = (SellingPrice - MarketPrice) * sqrt(Actual /
 * Potential). ProductMarkup = effectiveRating / MarkupLimit never changes, so it is cached for the lifetime
 * of the service and the product is never re-measured while it runs (a restart just costs one cycle each).
 *
 * State comes from the T04 snapshot (ns.read, 0 GB): division list, awareness/popularity, makesProducts,
 * researched, cities and the cities that HAVE a warehouse (getMaterial throws without one). Only the
 * per-city numbers are read live.
 *
 * Distinct ns.corporation.* APIs referenced by THIS file (docs figures, NOT measured):
 *   0 GB : hasCorporation nextUpdate
 *   10 GB: getIndustryData getMaterial getMaterialData getOffice getProduct
 *   20 GB: sellMaterial sellProduct setMaterialMarketTA2 setProductMarketTA2
 *   => docs sum 130 GB + script base. Imports corp-lib.js / corp-formulas.js (0 corporation APIs) and
 *      helpers.js (getConfiguration, instanceCount). Deliberately does NOT import Corp/corp-ops.js (importing
 *      it would charge this service the ~30-function union of that shared module).
 *
 * Guide refs: §16.2.1 p58 (PotentialSalesVolume), §16.2.2 p59 (markup multiplier ranges), §16.3 p60-62
 * (optimal selling price + the measurement trick + "ProductMarkup never changes"), §14 p52 (Demand/Competition
 * are the two 5e9 unlocks), §18.1 p68 (EXPORT precedes SALE). sellProduct/sellMaterial take STRINGS, and the
 * game evals the price after stripping everything outside [0-9 + - * / ( ) . e E M P] (Actions.ts
 * convertPriceString), so exponent notation is fine and "MP*5" would be too - but never a NaN or a "b" suffix.
 * Ported from catloversg/bitburner-scripts (MIT): corporationUtils.ts getOptimalSellingPrice /
 * setOptimalSellingPriceForEverything - logic only, with a measured MarkupLimit instead of its Ceres solver.
 */
import { getConfiguration, instanceCount } from "../helpers.js";
import { corpLog, STATE_FILE } from "./corp-lib.js";
import { markupLimitFromMeasurement, optimalSellingPrice, potentialSalesVolume } from "./corp-formulas.js";

const WARN_INTERVAL = 50; // re-log the same WARN at most once per this many sale windows (acceptance 3)
const argsSchema = [
    ["product-city", "Sector-12"], // accepted for daemon parity (T06 passes it); pricing itself covers EVERY city
];

/** Session memory of the running service. All cheap to rebuild - a restart only costs one measurement cycle. **/
function newMemory() {
    return {
        cycle: 0,
        baselined: new Set(), // division|product: market-price sell order already placed (all cities)
        ta2Products: new Set(), // division|product
        ta2Materials: new Set(), // division|city|material
        markup: new Map(), // division|city|product -> ProductMarkup
        pending: new Map(), // division|city|product -> {price, marketPrice, psv} of an in-flight measurement
        warned: new Map(), // warn key -> the cycle it was last logged
    };
}

/** @param {NS} ns **/
export async function main(ns) {
    const options = getConfiguration(ns, argsSchema);
    if (!options || (await instanceCount(ns)) > 1) return;
    ns.disableLog("ALL");
    const mem = newMemory();
    const totals = { baseline: 0, ta2: 0, custom: 0 };

    while (true) {
        if (!ns.corporation.hasCorporation()) {
            await ns.sleep(5000); // the daemon may start services before the corporation exists
            continue;
        }
        // nextUpdate() resolves with the state that JUST happened, and EXPORT precedes SALE (§18.1 p68), so
        // this is the last moment before the sale is processed - the price set here applies to that sale.
        // (The reference checks getCorporation().nextState === "SALE", which is the same instant, for 10 GB.)
        const state = await ns.corporation.nextUpdate();
        if (state !== "EXPORT") continue;
        mem.cycle++;
        const snapshot = readSnapshot(ns.read(STATE_FILE));
        if (snapshot === null) continue; // no snapshot yet: skip a cycle rather than pay 10 GB per getter
        const counts = runCycle(ns, snapshot, mem);
        totals.baseline += counts.baseline;
        totals.ta2 += counts.ta2;
        totals.custom += counts.custom;
        if (mem.cycle % 20 === 0) {
            corpLog(ns, `pricing (per 20 sale windows): ${totals.baseline} products at market price, ${totals.ta2} on Market-TA.II, ${totals.custom} custom sell orders written`);
            totals.baseline = 0;
            totals.ta2 = 0;
            totals.custom = 0;
        }
    }
}

/** One EXPORT->SALE window: spec steps 1-4. Exported for the offline selfCheck.
 * @returns {{baseline:number, ta2:number, custom:number}} how many products were in each state this window **/
export function runCycle(ns, snapshot, mem) {
    const counts = { baseline: 0, ta2: 0, custom: 0 };
    const unlocked =
        snapshot.unlocks?.["Market Research - Demand"] === true && snapshot.unlocks?.["Market Data - Competition"] === true;
    if (!unlocked)
        warnOnce(ns, mem, "unlocks", "Market Research - Demand / Market Data - Competition not unlocked: products are only on sale at market price (MP)");
    const salesBotsLevel = Number(snapshot.upgrades?.["ABC SalesBots"] ?? 0);

    for (const [division, d] of Object.entries(snapshot.divisions ?? {})) {
        const cities = d.cities ?? [];
        if (cities.length === 0) continue;
        // producedMaterials belong to material industries too (Agriculture, Chemical), not just product ones (step 4).
        const industry = ns.corporation.getIndustryData(d.industry);
        const materials = industry.producedMaterials ?? [];
        const finished =
            d.makesProducts === true ? (d.products ?? []).filter((p) => p.developmentProgress >= 100).map((p) => p.name) : [];
        const warehouseCities = Object.keys(d.warehouses ?? {}); // getMaterial THROWS in a city with no warehouse

        // 1. Baseline - always, unlocks or not: a finished product must at least be on sale at market price.
        for (const product of finished) {
            const key = `${division}|${product}`;
            if (mem.baselined.has(key)) continue;
            ns.corporation.sellProduct(division, cities[0], product, "MAX", "MP", true); // all=true -> every city
            mem.baselined.add(key);
        }
        counts.baseline += finished.length;

        // 2. The division researched Market-TA.II: let the game price it and skip the custom logic entirely.
        if (d.researched?.["Market-TA.II"] === true) {
            for (const product of finished) {
                const key = `${division}|${product}`;
                if (mem.ta2Products.has(key)) continue;
                ns.corporation.setProductMarketTA2(division, product, true); // throws unless researched - guarded above
                mem.ta2Products.add(key);
            }
            for (const city of warehouseCities)
                for (const material of materials) {
                    const key = `${division}|${city}|${material}`;
                    if (mem.ta2Materials.has(key)) continue;
                    ns.corporation.setMaterialMarketTA2(division, city, material, true); // needs a city, unlike products
                    mem.ta2Materials.add(key);
                }
            counts.ta2 += finished.length;
            continue;
        }
        if (!unlocked) continue; // step 1 was the only thing we may do without Demand + Competition

        // 3+4. Custom Market-TA.II: price products and produced materials, per city (§16.3).
        for (const city of cities) {
            const office = ns.corporation.getOffice(division, city);
            const common = {
                businessProduction: Number(office.employeeProductionByJob?.["Business"] ?? 0),
                awareness: Number(d.awareness ?? 0),
                popularity: Number(d.popularity ?? 0),
                advertisingFactor: Number(industry.advertisingFactor ?? 0),
                salesBotsLevel,
            };
            for (const product of finished) counts.custom += priceProduct(ns, mem, { division, city, product, common });
            if (!warehouseCities.includes(city)) continue;
            for (const material of materials) counts.custom += priceMaterial(ns, mem, { division, city, material, common });
        }
    }
    return counts;
}

/** Spec step 3. Price one product in one city; the first time a (division,city,product) is seen it spends
 * one cycle measuring MarkupLimit (§16.3 p61) instead of pricing. @returns {0|1} 1 when a sell order was set **/
function priceProduct(ns, mem, { division, city, product, common }) {
    const key = `${division}|${city}|${product}`;
    const item = ns.corporation.getProduct(division, city, product);
    if (!(item.developmentProgress >= 100)) return 0;
    const marketPrice = Number(item.productionCost);
    const effectiveRating = Number(item.effectiveRating);
    if (!Number.isFinite(marketPrice) || !Number.isFinite(effectiveRating)) {
        warnOnce(ns, mem, `bad:${key}`, `${product} in ${city}: productionCost/effectiveRating is not a finite number yet, skipping`);
        return 0;
    }
    const psv = potentialSalesVolume({
        itemMultiplier: 0.5 * Math.pow(effectiveRating, 0.65), // §16.2.1 product item multiplier
        demand: item.demand,
        competition: item.competition,
        ...common,
    });

    let productMarkup = mem.markup.get(key);
    const pending = mem.pending.get(key);
    if (productMarkup === undefined && pending !== undefined) {
        // A measurement was in flight: back-solve MarkupLimit from the sale it produced (§16.3 p61).
        const markupLimit = markupLimitFromMeasurement({
            price: pending.price,
            marketPrice: pending.marketPrice,
            actualSellAmount: Number(item.actualSellAmount),
            potentialSalesVolume: pending.psv,
        });
        if (Number.isFinite(markupLimit) && markupLimit > 0) {
            productMarkup = effectiveRating / markupLimit;
            mem.markup.set(key, productMarkup); // ProductMarkup never changes -> cached for the whole run
            mem.pending.delete(key);
        }
    }

    const price =
        productMarkup === undefined
            ? (mem.pending.get(key)?.price ?? marketPrice * 1e12) // measure: far above MarketPrice + MarkupLimit
            : optimalSellingPrice({
                  markupLimit: Math.max(effectiveRating, 0.001) / productMarkup,
                  marketPrice,
                  potentialSalesVolume: psv,
                  stored: Number(item.stored),
              });
    if (!(price > 0)) return 0; // 0 means "nothing stored" (optimalSellingPrice's degenerate case): nothing to sell
    const text = priceString(price);
    if (text === null) {
        warnOnce(ns, mem, `noprice:${key}`, `${product} in ${city}: computed price ${price} is not usable, skipping`);
        return 0;
    }
    ns.corporation.sellProduct(division, city, product, "MAX", text, false); // price is per city
    if (productMarkup === undefined) mem.pending.set(key, { price, marketPrice, psv }); // what to back-solve with
    return 1;
}

/** Spec step 4. Produced materials: MarkupLimit = quality / baseMarkup, no measurement needed (§16.3). **/
function priceMaterial(ns, mem, { division, city, material, common }) {
    const key = `${division}|${city}|${material}`;
    const item = ns.corporation.getMaterial(division, city, material);
    const quality = Number(item.quality);
    const marketPrice = Number(item.marketPrice);
    const baseMarkup = Number(ns.corporation.getMaterialData(material).baseMarkup);
    if (!(baseMarkup > 0) || !Number.isFinite(quality) || !Number.isFinite(marketPrice)) {
        warnOnce(ns, mem, `bad:${key}`, `${material} in ${city}: quality/marketPrice/baseMarkup is not usable, skipping`);
        return 0;
    }
    const psv = potentialSalesVolume({ itemMultiplier: quality + 0.001, demand: item.demand, competition: item.competition, ...common });
    const price = optimalSellingPrice({
        markupLimit: quality / baseMarkup,
        marketPrice,
        potentialSalesVolume: psv,
        stored: Number(item.stored),
    });
    if (!(price > 0)) return 0; // 0 means "nothing stored" (or degenerately negative): nothing to put on sale
    const text = priceString(price);
    if (text === null) {
        warnOnce(ns, mem, `noprice:${key}`, `${material} in ${city}: computed price is not a finite number, skipping`);
        return 0;
    }
    ns.corporation.sellMaterial(division, city, material, "MAX", text);
    return 1;
}

/** Sell-price string the game accepts: convertPriceString keeps only [0-9 + - * / ( ) . e E M P] and evals it.
 * null when the number is unusable (NaN / Infinity / <= 0) so callers skip instead of writing "NaN". **/
export function priceString(price) {
    return Number.isFinite(price) && price > 0 ? price.toExponential(8) : null;
}

/** corpLog a WARN at most once per `key` per WARN_INTERVAL cycles (acceptance 3: never spam the tail). **/
function warnOnce(ns, mem, key, message) {
    const last = mem.warned.get(key);
    if (last !== undefined && mem.cycle - last < WARN_INTERVAL) return;
    mem.warned.set(key, mem.cycle);
    corpLog(ns, message, "WARN");
}

/** Parse the T04 snapshot. null when it is missing, unreadable, or written without a corporation. **/
export function readSnapshot(text) {
    try {
        const snapshot = JSON.parse(text);
        return snapshot && snapshot.hasCorp ? snapshot : null;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------------------------
// Offline self-check (fabricated snapshot + mock ns - proves the wiring, NOT in-game correctness).

/** Minimal fake NS for the check below: only the APIs this file touches. `state.sold` is the sale the game
 * would have recorded for the measurement cycle. **/
function mockNs(state) {
    const calls = { sellProduct: [], sellMaterial: [], productTA2: [], materialTA2: [] };
    return {
        calls,
        print: () => {},
        getScriptName: () => "Corp/corp-pricing.js",
        getPortHandle: () => ({ write: () => {} }),
        corporation: {
            getIndustryData: () => ({ advertisingFactor: 0.05, producedMaterials: ["Plants"], makesProducts: true }),
            getOffice: () => ({ employeeProductionByJob: { Business: 10 } }),
            getProduct: (_d, _c, name) => ({
                name,
                developmentProgress: 100,
                effectiveRating: 100,
                productionCost: 1000,
                stored: 10,
                actualSellAmount: state.sold,
                demand: 100,
                competition: 0,
            }),
            getMaterial: () => ({ quality: 1, marketPrice: 10, stored: 10, demand: 100, competition: 0 }),
            getMaterialData: () => ({ baseMarkup: 0.05 }),
            sellProduct: (division, city, name, amt, price, all) => calls.sellProduct.push({ division, city, name, amt, price, all }),
            sellMaterial: (division, city, name, amt, price) => calls.sellMaterial.push({ division, city, name, amt, price }),
            setProductMarketTA2: (division, name, on) => calls.productTA2.push({ division, name, on }),
            setMaterialMarketTA2: (division, city, name, on) => calls.materialTA2.push({ division, city, name, on }),
        },
    };
}

/** A one-product, two-city snapshot; override `div` for division fields and the rest for corp-wide ones. **/
function fakeSnapshot({ div = {}, ...top } = {}) {
    return {
        hasCorp: true,
        unlocks: { "Market Research - Demand": true, "Market Data - Competition": true },
        upgrades: { "ABC SalesBots": 0 },
        divisions: {
            "Ebon Stick": {
                industry: "Tobacco",
                makesProducts: true,
                awareness: 1,
                popularity: 1,
                cities: ["Sector-12", "Aevum"],
                warehouses: { "Sector-12": {}, Aevum: {} },
                researched: {},
                products: [{ name: "P1", developmentProgress: 100 }],
                ...div,
            },
        },
        ...top,
    };
}

/** Runnable check (no game needed):
 *   node --input-type=module -e "import('./Corp/corp-pricing.js').then(m=>m.selfCheck()).then(r=>console.log('selfCheck:',r))"
 * Proves the pricing state machine with a mock NS - NOT in-game correctness. Throws on the first failure. **/
export function selfCheck() {
    const must = (ok, label) => {
        if (!ok) throw new Error(`selfCheck: ${label}`);
    };
    const nearly = (actual, expected, label) => {
        if (!(Math.abs(actual - expected) <= Math.abs(expected) * 1e-6)) throw new Error(`selfCheck: ${label}: got ${actual}, want ${expected}`);
    };

    // priceString: only a usable positive finite number becomes a string the game's parser accepts.
    must(
        priceString(NaN) === null && priceString(Infinity) === null && priceString(0) === null && priceString(-5) === null,
        "priceString rejects NaN/Infinity/0/negative",
    );
    must(priceString(1e12) === "1.00000000e+12" && !/[,bBtT]/.test(priceString(46743e6)), "priceString format");
    must(readSnapshot("") === null && readSnapshot("{}") === null && readSnapshot("{oops") === null, "readSnapshot rejects");
    must(readSnapshot('{"hasCorp":true,"divisions":{}}')?.hasCorp === true, "readSnapshot accepts a snapshot");

    // Custom pricing: cycle 1 measures, cycle 2 prices from the measurement, cycle 3 never re-measures.
    const mem = newMemory();
    const ns = mockNs({ sold: 4 });
    const snap = fakeSnapshot();
    const c1 = runCycle(ns, snap, mem);
    const baseline = ns.calls.sellProduct.filter((c) => c.price === "MP" && c.all === true);
    must(baseline.length === 1, `baseline placed once with all=true, got ${baseline.length}`);
    const measured = ns.calls.sellProduct.filter((c) => c.all === false);
    must(measured.length === 2 && measured.every((c) => Number(c.price) === 1e15), `one measurement per city: ${JSON.stringify(measured)}`);
    must(ns.calls.sellMaterial.length === 2, `materials priced per city, got ${ns.calls.sellMaterial.length}`);
    must(c1.baseline === 1 && c1.ta2 === 0 && c1.custom === 4, `counts cycle 1: ${JSON.stringify(c1)}`); // 2 product + 2 material prices

    ns.calls.sellProduct.length = 0;
    ns.calls.sellMaterial.length = 0;
    mem.cycle = 1;
    const c2 = runCycle(ns, snap, mem);
    must(ns.calls.sellProduct.length === 2 && ns.calls.sellProduct.every((c) => c.all === false), "prices every city, no re-measure");
    // price = MarkupLimit*sqrt(PSV)/sqrt(Stored/10) + MarketPrice, and PSV cancels against the measured limit.
    const expected = (1e15 - 1000) * Math.sqrt(4 / (10 / 10)) + 1000;
    for (const c of ns.calls.sellProduct) nearly(Number(c.price), expected, `optimal price from the measurement (${c.price})`);
    must(c2.custom === 4, `counts cycle 2: ${JSON.stringify(c2)}`);

    ns.calls.sellProduct.length = 0;
    mem.cycle = 2;
    runCycle(ns, snap, mem);
    must(ns.calls.sellProduct.every((c) => Number(c.price) !== 1e15), "a cached ProductMarkup is never re-measured");

    // Market-TA.II researched: the game prices it, the custom branch is skipped entirely.
    const nsTa2 = mockNs({ sold: 4 });
    const c3 = runCycle(nsTa2, fakeSnapshot({ div: { researched: { "Market-TA.II": true } } }), newMemory());
    must(nsTa2.calls.productTA2.length === 1 && nsTa2.calls.productTA2[0].on === true, "setProductMarketTA2(div, product, true)");
    must(nsTa2.calls.materialTA2.length === 2, `setMaterialMarketTA2 per city, got ${nsTa2.calls.materialTA2.length}`);
    must(nsTa2.calls.sellProduct.every((c) => c.price === "MP") && c3.ta2 === 1 && c3.custom === 0, "TA2 skips the custom branch");

    // Neither unlock: only the baseline runs - and it must not throw.
    const nsBase = mockNs({ sold: 4 });
    const c4 = runCycle(nsBase, fakeSnapshot({ unlocks: {} }), newMemory());
    must(nsBase.calls.sellProduct.length === 1 && nsBase.calls.sellProduct[0].price === "MP" && c4.custom === 0, "no unlocks -> baseline only");

    // Unusable numbers are skipped, never written ("NaN" would be rejected by the game's price parser).
    const nsNan = mockNs({ sold: 4 });
    nsNan.corporation.getProduct = () => ({
        name: "P1",
        developmentProgress: 100,
        effectiveRating: 100,
        productionCost: Infinity,
        stored: 10,
        actualSellAmount: 1,
        demand: 1,
        competition: 0,
    });
    runCycle(nsNan, fakeSnapshot(), newMemory());
    must(nsNan.calls.sellProduct.filter((c) => c.all === false).length === 0, "Infinity productionCost -> no sell order");

    // A division without a warehouse in a city must not call getMaterial there (it throws).
    const nsNoWh = mockNs({ sold: 4 });
    runCycle(nsNoWh, fakeSnapshot({ div: { warehouses: { "Sector-12": {} } } }), newMemory());
    must(nsNoWh.calls.sellMaterial.length === 1, `only warehouse cities get material prices, got ${nsNoWh.calls.sellMaterial.length}`);

    // A material industry (makesProducts false, e.g. Agriculture) still gets its produced materials priced (step 4).
    const nsMat = mockNs({ sold: 4 });
    const snapMat = fakeSnapshot();
    snapMat.divisions["Dark Soil"] = {
        industry: "Agriculture",
        makesProducts: false,
        awareness: 1,
        popularity: 1,
        cities: ["Sector-12"],
        warehouses: { "Sector-12": {} },
        researched: {},
        products: [],
    };
    const c5 = runCycle(nsMat, snapMat, newMemory());
    must(nsMat.calls.sellMaterial.length === 3, `material-only division is priced too, got ${nsMat.calls.sellMaterial.length}`);
    must(c5.baseline === 1 && c5.ta2 === 0 && c5.custom === 5, `material-only division counts: ${JSON.stringify(c5)}`);

    return true;
}
