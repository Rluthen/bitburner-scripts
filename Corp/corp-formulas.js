/** Pure corporation math: costs, warehouse/office sizes, boost-material and storage/factory
 * optimizers, Wilson/Advert simulation, sales prices and product names.
 * No ns and no imports — this file must run under plain node (T02 acceptance 17).
 * Corporation API functions used: none.
 * Ported from catloversg/bitburner-scripts (MIT): corporationFormulas.ts / corporationUtils.ts.
 * Guide refs: §6.2 upgrades, §7 warehouse, §8 boost materials, §9.1/§10.2 divisions and offices,
 * §13 Advert, §16.2.1 potential sales volume, §16.3 selling price. */

export const BOOST_SIZES = [0.1, 0.06, 0.005, 0.5]; // AI Cores, Hardware, Real Estate, Robots

const SMART_BASE = 2e9; // Smart Storage / Smart Factories share base+mult
const SMART_MULT = 1.06;
const WILSON_BASE = 4e9;
const WILSON_MULT = 2;
const ADVERT_BASE = 1e9;
const ADVERT_MULT = 1.06;
const WAREHOUSE_BASE = 1e9;
const OFFICE_BASE = 4e9;
const OFFICE_MULT = 1.09; // exponent is size/3, not size

/** Exact Lagrange optimum (§8.3.2): q_i = (S - 500*((s_i/f_i)*(sumF - f_i) - (sumS - s_i))) / (sumF/f_i) / s_i.
 * Variables that come out negative (or have a zero factor) are dropped and the solve is redone (§8.5).
 * @param {number[]} factors in BOOST_SIZES order @param {number} S space to fill
 * @param {number[]} sizes @returns {number[]} quantities, same order, >= 0 **/
export function optimalBoostMaterials(factors, S, sizes = BOOST_SIZES) {
  const qty = factors.map(() => 0);
  let active = factors.map((f, i) => i).filter((i) => factors[i] > 0);
  while (active.length > 0) {
    const sumF = active.reduce((a, i) => a + factors[i], 0);
    const sumS = active.reduce((a, i) => a + sizes[i], 0);
    let dropped = -1;
    const solved = {};
    for (const i of active) {
      const q = (S - 500 * ((sizes[i] / factors[i]) * (sumF - factors[i]) - (sumS - sizes[i]))) / (sumF / factors[i]) / sizes[i];
      if (q < 0) {
        dropped = i;
        break;
      }
      solved[i] = Math.round(q);
    }
    if (dropped < 0) return qty.map((_, i) => (i in solved ? solved[i] : 0));
    active = active.filter((i) => i !== dropped);
  }
  return qty;
}

/** Division production multiplier for one city's boost quantities (§8.1). @returns number **/
export function productionMultiplier(factors, qty, cities = 6) {
  const cityMultiplier = factors.reduce((acc, f, i) => acc * Math.pow(1 + 0.002 * qty[i], f), 1);
  return Math.max(Math.pow(cityMultiplier, 0.73), 1) * cities;
}

/** Cost of a normal upgrade, base * (mult^to - mult^from) / (mult - 1) (§6.2). **/
export function upgradeCost(base, mult, fromLevel, toLevel) {
  return (base * (Math.pow(mult, toLevel) - Math.pow(mult, fromLevel))) / (mult - 1);
}

/** Highest level reachable with `budget`. Returns `fromLevel` when no upgrade is affordable. **/
export function maxAffordableLevel(base, mult, fromLevel, budget) {
  return Math.max(fromLevel, Math.floor(Math.log((budget * (mult - 1)) / base + Math.pow(mult, fromLevel)) / Math.log(mult)));
}

/** Warehouse upgrade cost; exponent is level+1 (differs from normal upgrades, §7). **/
export function warehouseUpgradeCost(fromLevel, toLevel) {
  return (WAREHOUSE_BASE * (Math.pow(1.07, toLevel + 1) - Math.pow(1.07, fromLevel + 1))) / 0.07;
}

/** Highest warehouse level reachable with `budget` (**per city**). **/
export function maxAffordableWarehouseLevel(fromLevel, budget) {
  return Math.max(fromLevel, Math.floor(Math.log((budget * 0.07) / WAREHOUSE_BASE + Math.pow(1.07, fromLevel + 1)) / Math.log(1.07) - 1));
}

/** Warehouse size: level * 100 * (1 + 0.1*SmartStorage) * researchMult (§7). **/
export function warehouseSize(level, smartStorageLevel, researchMult = 1) {
  return level * 100 * (1 + 0.1 * smartStorageLevel) * researchMult;
}

/** Office size upgrade cost, exponent is size/3 (§10.2). **/
export function officeUpgradeCost(fromSize, toSize) {
  return (OFFICE_BASE * (Math.pow(OFFICE_MULT, toSize / 3) - Math.pow(OFFICE_MULT, fromSize / 3))) / (OFFICE_MULT - 1);
}

/** Highest office size (a multiple of 3) reachable with `budget`. **/
export function maxAffordableOfficeSize(fromSize, budget) {
  return Math.max(
    fromSize,
    Math.floor((3 * Math.log((budget * (OFFICE_MULT - 1)) / OFFICE_BASE + Math.pow(OFFICE_MULT, fromSize / 3))) / Math.log(OFFICE_MULT)),
  );
}

/** Advert cost, base 1e9 / mult 1.06 (§13.2 — the guide's "109" is a lost superscript). **/
export function advertCost(fromLevel, toLevel) {
  return (ADVERT_BASE * (Math.pow(ADVERT_MULT, toLevel) - Math.pow(ADVERT_MULT, fromLevel))) / (ADVERT_MULT - 1);
}

/** Highest Advert level reachable with `budget`. **/
export function maxAffordableAdvertLevel(fromLevel, budget) {
  return Math.max(fromLevel, Math.floor(Math.log((budget * (ADVERT_MULT - 1)) / ADVERT_BASE + Math.pow(ADVERT_MULT, fromLevel)) / Math.log(ADVERT_MULT)));
}

/** §16.2.1 AdvertFactor = ((awareness+1)^f * (popularity+1)^f * ratio)^0.85 **/
export function advertFactorOf(awareness, popularity, advertisingFactor) {
  const ratio = awareness === 0 ? 0.01 : Math.max(0.01, (popularity + 0.001) / awareness);
  return Math.pow(Math.pow(awareness + 1, advertisingFactor) * Math.pow(popularity + 1, advertisingFactor) * ratio, 0.85);
}

/** Simulate `advertLevel` bought adverts on top of `wilsonLevel`.
 * The guide's Random(1,3)/200 popularity term is random here; its mean 2/200 is used, which reproduces
 * the guide's §13.4 tables. `cost` is the advert spend from level 0 (Wilson is not included).
 * @returns {{awareness: number, popularity: number, ratio: number, advertFactor: number, cost: number}} **/
export function advertSim(wilsonLevel, advertLevel, advertisingFactor, researchAdvertMult = 1) {
  const m = (1 + 0.005 * wilsonLevel) * researchAdvertMult;
  let awareness = 0;
  let popularity = 0;
  for (let i = 0; i < advertLevel; i++) {
    awareness = (awareness + 3 * m) * (1.005 * m);
    popularity = (popularity + m) * 1.01 * m;
  }
  const ratio = awareness === 0 ? 0.01 : Math.max(0.01, (popularity + 0.001) / awareness);
  return { awareness, popularity, ratio, advertFactor: advertFactorOf(awareness, popularity, advertisingFactor), cost: advertCost(0, advertLevel) };
}

/** Brute-force best (Wilson, Advert) pair for a budget (§13.4). Walks levels upward and stops as soon as
 * the cost passes the budget, so the searched space stays tiny at realistic budgets. **/
export function bestWilsonAdvert(budget, wilsonFrom, advertFrom, advertisingFactor, { maxWilson = 1000, maxAdvert = 4000 } = {}) {
  let best = { wilson: wilsonFrom, advert: advertFrom, cost: 0, advertFactor: advertSim(wilsonFrom, advertFrom, advertisingFactor).advertFactor };
  for (let w = wilsonFrom; w <= maxWilson; w++) {
    const wilsonCost = upgradeCost(WILSON_BASE, WILSON_MULT, wilsonFrom, w);
    if (wilsonCost > budget) break;
    const m = 1 + 0.005 * w;
    let awareness = 0;
    let popularity = 0;
    for (let a = 0; a <= maxAdvert; a++) {
      if (a > 0) {
        awareness = (awareness + 3 * m) * (1.005 * m);
        popularity = (popularity + m) * 1.01 * m;
      }
      if (a < advertFrom) continue;
      const cost = wilsonCost + advertCost(advertFrom, a);
      if (cost > budget) break;
      const advertFactor = advertFactorOf(awareness, popularity, advertisingFactor);
      if (advertFactor > best.advertFactor) best = { wilson: w, advert: a, cost, advertFactor };
    }
  }
  return best;
}

/** Optimal selling price (§16.3): MarkupLimit*sqrt(PotentialSalesVolume)/sqrt(stored/10) + MarketPrice.
 * Returns 0 when the expected sales volume is degenerate (stored is a tiny number, not exactly 0). **/
export function optimalSellingPrice({ markupLimit, marketPrice, potentialSalesVolume, stored }) {
  const expectedSalesVolume = stored / 10;
  if (expectedSalesVolume < 1e-5) return 0;
  return (markupLimit * Math.sqrt(potentialSalesVolume)) / Math.sqrt(expectedSalesVolume) + marketPrice;
}

/** Brute-force best (SmartStorage, Warehouse, SmartFactories) for a budget (§9.2). Warehouse cost is per city,
 * production uses the warehouse space left for boost materials. Returns null only if nothing is affordable. **/
export function bestStorageFactoryWarehouse(
  budget,
  { ssFrom, sfFrom, whFrom, factors, matRatio, researchStorageMult = 1, maxSS = 70, maxSF = 70, maxWH = 50, cities = 6 },
) {
  let best = null;
  for (let ss = ssFrom; ss <= maxSS; ss++) {
    const ssCost = upgradeCost(SMART_BASE, SMART_MULT, ssFrom, ss);
    if (ssCost > budget) break;
    for (let sf = sfFrom; sf <= maxSF; sf++) {
      const ssSfCost = ssCost + upgradeCost(SMART_BASE, SMART_MULT, sfFrom, sf);
      if (ssSfCost > budget) break;
      for (let wh = whFrom; wh <= maxWH; wh++) {
        const cost = ssSfCost + cities * warehouseUpgradeCost(whFrom, wh);
        if (cost > budget) break;
        const space = warehouseSize(wh, ss, researchStorageMult) * matRatio;
        const qty = optimalBoostMaterials(factors, space);
        const production = productionMultiplier(factors, qty, cities) * (1 + 0.03 * sf);
        if (best === null || production > best.production) best = { smartStorage: ss, warehouse: wh, smartFactories: sf, cost, production };
      }
    }
  }
  return best;
}

/** Raw production of one office (§9.1.1). 0 when the office produces nothing at all. **/
export function divisionRawProduction({
  isProduct,
  operationsProd,
  engineerProd,
  managementProd,
  divisionProductionMult,
  smartFactoriesLevel,
  productionResearchMult = 1,
}) {
  const total = operationsProd + engineerProd + managementProd;
  if (total <= 0) return 0;
  const managementFactor = 1 + managementProd / (1.2 * total);
  const empMult = (Math.pow(operationsProd, 0.4) + Math.pow(engineerProd, 0.3)) * managementFactor;
  const officeMult = (isProduct ? 0.5 : 1) * 0.05 * empMult;
  return officeMult * divisionProductionMult * (1 + 0.03 * smartFactoriesLevel) * productionResearchMult;
}

/** Turn job ratios into integer counts summing to `size`, largest remainder first. **/
export function ratiosToCounts(ratios, size) {
  const exact = ratios.map((r) => r * size);
  const counts = exact.map(Math.floor);
  let left = Math.round(size - counts.reduce((a, b) => a + b, 0));
  const order = exact.map((e, i) => [e - counts[i], i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0; k++, left--) counts[order[k % order.length][1]]++;
  return counts;
}

/** Product id out of a generated name: "Ebon Stick-16" (current scheme) or the older
 * "Ebon Stick-00016-1.00000e+9" written before 2026-11-08 - the products already in the game still number
 * themselves with it. NaN when the name carries no id. **/
export function parseProductId(name) {
  const match = /-(\d{5})-/.exec(name) ?? /-(\d+)$/.exec(name);
  return match === null ? NaN : parseInt(match[1], 10);
}

/** Name for the next product of a division: "<division>-<n>". The number continues past every product the
 * division already has, whatever scheme named it, so a generated name can never collide with an existing one. **/
export function nextProductName(existingNames, divisionName) {
  let maxId = -1;
  for (const name of existingNames) {
    const id = parseProductId(name);
    if (Number.isFinite(id) && id > maxId) maxId = id;
  }
  return `${divisionName}-${maxId + 1}`;
}

/** How many products the phase may still create, by investment round (maxNumberOfProductsInRound3/4). **/
export function allowedProductCeiling(offerRound) {
  if (offerRound <= 2) return 0;
  if (offerRound === 3) return 1;
  if (offerRound === 4) return 2;
  return Infinity;
}

/** PotentialSalesVolume (§16.2.1): itemMultiplier * businessFactor * advertFactor * marketFactor
 * * SalesBots bonus * research bonus. `businessProduction` is the raw Business employee production. **/
export function potentialSalesVolume({
  itemMultiplier,
  businessProduction,
  awareness,
  popularity,
  advertisingFactor,
  demand,
  competition,
  salesBotsLevel,
  researchSalesMult = 1,
}) {
  const business = 1 + businessProduction;
  const businessFactor = Math.pow(business, 0.26) + business / 10000;
  const marketFactor = Math.max(0.1, (demand * (100 - competition)) / 100);
  return itemMultiplier * businessFactor * advertFactorOf(awareness, popularity, advertisingFactor) * marketFactor * (1 + 0.01 * salesBotsLevel) * researchSalesMult;
}

/** MarkupLimit back-solved from one measured sale (§16.3): (price - MarketPrice) * sqrt(sold / PotentialSalesVolume). **/
export function markupLimitFromMeasurement({ price, marketPrice, actualSellAmount, potentialSalesVolume }) {
  return (price - marketPrice) * Math.sqrt(actualSellAmount / potentialSalesVolume);
}

function near(actual, expected, tol, label) {
  if (!(Math.abs(actual - expected) <= tol)) throw new Error(`${label}: expected ${expected}, got ${actual} (tol ${tol})`);
}

function nearArr(actual, expected, tol, label) {
  if (actual.length !== expected.length) throw new Error(`${label}: length ${actual.length} != ${expected.length}`);
  actual.forEach((v, i) => near(v, expected[i], tol, `${label}[${i}]`));
}

/** Golden-number self-check (guide-printed numbers, §18/§19 and §9.2/§13.4 tables). Throws on the first failure. **/
export function selfCheck() {
  const agri = [0.3, 0.2, 0.72, 0.3];
  const chem = [0.2, 0.2, 0.25, 0.25];

  nearArr(optimalBoostMaterials(agri, 5250), [10518.09, 11742.32, 528368.42, 1703.62], 0.5, "boost agri 5250");
  nearArr(optimalBoostMaterials(agri, 4522), [9081, 10146, 459400, 1416], 1, "boost agri 4522");
  nearArr(optimalBoostMaterials(chem, 665), [1717, 3194, 54917, 54], 1, "boost chem 665");
  nearArr(optimalBoostMaterials(agri, 756.01), [1562, 1791, 98470, 0], 3, "boost agri 756.01");
  nearArr(optimalBoostMaterials(agri, 436.81), [777, 919, 60794, 0], 3, "boost agri 436.81");

  near(productionMultiplier(agri, [8446, 9440, 428895, 1289], 6), 804.175, 0.01, "productionMultiplier");

  near(warehouseSize(15, 25), 5250, 1e-9, "warehouseSize 15/25");
  near(warehouseSize(17, 25), 5950, 1e-9, "warehouseSize 17/25");
  near(warehouseSize(2, 25), 700, 1e-9, "warehouseSize 2/25");
  near(warehouseSize(4, 3), 520, 1e-9, "warehouseSize 4/3");
  near(warehouseSize(5, 8), 900, 1e-9, "warehouseSize 5/8");

  near(advertCost(0, 1), 1e9, 1, "advertCost 0->1");
  near(advertCost(0, 2), 2.06e9, 1e4, "advertCost 0->2");
  near(advertCost(0, 8), 9.897e9, 1e6, "advertCost 0->8");

  near(upgradeCost(SMART_BASE, SMART_MULT, 0, 25), 109.729e9, 1.09729e8, "SmartStorage 0->25");
  near(upgradeCost(SMART_BASE, SMART_MULT, 0, 16), 51.345e9, 5.1345e7, "SmartFactories 0->16");
  near(warehouseUpgradeCost(1, 15), 25.818e9, 2.5818e7, "warehouse 1->15");
  near(officeUpgradeCost(3, 4), 1.4118e9, 1.4118e6, "office 3->4");
  near(officeUpgradeCost(4, 8), 6.0708e9, 6.0708e6, "office 4->8");

  const sim1 = advertSim(0, 1, 0.04);
  near(sim1.awareness, 3.015, 0.01, "advertSim(0,1) awareness");
  near(sim1.popularity, 1.01, 0.01, "advertSim(0,1) popularity");
  near(sim1.advertFactor, 0.424, 0.002, "advertSim(0,1) factor");
  const sim2 = advertSim(1, 11, 0.04);
  near(sim2.advertFactor, 0.497, 0.002, "advertSim(1,11) factor");
  near(sim2.popularity, 12.105, 0.01, "advertSim(1,11) popularity");

  const wa = bestWilsonAdvert(9.9e9, 0, 0, 0.04);
  if (wa.wilson !== 0 || wa.advert !== 8) throw new Error(`bestWilsonAdvert 9.9e9: got wilson ${wa.wilson}, advert ${wa.advert}`);

  const sfw = bestStorageFactoryWarehouse(322.402e9 * 1.0005, { ssFrom: 0, sfFrom: 0, whFrom: 0, factors: agri, matRatio: 0.8 });
  if (sfw.smartStorage !== 25 || sfw.warehouse !== 15 || sfw.smartFactories !== 16)
    throw new Error(`bestStorageFactoryWarehouse round1: got ${JSON.stringify(sfw)}`);
  near(sfw.production, 1190.2, 0.5, "bestStorageFactoryWarehouse round1 production");
  const sfw2 = bestStorageFactoryWarehouse(303.314e9 * 1.001, { ssFrom: 8, sfFrom: 2, whFrom: 5, factors: agri, matRatio: 0.76 });
  if (sfw2.smartStorage !== 25 || sfw2.warehouse !== 17 || sfw2.smartFactories !== 17)
    throw new Error(`bestStorageFactoryWarehouse round2: got ${JSON.stringify(sfw2)}`);

  const raw = { isProduct: false, operationsProd: 100, engineerProd: 100, managementProd: 0, divisionProductionMult: 1, smartFactoriesLevel: 0 };
  near(divisionRawProduction(raw), 0.514532, 1e-5, "divisionRawProduction plain");
  near(divisionRawProduction({ ...raw, managementProd: 50 }), 0.600288, 1e-5, "divisionRawProduction mgmt");
  near(
    divisionRawProduction({ isProduct: true, operationsProd: 100, engineerProd: 100, managementProd: 50, divisionProductionMult: 2, smartFactoriesLevel: 10 }),
    0.780374,
    1e-5,
    "divisionRawProduction product",
  );

  nearArr(ratiosToCounts([0.037, 0.513, 0.011, 0.44], 30), [1, 16, 0, 13], 0, "ratiosToCounts a");
  nearArr(ratiosToCounts([49 / 138, 5 / 138, 51 / 138, 33 / 138], 138), [49, 5, 51, 33], 0, "ratiosToCounts b");
  nearArr(ratiosToCounts([0.22, 0.632, 0, 0.148], 16), [4, 10, 0, 2], 0, "ratiosToCounts c");
  for (const [ratios, size] of [
    [[0.037, 0.513, 0.011, 0.44], 30],
    [[0.22, 0.632, 0, 0.148], 16],
  ]) {
    const sum = ratiosToCounts(ratios, size).reduce((a, b) => a + b, 0);
    if (sum !== size) throw new Error(`ratiosToCounts does not sum to ${size}: ${sum}`);
  }

  if (nextProductName([], "Ebon Stick") !== "Ebon Stick-0") throw new Error("nextProductName first");
  const existing = ["Ebon Stick-0", "Ebon Stick-1"];
  if (nextProductName(existing, "Ebon Stick") !== "Ebon Stick-2") throw new Error("nextProductName next");
  // Both name schemes number the same way, so the products already in the game keep the sequence going. The
  // legacy pattern must win: the budget's "e+23" also ends in digits and would otherwise read as id 23.
  if (parseProductId("Ebon Stick-16") !== 16 || parseProductId("Ebon Stick-00015-4.60069e+23") !== 15)
    throw new Error("parseProductId reads both schemes");
  if (parseProductId("BIG CIG") === parseProductId("BIG CIG")) throw new Error("parseProductId should be NaN");
  if (allowedProductCeiling(3) !== 1 || allowedProductCeiling(4) !== 2 || allowedProductCeiling(5) !== Infinity) throw new Error("allowedProductCeiling");

  near(optimalSellingPrice({ markupLimit: 100, marketPrice: 1000, potentialSalesVolume: 1e6, stored: 1e4 }), 1000 + (100 * Math.sqrt(1e6)) / Math.sqrt(1e3), 1e-5, "optimalSellingPrice");
  if (optimalSellingPrice({ markupLimit: 100, marketPrice: 1000, potentialSalesVolume: 1e6, stored: 1e-6 }) !== 0) throw new Error("optimalSellingPrice tiny stored");
  const price = 1e9;
  const psv = 4e6;
  const sold = psv * Math.pow(250 / (price - 1000), 2);
  near(markupLimitFromMeasurement({ price, marketPrice: 1000, actualSellAmount: sold, potentialSalesVolume: psv }), 250, 2.5e-7, "markupLimitFromMeasurement");
  // potentialSalesVolume is only exercised for shape: no guide-printed value exists for it.
  const psvCheck = potentialSalesVolume({
    itemMultiplier: 1,
    businessProduction: 0,
    awareness: 0,
    popularity: 0,
    advertisingFactor: 0.04,
    demand: 100,
    competition: 0,
    salesBotsLevel: 0,
  });
  near(psvCheck, 100 * 1.0001 * Math.pow(0.01, 0.85), 1e-9, "potentialSalesVolume neutral");

  return true;
}
