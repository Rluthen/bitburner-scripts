import { log, getConfiguration, getActiveSourceFiles, instanceCount } from "./helpers.js";
let options;
// These parameters are meant to let you tweak the script's behaviour from the command line (without altering source code)
const argsSchema = [
  ["product-city", "Sector-12"],
  ["mat-ratio", 0.8], // default % of warehouses filled with bonus material
];
const CORPORATION_NAME = "Erebos"; // change if you like
const AGRI_NAME = "Dark Soil";
const CHEM_NAME = "Black Salt";
const TOB_NAME = "Ebon Stick";
let playerCorp;
export function autocomplete(data, _) {
  data.flags(argsSchema);
  return [];
}
// script entry point
/** @param {NS} ns **/
export async function main(ns) {
  const runOptions = getConfiguration(ns, argsSchema);
  if (!runOptions || (await instanceCount(ns)) > 1) return;
  options = runOptions; // We don't set the global "options" until we're sure this is the only running instance
  let ownedSourceFiles = await getActiveSourceFiles(ns);
  const sf3Level = ownedSourceFiles[3] || 0;
  if (sf3Level == 0) return log(ns, "ERROR: You have no yet unlocked corps. Script should not be run...");
  //we get an array of city names to compare for later
  const cities = Object.values(ns.enums.CityName);
  ns.ui.openTail();
  ns.disableLog("ALL");
  if (ns.corporation.hasCorporation()) playerCorp = ns.corporation.getCorporation();
  // Initial Agriculture corp is needed
  if (!ns.corporation.hasCorporation()) {
    log(ns, "Entering Agriculture setup");
    await makeNewCorp(ns);
    log(ns, "Successfully created corp and got first investing round");
  } else if (playerCorp.divisions.length == 0) {
    log(ns, "Entering Agriculture setup");
    await makeNewCorp(ns);
    log(ns, "Successfully created corp and got first investing round");
  } else {
    ns.print("Skipping Agriculture setup");
  }
  playerCorp = ns.corporation.getCorporation();
  if (playerCorp.divisions.length == 1) {
    log(ns, "Entering Chemical & round 2 setup");
    await expandToChem(ns);
    log(ns, "Successfully expanded corp and got chem division running");
  } else {
    ns.print("Skipping Chemical setup");
  }
  playerCorp = ns.corporation.getCorporation();
  if (playerCorp.divisions.length == 2) {
    log(ns, "Entering Tobacco setup");
    await expandTobacco(ns);
    log(ns, "Successfully expanded corp and got third investing round");
  } else {
    ns.print("Skipping Tobacco setup");
  }
  log(ns, "Keeping happy");
  playerCorp = ns.corporation.getCorporation();
  do {
    for (const divName of playerCorp.divisions) {
      let done = true;
      do {
        done = true;
        for (const city of cities) {
          const { avgEnergy, avgMorale } = ns.corporation.getOffice(divName, city);
          if (avgEnergy < 99) ns.corporation.buyTea(divName, city);
          if (avgMorale < 99.5) ns.corporation.throwParty(divName, city, avgMorale > 99 ? 1e5 : 1e6);
          if (avgEnergy < 99 || avgMorale < 99) done = false;
        }
        if (!done) await waitState(ns, "START", true);
      } while (!done);
    }
    await waitState(ns, "START", true);
  } while (true);
}
/** @param {import("..").NS} ns */
export async function makeNewCorp(ns) {
  //if we dont already have a corp we start one
  ns.print("Prepping the Corp");
  if (!ns.corporation.hasCorporation()) {
    if (!ns.corporation.createCorporation(CORPORATION_NAME, false)) {
      ns.print("This script is made for BN3 only");
      ns.exit();
    }
  } else if (ns.corporation.getCorporation().funds !== 150e9) {
    ns.tprint("this script is meant to be run on a fresh corp pls sell your ceo position and rerun this script");
    ns.exit();
  }
  //base expand and unlock buys
  ns.corporation.expandIndustry("Agriculture", AGRI_NAME);
  ns.corporation.purchaseUnlock("Smart Supply");
  ns.corporation.hireAdVert(AGRI_NAME);
  ns.corporation.hireAdVert(AGRI_NAME);
  while (ns.corporation.getUpgradeLevel("Smart Storage") < 3) ns.corporation.levelUpgrade("Smart Storage");
  //expand to cities and buy warehouse and hire employees
  const cities = Object.values(ns.enums.CityName);
  for (const city of cities) {
    if (!ns.corporation.getDivision(AGRI_NAME).cities.includes(city)) ns.corporation.expandCity(AGRI_NAME, city);
    if (!ns.corporation.hasWarehouse(AGRI_NAME, city)) ns.corporation.purchaseWarehouse(AGRI_NAME, city);
    while (ns.corporation.hireEmployee(AGRI_NAME, city, "Research & Development")) {}
    while (ns.corporation.getWarehouse(AGRI_NAME, city).level < 5) ns.corporation.upgradeWarehouse(AGRI_NAME, city);
    ns.corporation.setSmartSupply(AGRI_NAME, city, true);
  }
  ns.print("Prep Done. Now we make them Happy");
  //make them energetic and raise the morale
  let done = true;
  do {
    done = true;
    for (const city of cities) {
      const { avgEnergy, avgMorale } = ns.corporation.getOffice(AGRI_NAME, city);
      if (avgEnergy < 99) ns.corporation.buyTea(AGRI_NAME, city);
      if (avgMorale < 99.5) ns.corporation.throwParty(AGRI_NAME, city, avgMorale > 99 ? 1e5 : 1e6);
      if (avgEnergy < 99 || avgMorale < 99) done = false;
    }
    if (!done) await waitState(ns, "START", true);
  } while (!done);
  ns.print("Everyone is happy. Now lets get to work");
  //we set the buys here
  for (const city of cities) {
    ns.corporation.buyMaterial(AGRI_NAME, city, "AI Cores", 108);
    ns.corporation.buyMaterial(AGRI_NAME, city, "Hardware", 120.1);
    ns.corporation.buyMaterial(AGRI_NAME, city, "Real Estate", 7438.8);
    ns.corporation.setJobAssignment(AGRI_NAME, city, "Research & Development", 0);
    ns.corporation.setJobAssignment(AGRI_NAME, city, "Engineer", 1);
    ns.corporation.setJobAssignment(AGRI_NAME, city, "Operations", 1);
    ns.corporation.setJobAssignment(AGRI_NAME, city, "Business", 1);
  }
  await waitState(ns, "SALE");
  //after we have bought the stuff we clear the buys and set the sells
  for (const city of cities) {
    ns.corporation.buyMaterial(AGRI_NAME, city, "AI Cores", 0);
    ns.corporation.buyMaterial(AGRI_NAME, city, "Hardware", 0);
    ns.corporation.buyMaterial(AGRI_NAME, city, "Real Estate", 0);
    ns.corporation.sellMaterial(AGRI_NAME, city, "Plants", "MAX", "MP");
    ns.corporation.sellMaterial(AGRI_NAME, city, "Food", "MAX", "MP");
  }
  ns.print("Just waiting until the Offers are nice will take a few Cycles.");
  //we wait 12 because we need to wait two cycle to get the jobs set and smart supply to register production then 10 rounds of producing and selling until the peak
  for (let i = 0; i < 12; i++) {
    await waitState(ns, "START", true);
    ns.print(`${i} offer of ${ns.format.number(ns.corporation.getInvestmentOffer().funds, 0, 1e9)}`);
  }
  ns.print(`Accepting offer of ${ns.format.number(ns.corporation.getInvestmentOffer().funds, 0, 1e9)}`);
  ns.corporation.acceptInvestmentOffer();
}
/** @param {import("..").NS} ns */
export async function expandToChem(ns) {
  const cities = Object.values(ns.enums.CityName);
  ns.corporation.expandIndustry("Chemical", CHEM_NAME);
  ns.corporation.purchaseUnlock("Export");
  ns.corporation.hireAdVert(CHEM_NAME);
  ns.corporation.hireAdVert(CHEM_NAME);
  ns.print("Created Chem division");
  for (const city of cities) {
    // CHEM
    if (!ns.corporation.getDivision(CHEM_NAME).cities.includes(city)) ns.corporation.expandCity(CHEM_NAME, city);
    if (!ns.corporation.hasWarehouse(CHEM_NAME, city)) ns.corporation.purchaseWarehouse(CHEM_NAME, city);
    while (ns.corporation.getWarehouse(CHEM_NAME, city).level < 5) ns.corporation.upgradeWarehouse(CHEM_NAME, city);
    ns.corporation.setSmartSupply(CHEM_NAME, city, true);
    ns.corporation.upgradeOfficeSize(CHEM_NAME, city, 37);
    while (ns.corporation.hireEmployee(CHEM_NAME, city)) {}
    // AGRI
    ns.corporation.upgradeOfficeSize(AGRI_NAME, city, 27);
    while (ns.corporation.hireEmployee(AGRI_NAME, city)) {}
  }
  ns.print("Scaled workers. Now we make them Happy");
  let done = true;
  do {
    done = true;
    for (const city of cities) {
      const { avgEnergy, avgMorale } = ns.corporation.getOffice(CHEM_NAME, city);
      if (avgEnergy < 99) ns.corporation.buyTea(CHEM_NAME, city);
      if (avgMorale < 99.5) ns.corporation.throwParty(CHEM_NAME, city, avgMorale > 99 ? 1e5 : 1e6);
      if (avgEnergy < 99 || avgMorale < 99) done = false;
    }
    if (!done) await waitState(ns, "START", true);
  } while (!done);
  ns.print("Everyone is happy. Now lets get to work");
  //we set the buys here
  let warehouse = ns.corporation.getWarehouse(CHEM_NAME, "Aevum");
  let capacity = warehouse.size;
  let mats = doMaterials(ns, "Chemical", capacity * options["mat-ratio"]);
  for (const city of cities) {
    ns.corporation.buyMaterial(CHEM_NAME, city, "AI Cores", mats["AI Cores"] / 10);
    ns.corporation.buyMaterial(CHEM_NAME, city, "Hardware", mats["Hardware"] / 10);
    ns.corporation.buyMaterial(CHEM_NAME, city, "Real Estate", mats["Real Estate"] / 10);
    ns.corporation.buyMaterial(CHEM_NAME, city, "Robots", mats["Robots"] / 10);
    ns.corporation.setJobAssignment(CHEM_NAME, city, "Research & Development", 0);
    ns.corporation.setJobAssignment(CHEM_NAME, city, "Engineer", 1);
    ns.corporation.setJobAssignment(CHEM_NAME, city, "Operations", 1);
    ns.corporation.setJobAssignment(CHEM_NAME, city, "Business", 1);
  }
  await waitState(ns, "SALE");
  //after we have bought the stuff we clear the buys and set the sells
  for (const city of cities) {
    ns.corporation.buyMaterial(CHEM_NAME, city, "AI Cores", 0);
    ns.corporation.buyMaterial(CHEM_NAME, city, "Hardware", 0);
    ns.corporation.buyMaterial(CHEM_NAME, city, "Real Estate", 0);
    ns.corporation.buyMaterial(CHEM_NAME, city, "Robots", 0);
    ns.corporation.sellMaterial(CHEM_NAME, city, "Chemicals", "MAX", "MP");
  }
  //After selling we set the export routes CHEM <-> AGRE
  for (const city of cities) {
    ns.corporation.exportMaterial(CHEM_NAME, city, AGRI_NAME, city, "Chemicals", "(IPROD+IINV/10)*(-1)");
    ns.corporation.exportMaterial(AGRI_NAME, city, CHEM_NAME, city, "Plants", "(IPROD+IINV/10)*(-1)");
  }
  ns.print("Just waiting until the Offers are nice will take a few Cycles.");
  //we wait 12 because we need to wait two cycle to get the jobs set and smart supply to register production then 10 rounds of producing and selling until the peak
  for (let i = 0; i < 12; i++) {
    await waitState(ns, "START", true);
    ns.print(`${i} offer of ${ns.format.number(ns.corporation.getInvestmentOffer().funds, 0, 1e9)}`);
  }
  ns.print(`Accepting offer of ${ns.format.number(ns.corporation.getInvestmentOffer().funds, 0, 1e9)}`);
  ns.corporation.acceptInvestmentOffer();
}
/** @param {import("..").NS} ns */
export async function expandTobacco(ns) {
  //base expand and unlock buys
  ns.corporation.expandIndustry("Tobacco", TOB_NAME);
  ns.corporation.hireAdVert(TOB_NAME);
  ns.corporation.hireAdVert(TOB_NAME);
  //expand to cities and buy warehouse and hire employees
  const cities = Object.values(ns.enums.CityName);
  for (const city of cities) {
    if (!ns.corporation.getDivision(TOB_NAME).cities.includes(city)) ns.corporation.expandCity(TOB_NAME, city);
    if (!ns.corporation.hasWarehouse(TOB_NAME, city)) ns.corporation.purchaseWarehouse(TOB_NAME, city);
    while (ns.corporation.hireEmployee(TOB_NAME, city, "Research & Development")) {}
    while (ns.corporation.getWarehouse(TOB_NAME, city).level < 5) ns.corporation.upgradeWarehouse(TOB_NAME, city);
    ns.corporation.setSmartSupply(TOB_NAME, city, true);
  }
  ns.print("Prep Done. Now we make them Happy");
  //make them energetic and raise the morale
  let done = true;
  do {
    done = true;
    for (const city of cities) {
      const { avgEnergy, avgMorale } = ns.corporation.getOffice(TOB_NAME, city);
      if (avgEnergy < 99) ns.corporation.buyTea(TOB_NAME, city);
      if (avgMorale < 99.5) ns.corporation.throwParty(TOB_NAME, city, avgMorale > 99 ? 1e5 : 1e6);
      if (avgEnergy < 99 || avgMorale < 99) done = false;
    }
    if (!done) await waitState(ns, "START", true);
  } while (!done);
  ns.print("Everyone is happy. Now lets get to work");
  let warehouse = ns.corporation.getWarehouse(TOB_NAME, "Aevum");
  let capacity = warehouse.size;
  let mats = doMaterials(ns, "Tobacco", capacity * options["mat-ratio"]);
  for (const city of cities) {
    ns.corporation.buyMaterial(TOB_NAME, city, "AI Cores", mats["AI Cores"] / 10);
    ns.corporation.buyMaterial(TOB_NAME, city, "Hardware", mats["Hardware"] / 10);
    ns.corporation.buyMaterial(TOB_NAME, city, "Real Estate", mats["Real Estate"] / 10);
    ns.corporation.buyMaterial(TOB_NAME, city, "Robots", mats["Robots"] / 10);
    ns.corporation.setJobAssignment(TOB_NAME, city, "Research & Development", 0);
    ns.corporation.setJobAssignment(TOB_NAME, city, "Engineer", 1);
    ns.corporation.setJobAssignment(TOB_NAME, city, "Operations", 1);
    ns.corporation.setJobAssignment(TOB_NAME, city, "Business", 1);
  }
  await waitState(ns, "SALE");
  //after we have bought the stuff we clear the buys and set the sells
  for (const city of cities) {
    ns.corporation.buyMaterial(TOB_NAME, city, "AI Cores", 0);
    ns.corporation.buyMaterial(TOB_NAME, city, "Hardware", 0);
    ns.corporation.buyMaterial(TOB_NAME, city, "Real Estate", 0);
    ns.corporation.buyMaterial(TOB_NAME, city, "Robots", 0);
  }
  //after we have bought the stuff we clear the buys
  for (const city of cities) {
    ns.corporation.buyMaterial(TOB_NAME, city, "AI Cores", 0);
    ns.corporation.buyMaterial(TOB_NAME, city, "Hardware", 0);
    ns.corporation.buyMaterial(TOB_NAME, city, "Real Estate", 0);
    ns.corporation.buyMaterial(TOB_NAME, city, "Robots", 0);
  }
  //After selling we set the export routes AGRI -> TOB
  for (const city of cities) {
    ns.corporation.exportMaterial(AGRI_NAME, city, TOB_NAME, city, "Plants", "(IPROD+IINV/10)*(-1)");
  }
  ns.print("Setup materials");
  for (const city of cities) {
    if (city == options["product-city"]) {
      ns.corporation.upgradeOfficeSize(TOB_NAME, city, 27);
      while (ns.corporation.hireEmployee(TOB_NAME, city)) {}
      ns.corporation.setJobAssignment(TOB_NAME, city, "Operations", 2);
      ns.corporation.setJobAssignment(TOB_NAME, city, "Engineer", 9);
      ns.corporation.setJobAssignment(TOB_NAME, city, "Business", 2);
      ns.corporation.setJobAssignment(TOB_NAME, city, "Management", 17);
    } else {
      ns.corporation.upgradeOfficeSize(TOB_NAME, city, 12);
      ns.corporation.hireEmployee(TOB_NAME, city, "Business");
      ns.corporation.hireEmployee(TOB_NAME, city, "Operations");
      while (ns.corporation.hireEmployee(TOB_NAME, city, "Research & Development")) {}
    }
  }
  ns.print("Hired employees");
  ns.corporation.makeProduct(
    TOB_NAME,
    options["product-city"],
    "BIG CIG",
    playerCorp.funds * 0.01,
    playerCorp.funds * 0.01,
  );
  ns.print("Made first BIG CIG");
}
export async function waitState(ns, state, onpoint = false) {
  while (ns.corporation.getCorporation().nextState !== state) await ns.asleep(100);
  if (onpoint) while (ns.corporation.getCorporation().nextState == state) await ns.asleep(100);
}
export function optimizeCorpoMaterials_raw(weights, factors, spaceConstraint, round = true) {
  var [w1, w2, w3, w4] = weights;
  var [p1, p2, p3, p4] = factors;
  var m1 =
    spaceConstraint / (w1 + (w2 * p2 * w1) / (w2 * p1) + (w3 * p3 * w1) / (w3 * p1) + (w4 * p4 * w1) / (w4 * p1));
  var m2 =
    spaceConstraint / (w2 + (w1 * p1 * w2) / (w1 * p2) + (w3 * p3 * w2) / (w3 * p2) + (w4 * p4 * w2) / (w4 * p2));
  var m3 =
    spaceConstraint / (w3 + (w1 * p1 * w3) / (w1 * p3) + (w2 * p2 * w3) / (w2 * p3) + (w4 * p4 * w3) / (w4 * p3));
  var m4 =
    spaceConstraint / (w4 + (w1 * p1 * w4) / (w1 * p4) + (w2 * p2 * w4) / (w2 * p4) + (w3 * p3 * w4) / (w3 * p4));
  if (round) {
    m1 = Math.round(m1);
    m2 = Math.round(m2);
    m3 = Math.round(m3);
    m4 = Math.round(m4);
  }
  return [m1, m2, m3, m4];
}
/** @param {NS} ns */
export function doMaterials(ns, industryName, maxWarehouseSpaceForMaterials) {
  var cor = ns.corporation;
  var hmd = cor.getMaterialData("Hardware");
  var amd = cor.getMaterialData("AI Cores");
  var remd = cor.getMaterialData("Real Estate");
  var rmd = cor.getMaterialData("Robots");
  var weights = [hmd.size, amd.size, remd.size, rmd.size];
  var id = cor.getIndustryData(industryName);
  var factors = [id.hardwareFactor, id.aiCoreFactor, id.realEstateFactor, id.robotFactor];
  const optimum = optimizeCorpoMaterials_raw(weights, factors, maxWarehouseSpaceForMaterials);
  const targetNums = { Hardware: optimum[0], "AI Cores": optimum[1], "Real Estate": optimum[2], Robots: optimum[3] };
  return targetNums;
}
