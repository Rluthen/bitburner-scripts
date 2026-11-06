/** T16 - corp-supply.js: the custom Smart Supply + warehouse-congestion SERVICE.
 *
 * Why: the built-in "Smart Supply" unlock costs 25e9 = 17% of the 150e9 BN3 seed. The guide measures round 1 at
 * 540-560b (mean 551.164b) with a custom Smart Supply script against 335-346b (mean 340.413b) without it
 * (§19.1 p72) - +62%, and the offer compounds into round 2 (which needs >= 490b). A custom script is also the
 * only way to use the guide's congestion mitigation (§12.2).
 *
 * This is a port of the guide's algorithm (guide §12 p47-48 = reference corporationUtils.ts
 * getLimitedRawProduction / setSmartSupplyData / detectWarehouseCongestion / buyOptimalAmountOfInputMaterials):
 *   - just after the PURCHASE state: TotalRawProduction per `${divisionName}|${city}` = the material output (if
 *     the industry makes materials) + every FINISHED product, each capped so producing it still fits the
 *     warehouse's free space;
 *   - just before the PURCHASE state (i.e. when the state that just happened is START - CONTEXT §4's state order
 *     is START -> PURCHASE -> ...): discard + stop buying the inputs of a congested warehouse, then set every
 *     input's buy amount from TotalRawProduction x coefficient, aligned to the input that yields the fewest
 *     output units, scaled down to the free space, minus what is already stored.
 * `buyMaterial` takes a PER-SECOND amount (Actions.ts buyMaterial -> material.buyAmount, consumed as
 * buyAmount * secondsPerMarketCycle (= 10) in Division.ts PURCHASE), so the per-cycle quantity is divided by 10.
 *
 * The built-in unlock is NOT required and NOT bought (T09 skips the 25e9 when corp.js runs with --custom-supply).
 * If this save has it and a warehouse still has it enabled, both systems would write material.buyAmount, so the
 * built-in is turned off (WARN once per warehouse).
 *
 * Distinct ns.corporation.* APIs referenced by THIS file (docs figures, NOT measured):
 *   0 GB : hasCorporation nextUpdate - not part of the ticket's API list, but a SERVICE cannot loop without them
 *   10 GB: getCorporation getDivision getIndustryData getMaterialData getWarehouse getOffice getMaterial
 *          getProduct getUpgradeLevel hasResearched
 *   20 GB: buyMaterial sellMaterial setSmartSupply
 *   => docs sum 160 GB + script base. This service reads the game directly (the ticket's acceptance names this
 *      API set, so it does NOT take the 0 GB T04-snapshot shortcut - and the snapshot has neither per-city
 *      warehouses nor productionAmount). Imports corp-lib.js / corp-formulas.js (0 corporation APIs) and
 *      helpers.js (getConfiguration, instanceCount); deliberately does NOT import corp-ops.js (that shared
 *      module would charge the ~30-function union of its exports).
 * A city with no warehouse is detected by catching getWarehouse's documented throw ("<division> does not have a
 * warehouse in '<city>'") rather than paying 10 GB for hasWarehouse, which the ticket's API list leaves out.
 *
 * Run:  run Corp/corp-supply.js --dry   (first: logs the orders it would place, touches nothing)
 *       or let the daemon start it: run corp.js --custom-supply
 * Ported from catloversg/bitburner-scripts (MIT): corporationUtils.ts - logic only.
 */
import { getConfiguration, instanceCount } from "../helpers.js";
import { corpLog } from "./corp-lib.js";
import { divisionRawProduction } from "./corp-formulas.js";

const CONGESTION_LIMIT = 5; // §12.2: more than this many consecutive zero-output cycles ⇒ very likely congested
const LOG_INTERVAL = 20; // cycles between the "supply: <N> orders, <M> congestion events" line

// `--dry` has to be IN the schema: ns.flags() (Flags.ts, called non-permissive) rejects any flag that is not
// declared, so an empty argsSchema could never carry it.
const argsSchema = [["dry", false]];

export function autocomplete(data, _) {
    data.flags(argsSchema);
    return [];
}

// -------------------------------------------------------------------------------------------------------
// Pure parts (no ns: runnable under node, see selfCheck at the bottom).

/** §12.1: net warehouse space one output unit costs (negative = producing frees space). Produced materials use
 * their own sizes, a product uses its `size`, and every required input's size x coefficient is subtracted.
 * @param {{isProduct?:boolean, productSize?:number, producedMaterials?:string[], requiredMaterials?:object,
 *          sizes:object}} args @returns {number} **/
export function spacePerOutputUnit({ isProduct = false, productSize = 0, producedMaterials = [], requiredMaterials = {}, sizes }) {
    let space = isProduct ? productSize : producedMaterials.reduce((total, name) => total + sizes[name], 0);
    for (const [name, coefficient] of Object.entries(requiredMaterials)) space -= sizes[name] * coefficient;
    return space;
}

/** §12.1 getLimitedRawProduction: raw production of one city for a whole cycle (the per-second figure x 10),
 * capped at the units that still fit in `freeSpace` whenever producing an output unit costs space.
 * @param {number} rawProductionPerSecond @param {number} spacePerUnit @param {number} freeSpace @returns {number} **/
export function limitedRawProduction(rawProductionPerSecond, spacePerUnit, freeSpace) {
    const perCycle = rawProductionPerSecond * 10;
    if (!(spacePerUnit > 0)) return Math.max(perCycle, 0);
    return Math.max(Math.min(perCycle, Math.floor(freeSpace / spacePerUnit)), 0);
}

/** §12.1 "Before PURCHASE": the input material units one city should buy this cycle (per CYCLE - the caller
 * divides by 10 for the per-second buyMaterial API). Port of the reference's buyOptimalAmountOfInputMaterials:
 * TotalRawProduction x coefficient, capped by what fits in the free space, aligned to the input that yields the
 * fewest output units, scaled down if the whole order would not fit, then minus what is already stored.
 * @param {{coefficients:object, sizes:object, totalRawProduction:number, stored?:object, freeSpace:number}} args
 * @returns {object} units per material name (0 when nothing more is needed) **/
export function requiredInputMaterials({ coefficients, sizes, totalRawProduction, stored = {}, freeSpace }) {
    const names = Object.keys(coefficients);
    const quantity = {};
    for (const name of names) {
        // Cap each input by the units of IT that would fit if it had the whole free space to itself...
        quantity[name] = Math.min(totalRawProduction * coefficients[name], Math.floor(freeSpace / sizes[name]));
    }
    // ...then align every input to the one that would make the fewest output units (so nothing is left over).
    let leastOutputUnits = Infinity;
    for (const name of names) leastOutputUnits = Math.min(leastOutputUnits, quantity[name] / coefficients[name]);
    let requiredSpace = 0;
    for (const name of names) {
        quantity[name] = leastOutputUnits * coefficients[name];
        requiredSpace += quantity[name] * sizes[name];
    }
    if (requiredSpace > freeSpace) {
        const multiplier = freeSpace / requiredSpace; // shrink the whole order so it cannot overfill the warehouse
        for (const name of names) quantity[name] = Math.floor(quantity[name] * multiplier);
    }
    for (const name of names) quantity[name] = Math.max(0, quantity[name] - (stored[name] ?? 0));
    return quantity;
}

// -------------------------------------------------------------------------------------------------------
// Game side.

/** @param {NS} ns **/
export async function main(ns) {
    const options = getConfiguration(ns, argsSchema);
    if (!options || (await instanceCount(ns)) > 1) return; // one instance only, like every other service
    ns.disableLog("ALL");
    const ctx = {
        dry: !!options.dry,
        cycle: 0,
        totals: { orders: 0, congested: 0 }, // since the last summary line
        smartSupply: new Map(), // `${division}|${city}` -> TotalRawProduction of the current cycle (§12.1)
        congestion: new Map(), // `${division}|${city}` -> consecutive cycles with no output (§12.2)
        builtInWarned: new Set(), // warehouses already warned about the built-in Smart Supply
        dryOrders: [], // what this cycle would buy (--dry)
    };

    while (true) {
        if (!ns.corporation.hasCorporation()) {
            await ns.sleep(5000); // the daemon may start services before the corporation exists
            continue;
        }
        // nextUpdate() resolves with the state that JUST happened (CONTEXT §4).
        const state = await ns.corporation.nextUpdate();
        if (state === "PURCHASE") {
            setSmartSupplyData(ns, ctx); // "after PURCHASE" (§12.1): measure what the next cycle will produce
        } else if (state === "START") {
            // The next state to be processed is PURCHASE, so this is the last moment to change the input orders.
            const counts = setInputMaterialOrders(ns, ctx);
            ctx.cycle++;
            ctx.totals.orders += counts.orders;
            ctx.totals.congested += counts.congested;
            if (ctx.dry && ctx.dryOrders.length > 0) corpLog(ns, `would buy (dry): ${ctx.dryOrders.join("; ")}`);
            ctx.dryOrders.length = 0;
            if (ctx.cycle % LOG_INTERVAL === 0) {
                const dry = ctx.dry ? " (dry)" : "";
                corpLog(ns, `supply${dry}: ${ctx.totals.orders} orders, ${ctx.totals.congested} congestion events in the last ${LOG_INTERVAL} cycles`);
                ctx.totals.orders = 0;
                ctx.totals.congested = 0;
            }
        }
    }
}

/** §12.1 "After PURCHASE": TotalRawProduction per division|city, i.e. what one cycle of production would consume.
 * The value is a rate (office x division x Smart Factories x research), not a measurement, so it is available
 * from the first cycle - and it is 0 while division.productionMult is still 0 (right after creation). **/
function setSmartSupplyData(ns, ctx) {
    const corp = ns.corporation.getCorporation();
    const smartFactoriesLevel = ns.corporation.getUpgradeLevel("Smart Factories"); // corp-wide: read once per cycle
    ctx.smartSupply.clear();
    for (const divisionName of corp.divisions) {
        const division = ns.corporation.getDivision(divisionName);
        const industry = ns.corporation.getIndustryData(division.industry);
        const requiredMaterials = industry.requiredMaterials ?? {};
        const producedMaterials = industry.producedMaterials ?? [];
        const sizes = materialSizes(ns, [...producedMaterials, ...Object.keys(requiredMaterials)]);

        // §9.1.1 research multipliers. hasResearched is a per-DIVISION lookup, so it is read once per division
        // (not once per city); "uPgrade: Fulcrum" only ever affects products.
        let researchMult = 1;
        if (ns.corporation.hasResearched(divisionName, "Drones - Assembly")) researchMult *= 1.2;
        if (ns.corporation.hasResearched(divisionName, "Self-Correcting Assemblers")) researchMult *= 1.1;
        const productResearchMult = ns.corporation.hasResearched(divisionName, "uPgrade: Fulcrum")
            ? researchMult * 1.05
            : researchMult;

        for (const city of division.cities) {
            const warehouse = tryGetWarehouse(ns, divisionName, city);
            if (!warehouse) continue; // a city without a warehouse has nothing to supply
            const office = ns.corporation.getOffice(divisionName, city);
            const freeSpace = warehouse.size - warehouse.sizeUsed;
            let totalRawProduction = 0;
            if (industry.makesMaterials) {
                const rawPerSecond = officeRawProduction(office, division, smartFactoriesLevel, researchMult, false);
                const spacePerUnit = spacePerOutputUnit({ producedMaterials, requiredMaterials, sizes });
                totalRawProduction += limitedRawProduction(rawPerSecond, spacePerUnit, freeSpace);
            }
            if (industry.makesProducts) {
                for (const productName of division.products) {
                    const product = ns.corporation.getProduct(divisionName, city, productName);
                    if (!(product.developmentProgress >= 100)) continue; // only finished products produce output
                    const rawPerSecond = officeRawProduction(office, division, smartFactoriesLevel, productResearchMult, true);
                    const spacePerUnit = spacePerOutputUnit({ isProduct: true, productSize: product.size, requiredMaterials, sizes });
                    totalRawProduction += limitedRawProduction(rawPerSecond, spacePerUnit, freeSpace);
                }
            }
            ctx.smartSupply.set(`${divisionName}|${city}`, totalRawProduction);
        }
    }
}

/** §12.1 "Before PURCHASE": congestion mitigation, then the input orders of every city.
 * @returns {{orders:number, congested:number}} what this cycle did (or, with --dry, would have done) **/
function setInputMaterialOrders(ns, ctx) {
    const counts = { orders: 0, congested: 0 };
    const corp = ns.corporation.getCorporation();
    for (const divisionName of corp.divisions) {
        const division = ns.corporation.getDivision(divisionName);
        const industry = ns.corporation.getIndustryData(division.industry);
        const coefficients = industry.requiredMaterials ?? {};
        const names = Object.keys(coefficients);
        if (names.length === 0) continue; // this industry buys nothing (no dummy work: only what it requires)
        const sizes = materialSizes(ns, names);

        for (const city of division.cities) {
            const warehouse = tryGetWarehouse(ns, divisionName, city);
            if (!warehouse) continue;
            turnOffBuiltInSmartSupply(ns, ctx, divisionName, city, warehouse.smartSupplyEnabled);
            const office = ns.corporation.getOffice(divisionName, city);
            const key = `${divisionName}|${city}`;
            // An office of nothing but R&D produces nothing, so a 0 productionAmount is not congestion (§12.2).
            const researchOnly = (office.employeeJobs["Research & Development"] ?? 0) === office.numEmployees;
            if (!researchOnly && detectCongestion(ns, ctx, division, industry, city, names)) {
                counts.congested++;
                continue; // inputs are being discarded: buying more this cycle would only refill the warehouse
            }
            const totalRawProduction = ctx.smartSupply.get(key);
            if (totalRawProduction === undefined) continue; // no PURCHASE handled yet: leave the orders untouched
            const stored = {};
            for (const name of names) stored[name] = Number(ns.corporation.getMaterial(divisionName, city, name).stored);
            const quantities = requiredInputMaterials({
                coefficients,
                sizes,
                totalRawProduction,
                stored,
                freeSpace: warehouse.size - warehouse.sizeUsed,
            });
            const wouldBuy = [];
            for (const [name, quantity] of Object.entries(quantities)) {
                if (quantity > 0) {
                    counts.orders++;
                    wouldBuy.push(`${name} ${Math.round(quantity)}`);
                }
                // Written even when it is 0: material.buyAmount persists until it is overwritten (Division.ts
                // only re-sets it for the built-in path), so skipping the write would keep buying forever.
                if (!ctx.dry) ns.corporation.buyMaterial(divisionName, city, name, quantity / 10); // per SECOND
            }
            if (ctx.dry && wouldBuy.length > 0) ctx.dryOrders.push(`${key}: ${wouldBuy.join(", ")}`);
        }
    }
    return counts;
}

/** §12.2 congestion heuristic: count consecutive cycles where an OUTPUT's productionAmount is 0 - more than 5 in
 * a row and the warehouse is very likely full of inputs, so production is stalled. Mitigation: clear the input
 * purchase orders and discard what is stored. @returns {boolean} true when the warehouse is congested **/
function detectCongestion(ns, ctx, division, industry, city, requiredMaterials) {
    const divisionName = division.name;
    const key = `${divisionName}|${city}`;
    const outputs = []; // produced materials first, then every finished product (the reference's item order)
    for (const name of industry.producedMaterials ?? []) outputs.push(ns.corporation.getMaterial(divisionName, city, name));
    for (const productName of division.products) {
        const product = ns.corporation.getProduct(divisionName, city, productName);
        if (product.developmentProgress >= 100) outputs.push(product);
    }
    let stalled = false;
    for (const output of outputs) {
        if (output.productionAmount !== 0) {
            ctx.congestion.set(key, 0); // something is coming out: not congested
            continue;
        }
        ctx.congestion.set(key, (ctx.congestion.get(key) ?? 0) + 1);
        stalled = true;
        break;
    }
    if ((ctx.congestion.get(key) ?? 0) > CONGESTION_LIMIT) {
        corpLog(
            ns,
            `warehouse congestion in ${key}: no output for ${ctx.congestion.get(key)} cycles - discarding stored inputs${ctx.dry ? " (dry: not applied)" : ""}`,
            "WARN",
        );
        for (const name of requiredMaterials) {
            if (ctx.dry) continue;
            ns.corporation.buyMaterial(divisionName, city, name, 0); // stop buying
            ns.corporation.sellMaterial(divisionName, city, name, "MAX", "0"); // price 0 = discard
        }
        ctx.congestion.set(key, 0);
        return true;
    }
    if (!stalled) {
        // Not congested: a previous mitigation may still have the inputs on "sell MAX at 0" (= discard). Stop it.
        for (const name of requiredMaterials) {
            const material = ns.corporation.getMaterial(divisionName, city, name);
            // desiredSellAmount is the STRING set through the API (Actions.convertAmountString) after any
            // sellMaterial call, so compare as text ("0" = sell nothing).
            if (String(material.desiredSellAmount).trim() === "0") continue;
            if (!ctx.dry) ns.corporation.sellMaterial(divisionName, city, name, "0", "0");
        }
    }
    return false;
}

/** The built-in Smart Supply writes material.buyAmount too (Division.ts PURCHASE), so a warehouse that still has
 * it on would fight these orders. Turn it off - the ticket's second half of the "do not buy the built-in" rule. **/
function turnOffBuiltInSmartSupply(ns, ctx, divisionName, city, enabled) {
    const key = `${divisionName}|${city}`;
    if (!enabled) {
        ctx.builtInWarned.delete(key); // enabled again later? warn again (a stable key, per the log-spam rule)
        return;
    }
    if (!ctx.builtInWarned.has(key)) {
        ctx.builtInWarned.add(key);
        corpLog(
            ns,
            `built-in Smart Supply is enabled in ${key} - turning it off so it does not fight the custom orders${ctx.dry ? " (dry: not applied)" : ""}`,
            "WARN",
        );
    }
    if (!ctx.dry) ns.corporation.setSmartSupply(divisionName, city, false); // needs the unlock: it is on, so it is there
}

/** getWarehouse THROWS for a city with no warehouse ("<division> does not have a warehouse in '<city>'"); a city
 * that is merely missing one must never stop the service (T16 acceptance 3). @returns {object|null} **/
function tryGetWarehouse(ns, divisionName, city) {
    try {
        return ns.corporation.getWarehouse(divisionName, city);
    } catch {
        return null;
    }
}

/** Sizes of the named materials, read once per division/cycle (§8.3 and §12.1 need them, and they never change). **/
function materialSizes(ns, names) {
    const sizes = {};
    for (const name of names) sizes[name] = ns.corporation.getMaterialData(name).size;
    return sizes;
}

/** Raw production per SECOND of one office (§9.1.1, through T02's pure divisionRawProduction). 0 when the office
 * has no Operations/Engineer/Management employees, and 0 right after a division is created because
 * division.productionMult is still 0 then (CONTEXT §4). **/
function officeRawProduction(office, division, smartFactoriesLevel, productionResearchMult, isProduct) {
    const jobs = office.employeeProductionByJob ?? {};
    return divisionRawProduction({
        isProduct,
        operationsProd: Number(jobs["Operations"] ?? 0),
        engineerProd: Number(jobs["Engineer"] ?? 0),
        managementProd: Number(jobs["Management"] ?? 0),
        divisionProductionMult: division.productionMult,
        smartFactoriesLevel,
        productionResearchMult,
    });
}

// -------------------------------------------------------------------------------------------------------
// Offline self-check (no game, no ns). Proves the arithmetic of the acceptance numbers and the wiring of the
// service loop with a mock NS - NOT in-game correctness.

/** Minimal fake NS: only the APIs this file touches, with the game's own trap (getWarehouse throws in a city
 * without a warehouse). `state` holds the numbers each test wants to see. **/
function mockNs(state) {
    const calls = { buy: [], sell: [], smartSupply: [], warehouseMissing: 0 };
    const divisions = {
        "Dark Soil": {
            name: "Dark Soil",
            industry: "Agriculture",
            productionMult: 804.175,
            products: [],
            cities: ["Sector-12", "Aevum"], // Aevum deliberately has NO warehouse
            warehouses: { "Sector-12": { size: 900, sizeUsed: 100, smartSupplyEnabled: false } },
        },
        "Ebon Stick": {
            name: "Ebon Stick",
            industry: "Tobacco",
            productionMult: 40, // non-zero, so the product path is exercised
            products: ["P1"],
            cities: ["Sector-12"],
            warehouses: { "Sector-12": { size: 1000, sizeUsed: 0, smartSupplyEnabled: true } },
        },
    };
    const industries = {
        Agriculture: { requiredMaterials: { Water: 0.5, Chemicals: 0.2 }, producedMaterials: ["Plants", "Food"], makesMaterials: true, makesProducts: false },
        Tobacco: { requiredMaterials: { Plants: 1 }, makesMaterials: false, makesProducts: true },
    };
    const sizes = { Water: 0.05, Chemicals: 0.1, Plants: 0.05, Food: 0.03 };
    return {
        calls,
        divisions,
        industries,
        sizes,
        print: () => {},
        getScriptName: () => "Corp/corp-supply.js",
        getPortHandle: () => ({ write: () => {} }),
        corporation: {
            getCorporation: () => ({ divisions: Object.keys(divisions) }),
            getDivision: (name) => divisions[name],
            getIndustryData: (industry) => industries[industry],
            getUpgradeLevel: () => 0,
            hasResearched: () => false,
            getMaterialData: (name) => ({ size: sizes[name] }),
            getWarehouse: (name, city) => {
                const warehouse = divisions[name].warehouses[city];
                if (!warehouse) {
                    calls.warehouseMissing++;
                    throw new Error(`${name} does not have a warehouse in '${city}'`);
                }
                return warehouse;
            },
            getOffice: (name, city) => ({
                employeeProductionByJob: { Operations: 100, Engineer: 100, Management: 0 },
                employeeJobs: { "Research & Development": state.researchOnly ? (state.numEmployees ?? 3) : 0 },
                numEmployees: state.numEmployees ?? 3,
            }),
            getProduct: (name, city, productName) => ({
                developmentProgress: state.productProgress ?? 100,
                productionAmount: state.productionAmount ?? 5,
                size: 0.05,
            }),
            getMaterial: (name, city, material) => ({
                stored: state.stored?.[material] ?? 0,
                productionAmount: state.productionAmount ?? 5,
                desiredSellAmount: state.discarding?.[material] ? "MAX" : 0,
            }),
            buyMaterial: (name, city, material, amount) => calls.buy.push({ name, city, material, amount }),
            sellMaterial: (name, city, material, amount, price) => calls.sell.push({ name, city, material, amount, price }),
            setSmartSupply: (name, city, enabled) => calls.smartSupply.push({ name, city, enabled }),
        },
    };
}

/** Runnable check (no game needed):
 *   node --input-type=module -e "import('./Corp/corp-supply.js').then(m=>m.selfCheck()).then(r=>console.log('selfCheck:',r))"
 * Throws on the first failure. **/
export function selfCheck() {
    const must = (ok, label) => {
        if (!ok) throw new Error(`selfCheck: ${label}`);
    };
    const near = (actual, expected, tol, label) => {
        if (!(Math.abs(actual - expected) <= tol)) throw new Error(`selfCheck: ${label}: got ${actual}, want ${expected}`);
    };
    const same = (actual, expected, label) => {
        const a = JSON.stringify(actual);
        const e = JSON.stringify(expected);
        if (a !== e) throw new Error(`selfCheck: ${label}: got ${a}, want ${e}`);
    };

    // --- Acceptance 2: the reviewer's port of reference lines 970-1021 (values as given, no tolerance) ---
    const coefficients = { Water: 0.5, Chemicals: 0.2 };
    // The acceptance's own test sizes (the game's real ones come from getMaterialData at runtime, §4b-style).
    const sizes = { Water: 0.05, Chemicals: 0.1, Plants: 0.05, Food: 0.03 };
    const order = (stored, freeSpace) => requiredInputMaterials({ coefficients, sizes, totalRawProduction: 1000, stored, freeSpace });
    same(order({ Water: 100, Chemicals: 0 }, 1e9), { Water: 400, Chemicals: 200 }, "freeSpace 1e9 (no scaling)");
    same(order({ Water: 100, Chemicals: 0 }, 50), { Water: 400, Chemicals: 200 }, "freeSpace 50 = required 45, boundary");
    same(order({ Water: 100, Chemicals: 0 }, 22.5), { Water: 150, Chemicals: 100 }, "freeSpace 22.5 (cap + align + scale)");
    same(order({ Water: 0, Chemicals: 0 }, 22.5), { Water: 250, Chemicals: 100 }, "freeSpace 22.5, nothing stored");
    // No required materials (e.g. a division with nothing to buy): an empty order, never a NaN.
    same(requiredInputMaterials({ coefficients: {}, sizes: {}, totalRawProduction: 1000, freeSpace: 0 }), {}, "no inputs");
    // Everything already stored: nothing to buy.
    same(order({ Water: 500, Chemicals: 200 }, 1e9), { Water: 0, Chemicals: 0 }, "full warehouse of inputs");

    // --- getLimitedRawProduction / spacePerOutputUnit: the free-space cap of §12.1 ---
    // Agriculture (Plants 0.05 + Food 0.03) minus Water 0.5*0.05 and Chemicals 0.2*0.1 = 0.035 per output unit.
    near(spacePerOutputUnit({ producedMaterials: ["Plants", "Food"], requiredMaterials: coefficients, sizes }), 0.035, 1e-12, "spacePerOutputUnit");
    near(limitedRawProduction(100, 0.035, 1e9), 1000, 1e-9, "limitedRawProduction uncapped (raw x10)");
    near(limitedRawProduction(100, 0.035, 20), Math.floor(20 / 0.035), 1e-9, "limitedRawProduction capped by free space");
    near(limitedRawProduction(100, -0.01, 20), 1000, 1e-9, "producing frees space: no cap");
    near(limitedRawProduction(0, 0.035, 1e9), 0, 1e-9, "no production");

    // --- Acceptance 3 + wiring: a mock NS, no throw, and the orders the acceptance would place ---
    const ns = mockNs({});
    const ctx = { dry: false, cycle: 0, totals: { orders: 0, congested: 0 }, smartSupply: new Map(), congestion: new Map(), builtInWarned: new Set(), dryOrders: [] };
    setSmartSupplyData(ns, ctx); // the PURCHASE half
    must(ns.calls.warehouseMissing === 1, `getWarehouse throw caught for Aevum, got ${ns.calls.warehouseMissing}`);
    must(ctx.smartSupply.has("Dark Soil|Sector-12") && !ctx.smartSupply.has("Dark Soil|Aevum"), `smart supply keys ${[...ctx.smartSupply.keys()]}`);

    // Dark Soil: material output only. Expected total = the pure functions applied to the mock's own numbers.
    const office = { employeeProductionByJob: { Operations: 100, Engineer: 100, Management: 0 } };
    const rawPerSecond = officeRawProduction(office, ns.divisions["Dark Soil"], 0, 1, false);
    const expectedTotal = limitedRawProduction(rawPerSecond, 0.035, 800);
    near(ctx.smartSupply.get("Dark Soil|Sector-12"), expectedTotal, 1e-9, "TotalRawProduction (materials only)");
    // Ebon Stick: an unfinished product contributes nothing (and must not throw).
    const tobProductSpace = spacePerOutputUnit({ isProduct: true, productSize: 0.05, requiredMaterials: { Plants: 1 }, sizes });
    near(ctx.smartSupply.get("Ebon Stick|Sector-12"), limitedRawProduction(officeRawProduction(office, ns.divisions["Ebon Stick"], 0, 1, true), tobProductSpace, 1000), 1e-9, "Tobacco product not bought yet");

    const counts = setInputMaterialOrders(ns, ctx);
    const expectedQuantities = requiredInputMaterials({ coefficients, sizes, totalRawProduction: expectedTotal, stored: { Water: 0, Chemicals: 0 }, freeSpace: 800 });
    must(counts.orders === 3, `2 Agriculture inputs + 1 Tobacco input, got ${counts.orders}`);
    for (const [material, amount] of Object.entries(expectedQuantities)) {
        const call = ns.calls.buy.find((c) => c.name === "Dark Soil" && c.material === material);
        near(call.amount, amount / 10, 1e-9, `buyMaterial ${material} is the per-cycle amount / 10`);
    }
    // Tobacco buys its own input (Plants) from ITS TotalRawProduction, and no city without a warehouse is touched.
    const tobaccoPlants = ns.calls.buy.find((c) => c.name === "Ebon Stick" && c.material === "Plants");
    const tobaccoOrder = requiredInputMaterials({ coefficients: { Plants: 1 }, sizes, totalRawProduction: ctx.smartSupply.get("Ebon Stick|Sector-12"), stored: { Plants: 0 }, freeSpace: 1000 });
    near(tobaccoPlants.amount, tobaccoOrder.Plants / 10, 1e-9, "Tobacco's own input order");
    must(ns.calls.buy.every((c) => c.city === "Sector-12"), `no order for the city without a warehouse: ${JSON.stringify(ns.calls.buy)}`);
    // The built-in Smart Supply is on in Ebon Stick|Sector-12 and must be switched off (WARN once).
    must(ns.calls.smartSupply.length === 1 && ns.calls.smartSupply[0].enabled === false, `setSmartSupply off: ${JSON.stringify(ns.calls.smartSupply)}`);
    ns.calls.smartSupply.length = 0;
    setInputMaterialOrders(ns, ctx);
    must(ns.calls.smartSupply.length === 1, "turned off again every cycle it is found on (the game may re-enable it)");

    // --- Congestion: 6 consecutive cycles without output ⇒ discard inputs, skip the orders, reset the counter ---
    const stuck = mockNs({ productionAmount: 0 });
    const stuckCtx = { ...ctx, smartSupply: new Map(ctx.smartSupply) };
    for (let i = 0; i < 5; i++) must(setInputMaterialOrders(stuck, stuckCtx).congested === 0, `not congested after ${i + 1} dry cycles`);
    const congested = setInputMaterialOrders(stuck, stuckCtx);
    must(congested.congested === 2, `both cities congested on the 6th zero-production cycle, got ${congested.congested}`);
    must(stuck.calls.sell.length === 3 && stuck.calls.sell.every((c) => c.amount === "MAX" && c.price === "0"), `discard every input: ${JSON.stringify(stuck.calls.sell)}`);
    must(stuck.calls.buy.slice(-3).every((c) => c.amount === 0), `the congestion cycle clears every input order: ${JSON.stringify(stuck.calls.buy.slice(-3))}`);
    must(setInputMaterialOrders(stuck, stuckCtx).congested === 0, "counter reset after the mitigation");
    // An all-R&D office produces nothing on purpose: never a congestion event, however many cycles it stays at 0.
    const idle = mockNs({ productionAmount: 0, researchOnly: true });
    for (let i = 0; i < 10; i++) must(setInputMaterialOrders(idle, { ...ctx, smartSupply: new Map(ctx.smartSupply) }).congested === 0, "all-R&D office is skipped");
    // A warehouse that was left discarding its inputs gets the "sell none" order back once it is not congested.
    const recovering = mockNs({ discarding: { Water: true, Chemicals: true } });
    setInputMaterialOrders(recovering, { ...ctx, smartSupply: new Map(ctx.smartSupply) });
    must(recovering.calls.sell.length === 2 && recovering.calls.sell.every((c) => c.amount === "0" && c.price === "0"), `stop discarding: ${JSON.stringify(recovering.calls.sell)}`);

    // --- --dry: identical decisions, zero calls ---
    const dry = mockNs({});
    const dryCtx = { dry: true, cycle: 0, totals: { orders: 0, congested: 0 }, smartSupply: new Map(), congestion: new Map(), builtInWarned: new Set(), dryOrders: [] };
    setSmartSupplyData(dry, dryCtx);
    const dryCounts = setInputMaterialOrders(dry, dryCtx);
    must(dryCounts.orders === 3 && dry.calls.buy.length === 0 && dry.calls.sell.length === 0 && dry.calls.smartSupply.length === 0, "--dry touches nothing but still decides");
    must(dryCtx.dryOrders.length === 2 && dryCtx.dryOrders[0].startsWith("Dark Soil|Sector-12: Water "), `--dry reports its orders: ${JSON.stringify(dryCtx.dryOrders)}`);

    return true;
}
