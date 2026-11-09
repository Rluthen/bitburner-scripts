/** T04 - corp-snapshot.js: the ONLY expensive corporation reader (one shot, no loop).
 *
 * Reads the whole corporation once and writes it as JSON to STATE_FILE (/Temp/corp-state.txt).
 * The daemon (T07) and the light services read that file with ns.read (0 GB) instead of paying
 * 10 GB per distinct getter themselves. Launched by the daemon once per corp cycle.
 *
 * Distinct ns.corporation.* APIs used (RAM is charged per DISTINCT name - docs figures, NOT measured):
 *   0 GB : hasCorporation
 *   10 GB: getCorporation getDivision getInvestmentOffer hasUnlock getUpgradeLevel getOffice
 *          hasWarehouse getWarehouse getProduct hasResearched
 *   => 10 x 10 GB = ~100 GB + ~1.6 GB script base.
 *
 * Shape of the JSON produced (T06/T07 depend on these exact keys - do NOT rename):
 *   { "t":1730000000000, "hasCorp":true,
 *     "corp":{"name":"Erebos","funds":5e9,"revenue":1e6,"expenses":2e5,"profit":8e5,"public":false,
 *             "valuation":1e12,"sharePrice":0,"dividendRate":0,"dividendEarnings":0,"numShares":0,"totalShares":0,
 *             "prevState":"SALE","nextState":"START","divisions":["Dark Soil"]},
 *     "offer":{"funds":5.5e11,"round":1,"shares":0},
 *     "unlocks":{...} , "upgrades":{...} ,
 *     "divisions":{"Dark Soil":{"industry":"Agriculture",...,"offices":{...},"warehouses":{...},"products":[...]}} }
 *
 * T04. Guide refs: §2 FAQ p9-10 (split work into small scripts to save RAM), §5 p23 (serve awkward data
 * from a file), §18.1 p68 (record prevState/nextState so callers know when the snapshot was taken).
 */
import { corpLog, STATE_FILE } from "./corp-lib.js";

// Exact key sets the schema promises. Kept as arrays so the order is stable in the output.
const UNLOCKS = ["Export", "Smart Supply", "Market Research - Demand", "Market Data - Competition", "Shady Accounting", "Government Partnership"];
const UPGRADES = ["Smart Factories", "Smart Storage", "Wilson Analytics", "Nuoptimal Nootropic Injector Implants", "Speech Processor Implants", "Neural Accelerators", "FocusWires", "ABC SalesBots", "Project Insight"];
const RESEARCH = ["Hi-Tech R&D Laboratory", "Market-TA.I", "Market-TA.II", "Overclock", "Sti.mu", "Automatic Drug Administration", "Go-Juice", "CPH4 Injections", "Self-Correcting Assemblers", "Drones", "Drones - Assembly", "Drones - Transport", "uPgrade: Fulcrum"];
const JOBS = ["Operations", "Engineer", "Business", "Management", "Research & Development", "Intern", "Unassigned"];

/** hasResearched THROWS for a name that is not in this industry's own tree (e.g. a product-only research
 * on a material industry), so a throw means "not researched here". @returns {boolean} **/
function isResearched(ns, division, name) {
    try {
        return ns.corporation.hasResearched(division, name);
    } catch {
        return false;
    }
}

/** Read one division. @returns {object} the division's slice of the snapshot **/
function readDivision(ns, name) {
    const d = ns.corporation.getDivision(name);
    const offices = {};
    for (const city of d.cities) {
        const o = ns.corporation.getOffice(name, city);
        offices[city] = {
            size: o.size,
            numEmployees: o.numEmployees,
            avgEnergy: o.avgEnergy,
            maxEnergy: o.maxEnergy,
            avgMorale: o.avgMorale,
            maxMorale: o.maxMorale,
            jobs: Object.fromEntries(JOBS.map((job) => [job, o.employeeJobs[job] ?? 0])),
        };
    }
    const warehouses = {};
    for (const city of d.cities) {
        if (!ns.corporation.hasWarehouse(name, city)) continue; // getWarehouse throws on a city with none
        const w = ns.corporation.getWarehouse(name, city);
        warehouses[city] = { level: w.level, size: w.size, sizeUsed: w.sizeUsed, smartSupplyEnabled: w.smartSupplyEnabled };
    }
    // A product's stats are the same in every city, so read them from the city with the most employees
    // (that office gives the most representative campaign numbers); fall back to cities[0].
    const firstCity = d.cities.reduce((best, city) => ((offices[city].numEmployees > offices[best].numEmployees) ? city : best), d.cities[0]);
    const products = d.products.map((productName) => {
        const p = ns.corporation.getProduct(name, firstCity, productName);
        return {
            name: p.name,
            developmentProgress: p.developmentProgress,
            rating: p.rating,
            effectiveRating: p.effectiveRating,
            designInvestment: p.designInvestment,
            advertisingInvestment: p.advertisingInvestment,
            stored: p.stored,
            actualSellAmount: p.actualSellAmount,
        };
    });
    const researched = {};
    for (const r of RESEARCH) researched[r] = isResearched(ns, name, r);
    return {
        industry: d.industry,
        researchPoints: d.researchPoints,
        awareness: d.awareness,
        popularity: d.popularity,
        numAdVerts: d.numAdVerts,
        productionMult: d.productionMult,
        lastCycleRevenue: d.lastCycleRevenue,
        lastCycleExpenses: d.lastCycleExpenses,
        makesProducts: d.makesProducts,
        maxProducts: d.maxProducts,
        cities: d.cities,
        researched,
        offices,
        warehouses,
        products,
    };
}

/** Read the whole corporation into a plain object. Exported so the shape can be checked without the game.
 * @returns {object} **/
export function buildSnapshot(ns) {
    const corp = ns.corporation.getCorporation();
    const unlocks = {};
    for (const name of UNLOCKS) unlocks[name] = ns.corporation.hasUnlock(name);
    const upgrades = {};
    for (const name of UPGRADES) upgrades[name] = ns.corporation.getUpgradeLevel(name);
    const divisions = {};
    for (const name of corp.divisions) divisions[name] = readDivision(ns, name);
    const offer = ns.corporation.getInvestmentOffer();
    return {
        t: Date.now(),
        hasCorp: true,
        corp: {
            name: corp.name,
            funds: corp.funds,
            revenue: corp.revenue,
            expenses: corp.expenses,
            profit: corp.revenue - corp.expenses, // per second
            public: corp.public,
            valuation: corp.valuation,
            sharePrice: corp.sharePrice,
            dividendRate: corp.dividendRate,
            dividendEarnings: corp.dividendEarnings, // per second, 0 until the corporation issues a dividend
            numShares: corp.numShares,
            totalShares: corp.totalShares,
            prevState: corp.prevState,
            nextState: corp.nextState,
            divisions: corp.divisions,
        },
        offer: { funds: offer.funds, round: offer.round, shares: offer.shares },
        unlocks,
        upgrades,
        divisions,
    };
}

/** @param {NS} ns **/
export async function main(ns) {
    // hasCorporation is 0 GB; the early return saves time only (a script's RAM is static).
    if (!ns.corporation.hasCorporation()) {
        ns.write(STATE_FILE, JSON.stringify({ t: Date.now(), hasCorp: false }), "w");
        return;
    }
    try {
        // JSON.stringify turns NaN/Infinity into null for us, so the file is always valid JSON.
        ns.write(STATE_FILE, JSON.stringify(buildSnapshot(ns)), "w"); // "w" = rewritten every run
    } catch (e) {
        const message = String(e?.message ?? e);
        corpLog(ns, `snapshot failed: ${message}`, "ERROR");
        ns.write(STATE_FILE, JSON.stringify({ t: Date.now(), hasCorp: true, error: message }), "w");
    }
}

/** Minimal fake NS for the check below: only the APIs this file touches, following the game's semantics
 * for the one trap (hasResearched throws on an out-of-tree name). **/
function mockNs() {
    const cities = ["Sector-12", "Aevum"];
    const officeEmployees = { "Sector-12": 3, Aevum: 8 };
    const writes = {};
    const calls = { productCity: null };
    return {
        writes,
        calls,
        enums: { CityName: { "Sector-12": "Sector-12", Aevum: "Aevum" } },
        getScriptName: () => "Corp/corp-snapshot.js",
        print: () => {},
        getPortHandle: () => ({ write: () => {} }),
        write: (file, data) => {
            writes[file] = data;
        },
        corporation: {
            hasCorporation: () => true,
            getCorporation: () => ({
                name: "Erebos", funds: 5e9, revenue: 1e6, expenses: 2e5, public: true, valuation: 1e12,
                sharePrice: 0, dividendRate: 0.1, numShares: 1e9, totalShares: 1e9, dividendEarnings: 1.5e6,
                prevState: "SALE", nextState: "START", divisions: ["Dark Soil"],
            }),
            getInvestmentOffer: () => ({ funds: 5.5e11, round: 1, shares: 0 }),
            hasUnlock: (name) => name === "Export",
            getUpgradeLevel: (name) => (name === "Smart Storage" ? 25 : 0),
            getDivision: () => ({
                name: "Dark Soil", industry: "Agriculture", awareness: 5, popularity: 3, productionMult: 804.175,
                researchPoints: 1234, lastCycleRevenue: 1e6, lastCycleExpenses: 2e5, thisCycleRevenue: 0, thisCycleExpenses: 0,
                numAdVerts: 2, cities, products: ["Tofu"], makesProducts: true, maxProducts: 3,
            }),
            getOffice: (_div, city) => ({
                city, size: 8, numEmployees: officeEmployees[city], avgEnergy: 99, maxEnergy: 100, avgMorale: 99, maxMorale: 100,
                totalExperience: 0, employeeProductionByJob: {},
                employeeJobs: { Operations: 1, Engineer: 1, Business: 1, Management: 0, "Research & Development": 0, Intern: 0, Unassigned: officeEmployees[city] - 3 },
            }),
            hasWarehouse: (_div, city) => city === "Sector-12",
            getWarehouse: () => ({ level: 15, city: "Sector-12", size: 5250, sizeUsed: 100, smartSupplyEnabled: true }),
            hasResearched: (_div, name) => {
                if (name === "uPgrade: Fulcrum") throw new Error(`No such research: ${name}`);
                return name === "Market-TA.I";
            },
            getProduct: (_div, city, productName) => {
                calls.productCity = city;
                return {
                    name: productName, demand: undefined, competition: undefined, rating: Infinity, effectiveRating: 100,
                    productionCost: Infinity, desiredSellPrice: "MP", desiredSellAmount: "MAX", stored: 10, productionAmount: 0,
                    actualSellAmount: 4, developmentProgress: 100, advertisingInvestment: 1e9, designInvestment: 2e9, size: 0.05, productionLimit: null,
                };
            },
        },
    };
}

/** Runnable check of the shape and the no-corp path (no game needed):
 *   node --input-type=module -e "import('./Corp/corp-snapshot.js').then(m=>m.selfCheck()).then(r=>console.log('selfCheck:',r))"
 * Proves arithmetic/control flow and JSON validity only - NOT in-game correctness. **/
export async function selfCheck() {
    const must = (ok, label) => {
        if (!ok) throw new Error(`selfCheck: ${label}`);
    };
    const ns = mockNs();
    const snap = buildSnapshot(ns);
    must(snap.hasCorp === true && snap.corp.profit === 8e5, `profit ${snap.corp.profit}`);
    must(snap.offer.round === 1 && snap.offer.funds === 5.5e11, `offer ${JSON.stringify(snap.offer)}`);
    must(snap.corp.dividendEarnings === 1.5e6, `dividendEarnings ${snap.corp.dividendEarnings}`);
    must(Object.keys(snap.unlocks).length === 6 && snap.unlocks.Export === true && snap.unlocks["Smart Supply"] === false, "unlocks");
    must(Object.keys(snap.upgrades).length === 9 && snap.upgrades["Smart Storage"] === 25, "upgrades");
    const div = snap.divisions["Dark Soil"];
    must(Object.keys(div.offices).length === 2 && Object.keys(div.warehouses).length === 1, `offices/warehouses ${Object.keys(div.offices)} ${Object.keys(div.warehouses)}`);
    must(Object.keys(div.offices.Aevum.jobs).length === 7, "jobs key set");
    must(div.offices.Aevum.jobs.Unassigned === 5, `jobs counts ${div.offices.Aevum.jobs.Unassigned}`);
    must(div.researched["uPgrade: Fulcrum"] === false && div.researched["Market-TA.I"] === true, "hasResearched try/catch");
    must(ns.calls.productCity === "Aevum", `firstCity = most employees, got ${ns.calls.productCity}`);
    must(div.products.length === 1 && div.products[0].actualSellAmount === 4, "product fields");
    // Serialisable: no undefined, non-finite numbers become null, and a round trip preserves the data.
    const text = JSON.stringify(snap);
    must(div.products[0].productionCost === undefined, "productionCost deliberately omitted");
    const back = JSON.parse(text);
    must(back.divisions["Dark Soil"].products[0].productionCost === undefined && back.corp.funds === 5e9, "round trip");
    must(back.divisions["Dark Soil"].products[0].rating === null, "Infinity becomes null");
    // main() writes the "no corporation yet" marker when there is none.
    const empty = mockNs();
    empty.corporation.hasCorporation = () => false;
    await main(empty);
    const marker = JSON.parse(empty.writes[STATE_FILE]);
    must(marker.hasCorp === false && typeof marker.t === "number", `no-corp marker ${empty.writes[STATE_FILE]}`);
    return true;
}
