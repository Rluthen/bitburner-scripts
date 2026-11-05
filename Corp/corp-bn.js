/** T08 — BitNode profile: answers "is the corporation up to par for the BitNode we are in?".
 * Runs ONCE (the daemon launches it at startup), writes BN_FILE (/Temp/corp-bn.txt) and exits.
 *
 * NS functions used directly, with the RAM line from the official docs (dev branch):
 *   ns.getResetInfo()                             1 GB  -> { currentNode, ownedSF }
 *   ns.getBitNodeMultipliers()                    4 GB  (throws unless BN5 or SF5 - handled, see main)
 *   ns.corporation.canCreateCorporation(selfFund) 0 GB  (works without corporation API access)
 *   ns.corporation.hasCorporation()               0 GB
 *   ns.write(file, data, "w")                     0 GB
 *   ns.tprint / ns.print                          0 GB
 *   ns.getScriptName / ns.getPortHandle(..).write 0 GB  (inside corpLog)
 * Imported modules charge their own union of distinct ns functions:
 *   ./corp-lib.js  ~1.4 GB docs (ns.run 1, ns.getScriptRam 0.1, ns.isRunning 0.1, ns.getServerMaxRam 0.05,
 *                  ns.getServerUsedRam 0.05, rest 0 GB: fileExists/sleep/getScriptName/print/getPortHandle)
 *   ../helpers.js  ~16.4 GB docs (biggest: ns.singularity.getOwnedSourceFiles 5, ns.getBitNodeMultipliers 4,
 *                  ns.getServer 2, ns.stock.getSymbols 2, ns.exec 1.3, ns.getResetInfo 1, ns.run 1, ...)
 *   => docs sum ~18 GB. Measure in-game with `mem Corp/corp-bn.js` — this is a docs figure, not a measurement.
 *
 * Deliberately NOT using helpers' `tryGetBitNodeMultipliers`: it fetches multipliers through
 * getNsDataThroughFile, i.e. a generated temp script run with ns.run and waited on in
 * waitForProcessToComplete (up to 1000 retries, ~3 minutes) whenever that temp script cannot run. The
 * daemon WAITS for this script during startup, so a slow fetch here looks like a dead daemon. The direct
 * call below costs 4 GB and returns instantly; the fallback is the same hard-coded table helpers uses.
 *
 * Sources: official `dev` docs; game source `dev/src/Corporation/helpers.ts` (canCreateCorporation) and
 * `dev/src/NetscriptFunctions/Corporation.ts` (the wrapper passes restart=false and logs when the check fails).
 * Guide refs: §2 FAQ p10 (seed money only in BN3, max 20 divisions), §4 p19, §17.2/§17.3/§17.4 p63-64. */

import { BN_FILE, corpLog } from "./corp-lib.js";
import { getNsDataThroughFile, getHardCodedBitNodeMultipliers } from "../helpers.js";

const MAX_DIVISIONS_BN3 = 20; // guide §2 FAQ p10: "in BN3 it's 20"

/** Pure: derive the BitNode profile from the BitNode multipliers. No ns — unit-testable offline.
 * @param {number} bn The current BitNode (ns.getResetInfo().currentNode)
 * @param {{CorporationValuation?: number, CorporationSoftcap?: number, CorporationDivisions?: number}} mults BitNode multipliers
 * @param {number} sf3Level Level of Source-File 3 (0 when not installed)
 * @returns {{bn:number, sf3:number, valuationMult:number, softcap:number, divisionsMult:number,
 *            maxDivisionsApprox:number, dividendTax:number, offerScale:number, viable:boolean, note:string}} **/
export function profileFromMultipliers(bn, mults, sf3Level) {
    const valuationMult = mults?.CorporationValuation ?? 1;
    const softcap = mults?.CorporationSoftcap ?? 1;
    const divisionsMult = mults?.CorporationDivisions ?? 1;
    const viable = valuationMult > 0 && softcap >= 0.15; // BN8 and softcap-crippled BNs
    return {
        bn: bn,
        sf3: sf3Level,
        valuationMult: valuationMult,
        softcap: softcap,
        divisionsMult: divisionsMult,
        // ASSUMPTION (unverified): the 20-division cap scales with CorporationDivisions. Not documented.
        maxDivisionsApprox: Math.round(MAX_DIVISIONS_BN3 * divisionsMult),
        dividendTax: 1 - softcap + 0.15, // guide §17.4 p64
        offerScale: valuationMult, // guide §17.3 p64: offers scale with CorporationValuation
        viable: viable,
        note: !viable
            ? "corporation disabled/unprofitable in this BN"
            : bn === 3
              ? "BN3: seed money allowed"
              : `BN${bn}: no seed money — self-fund 150e9 (50e9 on a self-funded restart); valuation x${valuationMult}`,
    };
}

/** @param {NS} ns **/
export async function main(ns) {
    const resetInfo = ns.getResetInfo(); // 1 GB
    const bn = resetInfo.currentNode;
    const sf3 = resetInfo.ownedSF?.get?.(3) ?? 0; // Map; absent when SF3 is not installed
    const canCreateSeed = ns.corporation.canCreateCorporation(false) === "Success"; // 0 GB
    const canCreateSelf = ns.corporation.canCreateCorporation(true) === "Success"; // 0 GB
    const hasCorp = ns.corporation.hasCorporation(); // 0 GB

    // Multipliers WITHOUT helpers' spawn-a-temp-script machinery (see the header): the direct call returns
    // instantly; getBitNodeMultipliers needs BN5 or SF5 and throws (one red Terminal line, caught here)
    // otherwise, in which case helpers' hard-coded table gives the same numbers with no ns call at all.
    let mults;
    try {
        mults = ns.getBitNodeMultipliers(); // 4 GB
    } catch {
        mults = await getHardCodedBitNodeMultipliers(ns, getNsDataThroughFile, bn); // pure when bnOverride is given
    }
    const profile = { ...profileFromMultipliers(bn, mults, sf3), canCreateSeed: canCreateSeed, canCreateSelf: canCreateSelf };

    // canCreateCorporation reports "CorporationExists" once a corporation exists, which would wrongly mark a
    // running corporation unviable — keep the multiplier verdict in that case, and keep the plain
    // "disabled" note when the multipliers (BN8) already decided the corp is not viable.
    if (profile.viable && !hasCorp && !canCreateSeed && !canCreateSelf) {
        profile.viable = false;
        profile.note += " (cannot create a corporation here: no seed money and no 150e9 self-fund)";
    }

    ns.write(BN_FILE, JSON.stringify(profile), "w");
    corpLog(ns, `BN${bn} sf3=${sf3} viable=${profile.viable} offerScale=${profile.offerScale} — ${profile.note}`, "MILESTONE");
    if (!profile.viable) corpLog(ns, `corporation not viable in BN${bn}: valuationMult=${profile.valuationMult} softcap=${profile.softcap}`, "ERROR");
    return profile;
}

/** T08 acceptance 1, verbatim. node --input-type=module -e "import('./Corp/corp-bn.js').then(m=>m.selfCheck())" **/
export function selfCheck() {
    const bn3 = profileFromMultipliers(3, { CorporationValuation: 1, CorporationSoftcap: 1, CorporationDivisions: 1 }, 3);
    if (!bn3.viable) throw new Error("BN3 viable");
    if (bn3.offerScale !== 1) throw new Error("BN3 offerScale");
    if (bn3.dividendTax !== 0.15) throw new Error("BN3 dividendTax");
    if (bn3.maxDivisionsApprox !== 20) throw new Error("BN3 maxDivisionsApprox");
    if (bn3.note !== "BN3: seed money allowed") throw new Error("BN3 note");

    const bn13 = profileFromMultipliers(13, { CorporationValuation: 0.001, CorporationSoftcap: 0.4, CorporationDivisions: 0.4 }, 3);
    if (bn13.offerScale !== 0.001) throw new Error("BN13 offerScale");
    if (Math.abs(bn13.dividendTax - 0.75) > 1e-9) throw new Error("BN13 dividendTax");

    const bn5 = profileFromMultipliers(5, { CorporationValuation: 0.75, CorporationSoftcap: 1, CorporationDivisions: 0.75 }, 3);
    if (bn5.offerScale !== 0.75) throw new Error("BN5 offerScale");
    if (!bn5.viable) throw new Error("BN5 viable");

    const bn8 = profileFromMultipliers(8, { CorporationValuation: 0, CorporationSoftcap: 0, CorporationDivisions: 0 }, 0);
    if (bn8.viable) throw new Error("BN8 must not be viable");
    if (bn8.note !== "corporation disabled/unprofitable in this BN") throw new Error("BN8 note");

    const noMults = profileFromMultipliers(2, {}, 0); // missing fields default to permissive values
    if (!noMults.viable || noMults.offerScale !== 1) throw new Error("defaults");
    return true;
}
