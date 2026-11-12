import {
    log, getFilePath, getConfiguration, instanceCount, getNsDataThroughFile, runCommand, waitForProcessToComplete,
    getActiveSourceFiles, tryGetBitNodeMultipliers, getStocksValue, unEscapeArrayArgs,
    formatMoney, formatDuration, formatNumber, getErrorInfo, tail, jsonReplacer
} from './helpers.js'

const argsSchema = [ // The set of all command line arguments
    ['next-bn', 0], // If we destroy the current BN, the next BN to start
    ['disable-auto-destroy-bn', false], // Set to true if you do not want to auto destroy this BN when done
    ['install-at-aug-count', 8], // Automatically install when we can afford this many new augmentations (with NF only counting as 1). Note: This number will automatically be increased by 1 for every level of SF11 you have (up to 3)
    ['install-at-aug-plus-nf-count', 12], // or... automatically install when we can afford this many augmentations including additional levels of Neuroflux.  Note: This number will automatically be increased by 1 for every level of SF11 you have (up to 3)
    ['install-for-augs', ["The Red Pill"]], // or... automatically install as soon as we can afford one of these augmentations
    ['install-countdown', 5 * 60 * 1000], // If we're ready to install, wait this long first to see if more augs come online (we might just be gaining momentum)
    ['time-before-boosting-best-hack-server', 15 * 60 * 1000], // Wait this long before picking our best hack-income server and spending hashes on boosting it
    ['reduced-aug-requirement-per-hour', 0.5], // For every hour since the last reset, require this many fewer augs to install.
    ['interval', 2000], // Wake up this often (milliseconds) to check on things
    ['interval-check-scripts', 10000], // Get a listing of all running processes on home this frequently
    ['high-hack-threshold', 8000], // Once hack level reaches this, we start daemon in high-performance hacking mode
    ['enable-bladeburner', null], // (Deprecated) Bladeburner is now always enabled if it's available. Use '--disable-bladeburner' to explicitly turn off
    ['disable-bladeburner', false], // This will instruct daemon.js not to run the bladeburner.js, even if bladeburner is available.
    ['wait-for-4s-threshold', 0.9], // Set to 0 to not reset until we have 4S. If money is above this ratio of the 4S Tix API cost, don't reset until we buy it.
    ['disable-wait-for-4s', false], // If true, will doesn't wait for the 4S Tix API to be acquired under any circumstantes
    ['disable-rush-gangs', false], // Set to true to disable focusing work-for-faction on Karma until gangs are unlocked
    ['disable-casino', false], // Set to true to disable running the casino.js script automatically
    ['spend-hashes-on-server-hacking-threshold', 0.1], // Threshold for how good hacking multipliers must be to merit spending hashes for boosting hack income. Set to a large number to disable this entirely.
    ['on-completion-script', null], // Spawn this script when we defeat the bitnode
    ['on-completion-script-args', []], // Optional args to pass to the script when we defeat the bitnode
    ['xp-mode-interval-minutes', 55], // Every time this many minutes has elapsed, toggle daemon.js to runing in --xp-only mode, which prioritizes earning hack-exp rather than money
    ['xp-mode-duration-minutes', 5], // The number of minutes to keep daemon.js in --xp-only mode before switching back to normal money-earning mode.
    ['no-tail-windows', false], // Set to true to prevent the default behaviour of opening a tail window for certain launched scripts. (Doesn't affect scripts that open their own tail windows)
];

export function autocomplete(data, args) {
    data.flags(argsSchema);
    const lastFlag = args.length > 1 ? args[args.length - 2] : null;
    if (["--on-completion-script"].includes(lastFlag))
        return data.scripts;
    return [];
}

export const CORPORATION_SELF_FUND_COST = 150e9; // stable helpers.ts costOfCreatingCorporation(false); mirrors Corp/phase-round1.js

/** Home RAM (GB) autopilot tells daemon.js to keep out of its hack/grow/weaken batches while the
 *  corporation runs. daemon.js's own default (--reserved-ram 32, doubled to 64 once home >=
 *  --double-reserve-threshold 512 GB) is smaller than the corporation suite needs, so the scheduler
 *  fills home and corp.js loses the ns.run race for its own snapshot:
 *  "not enough home RAM for Corp/corp-snapshot.js: needs 103.00 GB, free 32.00 GB".
 *  Sizing (docs figures, T21 RAM audit - re-derive with `mem` before trusting): services + the per-cycle
 *  snapshot (103.0) + the largest job (phase-round1 554.3) = 1132.6 GB, or 1306.8 GB with --custom-supply;
 *  +~90 GB slack for the game's own home residents (stats.js, sleeves, gangs, ...).
 *  On a home smaller than this, daemon.js's `maxRam - reserved` clamps to 0 and home stops batching
 *  entirely - the accepted trade while the corporation is running.
 *  ponytail: one constant, no per-BN sizing. Set it to 1e100 to take home out of batching outright (the
 *  stanek value in reservedHomeRam), or to 0 to leave daemon.js's own default alone. */
export const CORP_HOME_RESERVE = 1400;

/** Pure: what should autopilot do about the corporation on this check?
 *  `liquidate` = sell the portfolio now, `launch` = start corp.js now, `unavailable` = this BN cannot create one.
 *  @param {{corpRunning: boolean, hasCorp: boolean, funding: boolean, canSeed: boolean, canSelfFund: boolean, cash: number, stocks: number}} s */
export function corporationPlan({ corpRunning, hasCorp, funding, canSeed, canSelfFund, cash, stocks }) {
    if (corpRunning) return { liquidate: false, launch: false, unavailable: false }; // already handing off
    if (hasCorp) return { liquidate: false, launch: true, unavailable: false }; // manager died: restart it, never re-fund
    if (!canSeed && !canSelfFund) return { liquidate: false, launch: false, unavailable: true };
    if (canSeed || cash >= CORPORATION_SELF_FUND_COST) return { liquidate: false, launch: true, unavailable: false };
    // Sell only once: after the sale the latch (`funding`) stays on until the corporation exists, so a
    // shortfall cannot become sell -> re-buy -> sell churn.
    if (!funding && cash + stocks >= CORPORATION_SELF_FUND_COST) return { liquidate: true, launch: false, unavailable: false };
    return { liquidate: false, launch: false, unavailable: false }; // still saving
}

/** Pure: how much home RAM (GB) daemon.js must keep free from its hack/grow/weaken batches.
 *  0 = pass no --reserved-ram at all, leaving daemon.js's own default (32 GB, doubled at 512 GB home) alone.
 *  @param {{stanekRunning: boolean, sf4: number, corpRunning: boolean}} s @returns {number} **/
export function reservedHomeRam({ stanekRunning, sf4, corpRunning }) {
    if (stanekRunning) return 1e100; // stanek.js has the whole home; nothing may batch on it (pre-existing rule)
    const sf4Reserve = sf4 && sf4 < 3 ? 32 * (sf4 == 2 ? 4 : 16) : 0; // pre-existing SF4 < 3 rule, unchanged
    return Math.max(sf4Reserve, corpRunning ? CORP_HOME_RESERVE : 0);
}

/** Pure: does the live daemon.js need a restart to pick up `reservedRam`? daemon.js's own relaunch
 *  heuristic ignores NUMERIC args, so a changed --reserved-ram would otherwise never take effect.
 *  `reservedRam === 0` means "pass NO flag" (daemon.js's own default applies, 32 or 64 by home size),
 *  so the only relaunch it can justify is taking an existing flag AWAY - comparing it against daemon's
 *  32 default made every check relaunch daemon.js with byte-identical args (BN9 loop, 2026-11-08).
 *  @param {string[]|undefined} runningArgs the live daemon.js's args (undefined = it is not running)
 *  @param {number} reservedRam the value we want it to run with @returns {boolean} **/
export function daemonRamReserveChanged(runningArgs, reservedRam) {
    if (!runningArgs) return false; // not running: the `!existingDaemon` path starts it with the new args
    const i = runningArgs.indexOf("--reserved-ram");
    const running = i >= 0 ? Number(runningArgs[i + 1]) : null; // null = no flag, i.e. daemon.js's own default
    if (reservedRam === 0) return running !== null; // we want no flag: relaunch only to remove one
    return running !== reservedRam;
}

/** Offline check for the pure decision above: node --input-type=module -e "import('./autopilot.js').then(m => m.selfCheck())" */
export function selfCheck() {
    const eq = (got, want, label) => {
        if (JSON.stringify(got) !== JSON.stringify(want))
            throw new Error(`${label}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
    };
    const base = { corpRunning: false, hasCorp: false, funding: false, canSeed: false, canSelfFund: true, cash: 10e9, stocks: 140e9 };
    const none = { liquidate: false, launch: false, unavailable: false };
    eq(corporationPlan(base), { liquidate: true, launch: false, unavailable: false }, "portfolio can fund the seed");
    eq(corporationPlan({ ...base, cash: 150e9, stocks: 0 }), { liquidate: false, launch: true, unavailable: false }, "cash alone is enough");
    eq(corporationPlan({ ...base, cash: 149.999e9, stocks: 0 }), none, "one dollar short: keep saving");
    eq(corporationPlan({ ...base, cash: 0, stocks: 0 }), none, "nothing to sell yet");
    eq(corporationPlan({ ...base, funding: true }), none, "never sell the same portfolio twice");
    eq(corporationPlan({ ...base, funding: true, cash: 140e9, stocks: 0 }), none, "short after selling: keep saving, never re-buy");
    eq(corporationPlan({ ...base, funding: true, cash: 150e9, stocks: 0 }), { liquidate: false, launch: true, unavailable: false }, "shortfall closed by income");
    eq(corporationPlan({ ...base, canSeed: true, cash: 0, stocks: 0 }), { liquidate: false, launch: true, unavailable: false }, "BN3 seed needs no money");
    eq(corporationPlan({ ...base, hasCorp: true, cash: 0, stocks: 0 }), { liquidate: false, launch: true, unavailable: false }, "restart a dead manager");
    eq(corporationPlan({ ...base, corpRunning: true, cash: 150e9 }), none, "manager already running");
    // maybeStartCorporation only treats `launch:false` as "still saving for the seed" when !hasCorp, so a corporation
    // that exists with its manager running must stay a plain no-op plan (it used to print the saving status line).
    eq(corporationPlan({ ...base, corpRunning: true, hasCorp: true, cash: 3.21e9, stocks: 6.882e9 }), none, "managed corporation: nothing to do, never 'saving'");
    eq(corporationPlan({ ...base, canSelfFund: false }), { liquidate: false, launch: false, unavailable: true }, "this BN cannot create one");
    // reservedHomeRam: the corporation outranks an early SF4's reserve; stanek owns all of home.
    eq(reservedHomeRam({ stanekRunning: false, sf4: undefined, corpRunning: true }), CORP_HOME_RESERVE, "reservedHomeRam: corporation needs home RAM");
    eq(reservedHomeRam({ stanekRunning: false, sf4: 1, corpRunning: false }), 512, "reservedHomeRam: SF4 level 1 (pre-existing rule)");
    eq(reservedHomeRam({ stanekRunning: false, sf4: 2, corpRunning: false }), 128, "reservedHomeRam: SF4 level 2 (pre-existing rule)");
    eq(reservedHomeRam({ stanekRunning: false, sf4: 3, corpRunning: false }), 0, "reservedHomeRam: SF4 level 3 reserves nothing");
    eq(reservedHomeRam({ stanekRunning: false, sf4: undefined, corpRunning: false }), 0, "reservedHomeRam: nothing needs home");
    eq(reservedHomeRam({ stanekRunning: false, sf4: 2, corpRunning: true }), CORP_HOME_RESERVE, "reservedHomeRam: corporation outranks SF4 level 2");
    eq(reservedHomeRam({ stanekRunning: true, sf4: 2, corpRunning: true }), 1e100, "reservedHomeRam: stanek wins outright");
    // daemonRamReserveChanged: a changed reserve must force the relaunch daemon.js's own heuristic skips.
    eq(daemonRamReserveChanged(undefined, CORP_HOME_RESERVE), false, "reserve: daemon.js not running");
    eq(daemonRamReserveChanged([], CORP_HOME_RESERVE), true, "reserve: running with daemon.js's schema default (32)");
    eq(daemonRamReserveChanged(["--reserved-ram", 32], CORP_HOME_RESERVE), true, "reserve: running with 32");
    eq(daemonRamReserveChanged(["--reserved-ram", CORP_HOME_RESERVE], CORP_HOME_RESERVE), false, "reserve: already correct - must not relaunch every check");
    eq(daemonRamReserveChanged(["--reserved-ram", 1e100], CORP_HOME_RESERVE), true, "reserve: stanek ended - hand RAM back");
    eq(daemonRamReserveChanged(["--cycle-timing-delay", 40, "--silent-misfires"], CORP_HOME_RESERVE), true, "reserve: a flag list is not a reserve");
    // reservedRam === 0 means we push NO --reserved-ram: that must be the steady state, not a Relaunch-every-check.
    eq(daemonRamReserveChanged(["--disable-script", "work-for-factions.js"], 0), false, "reserve 0: no flag wanted, none running - never relaunch");
    eq(daemonRamReserveChanged(["--reserved-ram", 1e100], 0), true, "reserve 0: stanek ended - hand RAM back");
    eq(daemonRamReserveChanged(["--reserved-ram", CORP_HOME_RESERVE], 0), true, "reserve 0: corporation closed - hand RAM back");
    return true;
}

/** The entire program is now wrapped in the main functino to avoid objects in
 * global shared memory surviving between multiple invocations of this script.
 * @param {NS} ns **/
export async function main(ns) {
    const persistentLog = "log.autopilot.txt";
    const factionManagerOutputFile = "/Temp/affordable-augs.txt"; // Temp file produced by faction manager with status information
    const defaultBnOrder = [ // The order in which we intend to play bitnodes
        // 1st Priority: Key new features and/or major stat boosts
        4.3,  // Normal. Need singularity to automate everything, and need the API costs reduced from 16x -> 4x -> 1x reliably do so from the start of each BN
        1.2,  // Easy.   Big boost to all multipliers (16% -> 24%), and no penalties to slow us down. Should go quick.
        5.1,  // Normal. Unlock intelligence stat early to maximize growth, getBitNodeMultipliers + Formulas.exe for more accurate scripts, and +8% hack mults
        1.3,  // Easy.   The last bonus is not as big a jump (24% -> 28%), but it's low-hanging fruit
        2.1,  // Easy.   Unlocks gangs, which reduces the need to grind faction and company rep for getting access to most augmentations, speeding up all BNs

        // 2nd Priority: More new features, from Harder BNs. Things will slow down for a while, but the new features should pay in dividends for all future BNs
        10.1, // Hard.   Unlock Sleeves (which tremendously speed along gangs outside of BN2) and grafting (can speed up slow rep-gain BNs). // TODO: Buying / upgrading sleeve mem has no API, requires manual interaction. Can we automate this with UI clicking like casino.js?
        8.2,  // Hard.   8.1 immediately unlocks stocks, 8.2 doubles stock earning rate with shorts. Stocks are never nerfed in any BN (4S can be made too pricey though), and we have a good pre-4S stock script.
        13.1, // Hard.   Unlock Stanek's Gift. We've put a lot of effort into min/maxing the Tetris, so we should try to get it early, even though it's a hard BN. I might change my mind and push this down if it proves too slow.
        7.1,  // Hard.   Unlocks the bladeburner API (and bladeburner outside of BN 6/7). Many recommend it before BN9 since it ends up being a faster win condition in some of the tougher bitnodes ahead.
        9.1,  // Hard.   Unlocks hacknet servers. Hashes can be earned and spent on cash very early in a tough BN to help kick-start things. Hacknet productin/costs improved by 12%
        14.2, // Hard.   Boosts go.js bonuses, but note that we can automate IPvGO from the very start (BN1.1), no need to unlock it. 14.1 doubles all bonuses. 14.2 unlocks the cheat API.

        // 3nd Priority: With most features unlocked, max out SF levels roughly in the order of greatest boost and/or easiest difficulty, to hardest and/or less worthwhile
        2.3,  // Easy.   Boosts to crime success / money / CHA will speed along gangs, training and earning augmentations in the future
        5.3,  // Normal. Diminishing boost to hacking multipliers (8% -> 12% -> 14%), but relatively normal bitnode, especially with other features unlocked
        11.3, // Normal. Decrease augmentation cost scaling in a reset (4% -> 6% -> 7%) (can buy more augs per reset). Also boosts company salary/rep (32% -> 48% -> 56%), which we have little use for with gangs.)
        14.3, // Hard.   Makes go.js cheats slightly more successful, increases max go favour from (100->120) and not too difficult to get out of the way
        13.3, // Hard.   Make stanek's gift bigger to get more/different boosts
        9.2,  // Hard.   Start with 128 GB home ram. Speeds up slow-starting new BNs, but less important with good ram-dodging scripts. Hacknet productin/costs improved by 12% -> 18%.
        9.3,  // Hard.   Start each new BN with an already powerful hacknet server, but *only until the first reset*, which is a bit of a damper. Hacknet productin/costs improved by 18% -> 21%
        10.3, // Hard.   Get the last 2 sleeves (6 => 8) to boost their productivity ~30%. These really help with Bladeburner below. Putting this a little later because buying sleeves memory upgrades requires manual intervention right now.

        // 4th Priority: Play some Bladeburners. Mostly not used to beat other BNs, because for much of the BN this can't be done concurrently with player actions like crime/faction work, and no other BNs are "tuned" to be beaten via Bladeburner win condition
        6.3,  // Normal. The 3 easier bladeburner BNs. Boosts combat stats by 8% -> 12% -> 14%
        7.3,  // Hard.   The remaining 2 hard bladeburner BNs. Boosts all Bladeburner mults by 8% -> 12% -> 14%, so no interaction with other BNs unless trying to win via Bladeburner.

        // Low Priority:
        8.3,  // Hard.   Just gives stock "Limit orders" which we don't use in our scripts,
        3.3,  // Hard.   Corporations. I have no corp scripts, maybe one day I will. The history here is: in 2021, corps were too exploity and broke the game (inf. money). Also the APIs were buggy and new, so I skipped it. Autopilot will win normally while ignoring corps.
        12.9999 // Easy. Keep playing forever. Only stanek scales very well here, there is much work to be done to be able to climb these faster.
    ];
    const augTRP = "The Red Pill";
    const augStanek = `Stanek's Gift - Genesis`;

    let options; // The options used at construction time
    let playerInGang = false, rushGang = false; // Tells us whether we're should be trying to work towards getting into a gang
    let playerInBladeburner = false; // Whether we've joined bladeburner
    let wdHack = (/**@returns{null|number}*/() => null)(); // If the WD server is available (i.e. TRP is installed), caches the required hack level
    let ranCasino = false; // Flag to indicate whether we've stolen 10b from the casino yet
    let reservedPurchase = 0; // The amount of player money that has been reserved to purchase augmentations
    let alreadyJoinedDaedalus = false, autoJoinDaedalusUnavailable = false, reservingMoneyForDaedalus = false, disableStockmasterForDaedalus = false; // Flags to indicate that we should be keeping 100b cash on hand to earn an invite to Daedalus
    let prioritizeHackForDaedalus = false, prioritizeHackForWd = false;
    let lastScriptsCheck = 0; // Last time we got a listing of all running scripts
    let fundingCorporation = false; // True from the first portfolio sale until a corporation exists; keeps stockmaster offline meanwhile
    let homeRam = 0; // Amount of RAM on the home server, last we checked
    let killScripts = []; // A list of scripts flagged to be restarted due to changes in priority
    let dictOwnedSourceFiles = (/**@returns{{[k: number]: number;}}*/() => [])(); // Player owned source files
    let dictServerHackReqs = (/**@returns{{[serverName: string]: number;}}*/() => undefined)(); // Hacking requirement for each server
    let unlockedSFs = [], nextBn = 0; // Info for the current bitnode
    let resetInfo = (/**@returns{ResetInfo}*/() => undefined)(); // Information about the current bitnode
    let bitNodeMults = (/**@returns{BitNodeMultipliers}*/() => undefined)(); // bitNode multipliers that can be automatically determined after SF-5
    let playerInstalledAugCount = (/**@returns{null|number}*/() => null)(); // Number of augs installed, or null if we don't have SF4 and can't tell.
    let installedAugmentations = [];
    let acceptedStanek = false, stanekLaunched = false;
    let daemonStartTime = 0; // The time we personally launched daemon.
    let installCountdown = 0; // Start of a countdown before we install augmentations.
    let installCountdownResets = 0; // Number of times we've reset the countdown because our affordable augs has increased
    let bnCompletionSuppressed = false; // Flag if we've detected that we've won the BN, but are suppressing a restart
    let sleevesMaxedOut = false; // Flag used only when the player is replaying BN 10 with all sleeves but has suppressed auto-destroying the BN, to allow continued auto-installs
    let loggedBnCompletion = false; // Flag set to ensure that if we choose to stay in the BN, we only log the "BN completed" message once per reset.
    let have4STixApi = false; // Whether we have access to the 4S (stockmarket) API. Once confirmed true, we can stop checking.
    let have4SData = false; // Whether we have access to 4S (stockmarket) data. Once confirmed true, we can stop checking.

    // Replacements for player properties deprecated since 2.3.0
    function getTimeInAug() { return Date.now() - resetInfo.lastAugReset; }
    function getTimeInBitnode() { return Date.now() - resetInfo.lastNodeReset; }

    /** @param {NS} ns **/
    async function main_start(ns) {
        const runOptions = getConfiguration(ns, argsSchema);
        if (!runOptions || await instanceCount(ns) > 1) return; // Prevent multiple instances of this script from being started, even with different args.
        options = runOptions; // We don't set the global "options" until we're sure this is the only running instance

        // The game logs EVERY non-"Success" corporation.canCreateCorporation result into OUR tail: the NS wrapper
        // (src/NetscriptFunctions/Corporation.ts:621-628) calls helpers.log -> workerScript.log(functionPath, message)
        // unless the result is "Success", and that prefix is what the tail line shows. On any BitNode other than 3 the
        // seed check can never be "Success" (src/Corporation/helpers.ts:37-39 -> UseSeedMoneyOutsideBN3 ->
        // "You cannot use seed money outside BitNode 3"), so maybeStartCorporation()'s per-check poll at line 621
        // printed it once per --interval-check-scripts, forever. Silence the API's narration, not the check:
        // canSeed/canSelfFund still drive corporationPlan() unchanged. Called ONCE, here, because disableLog()
        // re-prints "Disabled logging for ..." on every call (src/NetscriptFunctions.ts:476-490).
        ns.disableLog("corporation.canCreateCorporation"); // 0 GB

        log(ns, "INFO: Auto-pilot engaged...", true, 'info');
        // The game does not allow boolean flags to be turned "off" via command line, only on. Since this gets saved, notify the user about how they can turn it off.
        const flagsSet = ['disable-auto-destroy-bn', 'disable-bladeburner', 'disable-wait-for-4s', 'disable-rush-gangs'].filter(f => options[f]);
        for (const flag of flagsSet)
            log(ns, `WARNING: You have previously enabled the flag "--${flag}". Because of the way this script saves its run settings, the ` +
                `only way to now turn this back off will be to manually edit or delete the file ${ns.getScriptName()}.config.txt`, true);

        let startUpRan = false, keepRunning = true;
        while (keepRunning) {
            try {
                // Start-up actions, wrapped in error handling in case of temporary failures
                if (!startUpRan) startUpRan = await startUp(ns);
                // Main loop: Monitor progress in the current BN and automatically reset when we can afford TRP, or N augs.
                keepRunning = await mainLoop(ns);
            }
            catch (err) {
                log(ns, `WARNING: autopilot.js Caught (and suppressed) an unexpected error:` +
                    `\n${getErrorInfo(err)}`, false, 'warning');
                keepRunning = shouldWeKeepRunning(ns);
            }
            await ns.sleep(options['interval']);
        }
    }

    /** @param {NS} ns **/
    async function startUp(ns) {
        await persistConfigChanges(ns);

        // Collect and cache some one-time data
        resetInfo = await getNsDataThroughFile(ns, 'ns.getResetInfo()');
        bitNodeMults = await tryGetBitNodeMultipliers(ns);
        dictOwnedSourceFiles = await getActiveSourceFiles(ns, false);
        unlockedSFs = await getActiveSourceFiles(ns, true);
        homeRam = await getNsDataThroughFile(ns, `ns.getServerMaxRam(ns.args[0])`, null, ["home"]);
        try {
            if (!(4 in unlockedSFs)) {
                log(ns, `WARNING: This script requires SF4 (singularity) functions to assess purchasable augmentations ascend automatically. ` +
                    `Some functionality will be disabled and you'll have to manage working for factions, purchasing, and installing augmentations yourself.`, true);
                installedAugmentations = [];
                playerInstalledAugCount = null; // 'null' is treated as 'Unknown'
            } else {
                installedAugmentations = await getNsDataThroughFile(ns, 'ns.singularity.getOwnedAugmentations()', '/Temp/player-augs-installed.txt');
                playerInstalledAugCount = installedAugmentations.length;
            }
        } catch (err) {
            if (unlockedSFs[4] || 0 == 3) throw err; // No idea why this failed, treat as temporary and allow auto-retry.
            log(ns, `WARNING: You only have SF4 level ${unlockedSFs[4]}. Without level 3, some singularity functions will be ` +
                `too expensive to run until you have bought a lot of home RAM.`, true);
        }
        // We currently no longer have any one-time logic that needs to be run at the start of a new bitnode
        //if (getTimeInBitnode() < 60 * 1000) // Skip initialization if we've been in the bitnode for more than 1 minute
        //    await initializeNewBitnode(ns);

        // Decide what the next-up bitnode should be
        const getSFLevel = bn => Number(bn + "." + ((dictOwnedSourceFiles[bn] || 0) + (resetInfo.currentNode == bn ? 1 : 0)));
        const nextSfEarned = getSFLevel(resetInfo.currentNode);
        const nextRecommendedSf = defaultBnOrder.find(v => v - Math.floor(v) > getSFLevel(Math.floor(v)) - Math.floor(v));
        const nextRecommendedBn = Math.floor(nextRecommendedSf);
        nextBn = options['next-bn'] || nextRecommendedBn;
        log(ns, `INFO: After the current BN (${nextSfEarned}), the next recommended BN is ${nextRecommendedBn} until you have SF ${nextRecommendedSf}.` +
            `\nYou are currently earning SF${nextSfEarned}, and you already own the following source files: ` +
            Object.keys(dictOwnedSourceFiles).map(bn => `${bn}.${dictOwnedSourceFiles[bn]}`).join(", "));
        if (nextBn != nextRecommendedBn)
            log(ns, `WARN: The next recommended BN is ${nextRecommendedBn}, but the --next-bn parameter is set to override this with ${nextBn}.`, true, 'warning');

        return true;
    }

    /** Write any configuration changes to disk so that they will survive resets and new bitnodes
     * @param {NS} ns **/
    async function persistConfigChanges(ns) {
        // Because we cannot pass args to "install" and "destroy" functions, we write them to disk to override defaults
        const changedArgs = argsSchema
            .filter(a => JSON.stringify(options[a[0]], jsonReplacer) != JSON.stringify(a[1]), jsonReplacer)
            .map(a => [a[0], options[a[0]]]);
        // Fix Bug #237 - do not overwrite the config file if one of the arguments provided is of the wrong type
        // This is a copy of new code in helpers.js which generates warnings, but otherwise ignores the errors.
        // We evaluate the same logic here because we want to act on the errors (avoid persisting them)
        for (const [key, finalValue] of changedArgs) {
            const defaultValue = argsSchema.find(kvp => kvp[0] == key)[1];
            const strFinalValue = JSON.stringify(finalValue, jsonReplacer);
            const strDefaultValue = JSON.stringify(defaultValue, jsonReplacer);
            log(ns, `INFO: Default config has been modified: ${key}=${strFinalValue} (type="${typeof finalValue})" ` +
                `does not match default value of ${key}=${strDefaultValue} (type="${typeof defaultValue}").`);
            if ((typeof finalValue) !== (typeof defaultValue) && defaultValue != null) {
                log(ns, `WARNING: A configuration value provided (${key}=${strFinalValue} - ` +
                    `type="${typeof finalValue}") does not match the expected type "${typeof defaultValue}" ` +
                    `based on the default value (${key}=${strDefaultValue}).` +
                    `\nThis configuration will NOT be persisted, and the script may behave unpredictably.`);
                return;
            }
            if (finalValue !== defaultValue && (typeof finalValue == 'number') && Number.isNaN(finalValue)) {
                log(ns, `WARNING: A numeric configuration value (--${key}) got a value of "NaN" (Not a Number), ` +
                    `which likely indicates it was set to a string value that could not be parsed. ` +
                    `Please double-check the script arguments for mistakes or typos.` +
                    `\nThis configuration will NOT be persisted, and the script may behave unpredictably.`);
                return;
            }
        }

        const strConfigChanges = JSON.stringify(changedArgs, jsonReplacer);
        // Only update the config file if it doesn't match the most resent set of run args
        const configPath = `${ns.getScriptName()}.config.txt`
        const currentConfig = ns.read(configPath);
        if ((strConfigChanges.length > 2 || currentConfig) && strConfigChanges != currentConfig) {
            ns.write(configPath, strConfigChanges, "w");
            log(ns, `INFO: Updated "${configPath}" to persist the most recent run args through resets: ${strConfigChanges}`, true, 'info');
        }
    }

    /** Logic run once at the beginning of a new BN
     * @param {NS} ns */
    async function initializeNewBitnode(ns) {
        // Nothing to do here (yet)
    }

    /** Logic run periodically throughout the BN
     * @param {NS} ns */
    async function mainLoop(ns) {
        const player = await getPlayerInfo(ns);
        await updateCachedData(ns);
        let stocksValue = 0;
        try { stocksValue = await getStocksValue(ns); } catch { /* Assume if this fails (insufficient ram) we also have no stocks */ }
        manageReservedMoney(ns, player, stocksValue);
        await checkOnDaedalusStatus(ns, player, stocksValue);
        await checkIfBnIsComplete(ns, player);
        await maybeAcceptStaneksGift(ns, player);
        await checkOnRunningScripts(ns, player, stocksValue);
        await maybeDoCasino(ns, player);
        await maybeInstallAugmentations(ns, player);
        return shouldWeKeepRunning(ns); // Return false to shut down autopilot.js if we installed augs, or don't have enough home RAM
    }

    /** Ram-dodge getting player info.
     * @param {NS} ns
     * @returns {Promise<Player>} */
    async function getPlayerInfo(ns) {
        return await getNsDataThroughFile(ns, `ns.getPlayer()`);
    }

    /** Update some information that can be safely cached for small periods of time
     * @param {NS} ns */
    async function updateCachedData(ns) {
        // Now that grafting is a thing, we need to check if new augmentations have been installed between resets
        if ((4 in unlockedSFs)) { // Note: Installed augmentations can also be obtained from getResetInfo() (without SF4), but this seems unintended and will probably be removed from the game.
            try {
                installedAugmentations = await getNsDataThroughFile(ns, 'ns.singularity.getOwnedAugmentations()', '/Temp/player-augs-installed.txt');
                playerInstalledAugCount = installedAugmentations.length;
            } catch (err) {
                log(ns, `WARNING: failed to update owned augmentations (low RAM?)`, true);
            }
        }
    }

    /** Logic run periodically to if there is anything we can do to speed along earning a Daedalus invite
     * @param {NS} ns
     * @param {Player} player **/
    async function checkOnDaedalusStatus(ns, player, stocksValue) {
        // Early exit conditions, if we Daedalus is not (or is no longer) a concern for this reset
        if (alreadyJoinedDaedalus || autoJoinDaedalusUnavailable) return;
        // If we've already installed the red pill we no longer need to try to join this faction.
        // Even without SF4, we can "deduce" whether we've installed TRP by checking whether w0r1d_d43m0n has a non-zero hack level
        if (installedAugmentations.includes(augTRP) || (wdHack != null && Number.isFinite(wdHack) && wdHack > 0))
            return alreadyJoinedDaedalus = true; // Set up an early exit condition for future checks
        // See if we even have enough augmentations to attempt to join Daedalus (once we have a count of our augmentations)
        if (playerInstalledAugCount !== null && playerInstalledAugCount < bitNodeMults.DaedalusAugsRequirement) {
            if (!(10 in unlockedSFs))
                autoJoinDaedalusUnavailable = true; // Won't be able to unlock daedalus this ascend if we can't graft augs and have to install for them
            return; // Either way, for now we can't get into Daedalus without more augmentations
        }

        // See if we've already joined this faction
        if (player.factions.includes("Daedalus")) {
            alreadyJoinedDaedalus = true;
            disableStockmasterForDaedalus = false;
            // If we previously took any action to "rush" Daedalus, keep the momentum going by restarting work-for-factions.js
            // so that it immediately re-assesses priorities and sees there's a new priority faction to earn reputation for.
            if (prioritizeHackForDaedalus || reservingMoneyForDaedalus) {
                let reason;
                if (prioritizeHackForDaedalus) {
                    prioritizeHackForDaedalus = false; // Can turn off this flag now so daemon.js can be reverted
                    reason = "by prioritizing hack exp gains";
                }
                if (reservingMoneyForDaedalus) {
                    reservingMoneyForDaedalus = false; // Turn this flag off now so we reset our reserve.txt
                    reason = (reason ? reason + " and" : "by") + " saving up our money";
                }
                log(ns, `SUCCESS: We sped along joining the faction 'Daedalus' ${reason}. ` + // Pat ourselves on the back
                    `Restarting work-for-factions.js to speed along earn rep.`, false, 'success');
                killScripts.push("work-for-factions.js"); // Schedule this to be killed (will be restarted) on the next script loop.
                lastScriptsCheck = 0; // Reset cooldown on checking whether any changes need to be made to running scripts
            }
            return;
        }
        const moneyReq = 100E9;
        // If we've previously set a flag to wait for the daedalus invite and reserve money, try to speed-along joining them
        if (reservingMoneyForDaedalus && player.money >= moneyReq) // If our cash has dipped below the threshold again, we may need to take action below
            return await getNsDataThroughFile(ns, 'ns.singularity.joinFaction(ns.args[0])', null, ["Daedalus"]); // Note, we should have already checked that we have SF4 access before reserving money

        // Remaining logic below is for rushing a Daedalus invite in the current reset
        const totalWorth = player.money + stocksValue;
        // Check for sufficient hacking level before attempting to reserve money
        if (player.skills.hacking < 2500) {
            // If we happen to already have enough money for daedalus and are only waiting on hack-level,
            // set a flag to switch daemon.js into --xp-only mode, to prioritize earning hack exp over money
            // HEURISTIC (i.e. Hack): Only do this if we naturally get within 75% of the hack stat requirement,
            //    otherwise, assume our hack gain rate is too low in this reset to make it all the way to 2500.
            if (totalWorth >= moneyReq && player.skills.hacking >= (2500 * 0.75))
                prioritizeHackForDaedalus = true;
            //log(ns, `total worth: ${formatMoney(totalWorth)} moneyReq: ${formatMoney(moneyReq)} prioritizeHackForDaedalus: ${prioritizeHackForDaedalus}`)
            return reservingMoneyForDaedalus = false; // Don't reserve money until hack level suffices
        }
        // If we have sufficient augs and hacking, the only requirement left is the money (100b)
        // If our net worth is sufficient, reserve our money and liquidate stocks if necessary until we get the invite
        if (player.money < moneyReq && totalWorth > moneyReq * 1.001 /* slight buffer to account for timing issues */) {
            // Note: Without SF4, we have no way of knowing how many augmentations we own, so we should probably
            //       never reserve money in case this requirement is not met, or we're potentially just wasting money
            if (!(4 in unlockedSFs)) {
                log(ns, `SUCCESS: ${player.money < moneyReq ? "If you sell your stocks, y" : "Y"}ou should have enough money ` +
                    `(>=${formatMoney(moneyReq)}) and a sufficiently high hack level (>=${2500}) to get an invite from the faction Daedalus. ` +
                    `Before you attempt this though, ensure you have ${bitNodeMults.DaedalusAugsRequirement} ` +
                    `augmentations installed (scripts cannot check this without SF4).`, true, 'success');
                return autoJoinDaedalusUnavailable = true; // We won't show this again.
            }
            reservingMoneyForDaedalus = true; // Flag to pause all spending (set reserve.txt) until we've gotten the Daedalus invite
            if (player.money < moneyReq) { // Only liquidate stocks if we don't have enough cash lying around.
                disableStockmasterForDaedalus = true; // Flag to keep stockmaster offline until we've gotten a daedalus invite
                log(ns, "INFO: Temporarily liquidating stocks to earn an invite to Daedalus...", true, 'info');
                launchScriptHelper(ns, 'stockmaster.js', ['--liquidate']);
            } // else if we don't liquidate stocks, and our money dips below 100E9 again, we can always do it on the next loop
        } else if (resetInfo.currentNode == 8) {
            // In BN8, there is nothing worth spending money on when we've met all other Daedalus requirements except the $100b money.
            // We should immediately set the reserve and wait until we have enough wealth to liquidate stocks and get the invite.
            reservingMoneyForDaedalus = true;
        } // Cancel the reserve if our money drops below the threshold before getting an invite (due to other scripts not respecting the reserve?)
        else if (reservingMoneyForDaedalus && totalWorth < moneyReq * 0.999 /* slight buffer to let cash recover */) {
            reservingMoneyForDaedalus = false; // Cancel the hold on funds, and wait for total worth to increase again
            disableStockmasterForDaedalus = false; // Allow stockmaster to be relaunched
            log(ns, `WARN: We previously had sufficient wealth to earn a Daedalus invite (>=${formatMoney(moneyReq)}), ` +
                `but our wealth somehow decreased (to ${formatMoney(totalWorth)}) before the invite was recieved, ` +
                `so we'll need to wait for it to recover and try again later.`, false, 'warning');
        }
    }

    /** Logic run periodically throughout the BN to see if we are ready to complete it.
     * @param {NS} ns
     * @param {Player} player */
    async function checkIfBnIsComplete(ns, player) {
        if (bnCompletionSuppressed) return true;
        if (wdHack === null) { // If we haven't checked yet, see if w0r1d_d43m0n (server) has been unlocked and get its required hack level
            wdHack = await getNsDataThroughFile(ns, 'ns.scan("The-Cave").includes("w0r1d_d43m0n") ? ' +
                'ns.getServerRequiredHackingLevel("w0r1d_d43m0n"): -1',
                '/Temp/wd-hackingLevel.txt');
            if (wdHack == -1) wdHack = Number.POSITIVE_INFINITY; // Cannot stringify infinity, so use -1 in transit
        }
        // Detect if a BN win condition has been met
        let bnComplete = player.skills.hacking >= wdHack;

        // We cannot technically destroy WD until we have root. If we recently reset, we may have to wait a bit
        // for daemon.js to get a little money, buy the crack tools, and nuke the server first.
        if (bnComplete) {
            const caveRooted = await getNsDataThroughFile(ns, 'ns.hasRootAccess(ns.args[0])', null, ["w0r1d_d43m0n"]);
            if (!caveRooted)
                bnComplete = false;
        }

        // Detect the BB win condition (requires SF7 (bladeburner API) or being in BN6)
        if (7 in unlockedSFs) // No point making this async check if bladeburner API is unavailable
            playerInBladeburner = playerInBladeburner || await getNsDataThroughFile(ns, 'ns.bladeburner.inBladeburner()');
        if (!bnComplete && playerInBladeburner)
            bnComplete = await getNsDataThroughFile(ns,
                `ns.bladeburner.getActionCountRemaining('Black Operations', 'Operation Daedalus') === 0`,
                '/Temp/bladeburner-completed.txt');

        // HEURISTIC: If we naturally get within 75% of the if w0r1d_d43m0n hack stat requirement,
        //    switch daemon.js to prioritize earning hack exp for the remainder of the BN
        if (player.skills.hacking >= (wdHack * 0.75))
            prioritizeHackForWd = !bnComplete;

        if (!bnComplete) return false; // No win conditions met


        if (!loggedBnCompletion) {
            const text = `BN ${resetInfo.currentNode}.${(dictOwnedSourceFiles[resetInfo.currentNode] || 0) + 1} completed at ` +
                `${formatDuration(getTimeInBitnode())} ` +
                `(${(player.skills.hacking >= wdHack ? `hack (${wdHack.toFixed(0)})` : 'bladeburner')} win condition)`;
            persist_log(ns, text);
            log(ns, `SUCCESS: ${text}`, true, 'success');
            loggedBnCompletion = true; // Flag set to ensure that if we choose to stay in the BN, we only log the "BN completed" message once per reset.
        }

        // Run the --on-completion-script if specified
        if (options['on-completion-script']) {
            const pid = launchScriptHelper(ns, options['on-completion-script'], unEscapeArrayArgs(options['on-completion-script-args']), false);
            if (pid) await waitForProcessToComplete(ns, pid);
        }

        // Check if there is some reason not to automatically destroy this BN
        if (resetInfo.currentNode == 10) { // Suggest the user doesn't reset until they buy all sleeves and max memory
            const shouldHaveSleeveCount = Math.min(8, 6 + (dictOwnedSourceFiles[10] || 0));
            const numSleeves = await getNsDataThroughFile(ns, `ns.sleeve.getNumSleeves()`);
            let reasonToStay = null;
            if (numSleeves < shouldHaveSleeveCount)
                reasonToStay = `Detected that you only have ${numSleeves} sleeves, but you could have ${shouldHaveSleeveCount}.`;
            else {
                let sleeveInfo = (/** @returns {SleevePerson[]} */() => [])();
                sleeveInfo = await getNsDataThroughFile(ns, `ns.args.map(i => ns.sleeve.getSleeve(i))`, '/Temp/sleeve-getSleeve-all.txt', [...Array(numSleeves).keys()]);
                if (sleeveInfo.some(s => s.memory < 100))
                    reasonToStay = `Detected that you have ${numSleeves}/${shouldHaveSleeveCount} sleeves, but they do not all have the maximum memory of 100:\n  ` +
                        sleeveInfo.map((s, i) => `- Sleeve ${i} has ${s.memory}/100 memory`).join('\n  ');
                else
                    sleevesMaxedOut = true; // Flag is used elsewhere to allow continued installs
            }
            if (reasonToStay) {
                log_once(ns, `WARNING: ${reasonToStay}\nTry not to leave BN10 before buying all you can from the faction "The Covenant", especially sleeve memory!` +
                    `\nNOTE: You can ONLY buy sleeves & memory from The Covenant in BN10, which is why it's important to do this before you leave.`, true);
                return true; // Return true, but do not set `bnCompletionSuppressed = true` so we can auto-reset once the user intervenes.
            }
        }
        if (options['disable-auto-destroy-bn']) {
            log(ns, `--disable-auto-destroy-bn is set, you can manually exit the bitnode when ready.`, true);
            return bnCompletionSuppressed = true;
        }
        if (!(4 in unlockedSFs)) {
            log(ns, `You do not own SF4, so you must manually exit the bitnode (` +
                `${player.skills.hacking >= wdHack ? "by hacking W0r1dD43m0n" : "on the bladeburner BlackOps tab"}).`, true);
            return bnCompletionSuppressed = true;
        }

        // Clean out our temp folder and flags so we don't have any stale data when the next BN starts.
        let pid = launchScriptHelper(ns, 'cleanup.js');
        if (pid) await waitForProcessToComplete(ns, pid);

        // In all likelihood, daemon.js has already nuked this like it does all servers, but in case it hasn't:
        pid = launchScriptHelper(ns, '/Tasks/crack-host.js', ['w0r1d_d43m0n']);
        if (pid) await waitForProcessToComplete(ns, pid);

        // Use the new special singularity function to automate entering a new BN
        pid = await runCommand(ns, `ns.singularity.destroyW0r1dD43m0n(ns.args[0], ns.args[1]` +
            `, { sourceFileOverrides: new Map() }` + // Work around a long-standing bug on bitburner-official.github.io TODO: Remove when no longer needed
            `)`, '/Temp/singularity-destroyW0r1dD43m0n.js', [nextBn, ns.getScriptName()]);
        if (pid) {
            log(ns, `SUCCESS: Initiated process ${pid} to execute 'singularity.destroyW0r1dD43m0n' with args: [${nextBn}, ${ns.getScriptName()}]`, true, 'success')
            await waitForProcessToComplete(ns, pid);
            log(ns, `WARNING: Process is done running, why am I still here? Sleeping 10 seconds...`, true, 'error')
            await ns.sleep(10000);
        }
        persist_log(ns, log(ns, `ERROR: Tried destroy the bitnode (pid=${pid}), but we're still here...`, true, 'error'));
        //return bnCompletionSuppressed = true; // Don't suppress bn Completion, try again on our next loop.
    }

    /** Helper to get a list of all scripts running (on home)
     * @param {NS} ns */
    async function getRunningScripts(ns) {
        return await getNsDataThroughFile(ns, 'ns.ps(ns.args[0])', null, ['home']);
    }

    /** Helper to get the first instance of a running script by name.
     * @param {NS} ns
     * @param {string} baseScriptName The name of a script (before applying getFilePath)
     * @param {ProcessInfo[]} runningScripts - (optional) Cached list of running scripts to avoid repeating this expensive request
     * @param {(value: ProcessInfo, index: number, array: ProcessInfo[]) => unknown} filter - (optional) Filter the list of processes beyond just matching on the script name */
    function findScriptHelper(baseScriptName, runningScripts, filter = null) {
        return runningScripts.filter(s => s.filename == getFilePath(baseScriptName) && (!filter || filter(s)))[0];
    }

    /** Helper to kill a running script instance by name
     * @param {NS} ns
     * @param {ProcessInfo[]} runningScripts - (optional) Cached list of running scripts to avoid repeating this expensive request
     * @param {ProcessInfo} processInfo - (optional) The process to kill, if we've already found it in advance */
    async function killScript(ns, baseScriptName, runningScripts = null, processInfo = null) {
        processInfo = processInfo || findScriptHelper(baseScriptName, runningScripts || (await getRunningScripts(ns)))
        if (processInfo) {
            log(ns, `INFO: Killing script ${baseScriptName} with pid ${processInfo.pid} and args: [${processInfo.args.join(", ")}].`, false, 'info');
            return await getNsDataThroughFile(ns, 'ns.kill(ns.args[0])', null, [processInfo.pid]);
        }
        log(ns, `INFO: Skipping request to kill script ${baseScriptName}, no running instance was found...`, false, 'warning');
        return false;
    }

    /** Hand the player's wealth over to the corporation once one can be created. Mirrors the Daedalus
     * liquidation above: sell the portfolio with stockmaster's own --liquidate flag, keep the trader offline,
     * and let corp.js (which owns creation: free seed in BN3, otherwise $150e9 self-funded) do the creating.
     * @param {NS} ns
     * @param {Player} player
     * @param {number} stocksValue
     * @param {(baseScriptName: string, filter?: (value: ProcessInfo, index: number, array: ProcessInfo[]) => unknown) => ProcessInfo} findScript
     * @returns {Promise<boolean>} true if it acted this check */
    async function maybeStartCorporation(ns, player, stocksValue, findScript) {
        if (!(3 in unlockedSFs)) { // corp.js needs SF3 (BN3 counts as SF3 access); don't freeze stocks for nothing
            log_once(ns, 'INFO: Skipping corporation startup: no Source-File 3 (Corporation) access.', true);
            return false;
        }
        const hasCorp = ns.corporation.hasCorporation(); // 0 GB
        const corpRunning = !!findScript('corp.js');
        // Only ask canCreateCorporation while there is no corporation. Once one exists it returns "CorporationExists"
        // AND the game itself logs that into this script's tail (stable src/NetscriptFunctions/Corporation.ts:621, via
        // helpers.log), so the two calls below printed a line every single check. corporationPlan() restarts a dead
        // manager before it ever reads these, so "false" is the correct input once hasCorp.
        const canSeed = !hasCorp && ns.corporation.canCreateCorporation(false) === 'Success'; // 0 GB
        const canSelfFund = !hasCorp && ns.corporation.canCreateCorporation(true) === 'Success'; // 0 GB
        const plan = corporationPlan({
            corpRunning, hasCorp, funding: fundingCorporation,
            canSeed, canSelfFund, cash: player.money, stocks: stocksValue,
        });
        if (plan.unavailable) {
            log_once(ns, 'INFO: This BitNode cannot start a corporation (canCreateCorporation was not "Success") - skipping.', true);
            return false;
        }
        if (plan.liquidate) {
            fundingCorporation = true; // Set BEFORE any await: the trader must not restart mid-sale
            setStatus(ns, `Selling the stock portfolio to fund the corporation's ${formatMoney(CORPORATION_SELF_FUND_COST)} seed...`);
            log(ns, `INFO: Liquidating stocks for corporation startup (cash ${formatMoney(player.money)}, stocks ${formatMoney(stocksValue)})...`, true, 'info');
            const pid = launchScriptHelper(ns, 'stockmaster.js', ['--liquidate']); // Bare boolean flag - never `--liquidate true`
            if (pid) await waitForProcessToComplete(ns, pid, true); // Reuse the existing waiter; stockmaster exits when done
            else log(ns, 'ERROR: Could not launch stockmaster.js --liquidate; will retry next check.', true, 'error');
            return true;
        }
        if (!plan.launch) {
            // With a corporation up and its manager running the plan is also "do nothing", but that is not a
            // waiting-for-the-seed state - saying so every check just buried the real status line.
            if (!fundingCorporation && !hasCorp) // While funding, the status line above already explains the wait
                setStatus(ns, `Saving for a corporation: ${formatMoney(player.money)} cash + ${formatMoney(stocksValue)} stocks of ${formatMoney(CORPORATION_SELF_FUND_COST)}.`);
            return false;
        }
        // Re-read cash after a sale so we never start the corporation on stale numbers
        const cash = hasCorp ? player.money : (await getPlayerInfo(ns)).money; // RAM-dodged; already used by the main loop
        if (!hasCorp && !canSeed && cash < CORPORATION_SELF_FUND_COST) {
            setStatus(ns, `Corporation seed ${formatMoney(CORPORATION_SELF_FUND_COST)}: sold the portfolio for ${formatMoney(cash)}, waiting for income to close the gap.`);
            return false; // fundingCorporation stays true: no re-buying with the seed money
        }
        const pid = launchScriptHelper(ns, 'corp.js', []); // No args: corp.js.config.txt and its own defaults win
        if (!pid) {
            log(ns, 'WARNING: corp.js did not start (missing file or not enough free home RAM). The seed money stays held and ' +
                'stock trading stays paused; install it / free RAM, or kill autopilot.js to release it.', true, 'warning');
            return false;
        }
        fundingCorporation = false;
        setStatus(ns, `Corporation startup handed off to corp.js; resuming normal progression.`);
        return true;
    }

    /** Logic to ensure scripts are running to progress the BN
     * @param {NS} ns
     * @param {Player} player
     * @param {number} stocksValue */
    async function checkOnRunningScripts(ns, player, stocksValue) {
        if (lastScriptsCheck > Date.now() - options['interval-check-scripts']) return;
        lastScriptsCheck = Date.now();
        const runningScripts = await getRunningScripts(ns); // Cache the list of running scripts for the duration
        const findScript = /** @param {(value: ProcessInfo, index: number, array: ProcessInfo[]) => unknown} filter @returns {ProcessInfo} */
            (baseScriptName, filter = null) => findScriptHelper(baseScriptName, runningScripts, filter);

        // Kill any scripts that were flagged for restart
        while (killScripts.length > 0)
            await killScript(ns, killScripts.pop(), runningScripts);

        // See if home ram has improved. We hold back on launching certain scripts if we are low on home RAM
        homeRam = await getNsDataThroughFile(ns, `ns.getServerMaxRam(ns.args[0])`, null, ["home"]);

        // Release the stock trader as soon as a corporation exists, however it was created
        if (fundingCorporation && ns.corporation.hasCorporation()) fundingCorporation = false;

        // Start the corporation before other discretionary spending: sell the portfolio for the seed, then hand off
        // to corp.js (which owns creation: free seed in BN3, otherwise $150e9 self-funded).
        await maybeStartCorporation(ns, player, stocksValue, findScript);

        // Launch stock-master in a way that emphasizes it as our main source of income early-on
        // (but not while we are raising or holding the corporation's seed money)
        if (!findScript('stockmaster.js') && !disableStockmasterForDaedalus && !fundingCorporation && homeRam >= 32)
            launchScriptHelper(ns, 'stockmaster.js', [
                "--fracH", resetInfo.currentNode == 8 ? 0.001 : 0.1, // Fraction of wealth to keep as cash (10% - unless in BN8)
                "--reserve", 0, // Override to ignore the global reserve.txt. Any money we reserve can more or less safely live as stocks
            ]);

        // Launch sleeves and allow them to also ignore the reserve so they can train up to boost gang unlock speed
        if ((10 in unlockedSFs) && (2 in unlockedSFs) && !findScript('sleeve.js')) {
            let sleeveArgs = [];
            if (!options["disable-casino"] && !ranCasino)
                sleeveArgs.push("--training-reserve", 300000); // Avoid training away our casino seed money
            if (options["disable-bladeburner"])
                sleeveArgs.push("--disable-bladeburner");
            launchScriptHelper(ns, 'sleeve.js', sleeveArgs);
        }

        // Spend hacknet hashes on our boosting best hack-income server once established
        let existingSpendHashesProc = findScript('spend-hacknet-hashes.js', s => s.args.includes("--spend-on-server"))
        if ((9 in unlockedSFs) && getTimeInAug() >= options['time-before-boosting-best-hack-server']
            && 0 != bitNodeMults.ScriptHackMoney * bitNodeMults.ScriptHackMoneyGain) // No point in boosting hack income if it's scaled to 0 in the current BN
        {
            const strServerIncomeInfo = ns.read('/Temp/analyze-hack.txt');	// HACK: Steal this file that Daemon also relies on
            if (strServerIncomeInfo) {
                const incomeByServer = JSON.parse(strServerIncomeInfo);
                dictServerHackReqs ??= await getNsDataThroughFile(ns, 'Object.fromEntries(ns.args.map(server => [server, ns.getServerRequiredHackingLevel(server)]))',
                    '/Temp/getServerRequiredHackingLevel-all.txt', incomeByServer.map(s => s.hostname));
                const [bestServer, gain] = incomeByServer.filter(s => dictServerHackReqs[s.hostname] <= player.skills.hacking)
                    .reduce(([bestServer, bestIncome], target) => target.gainRate > bestIncome ? [target.hostname, target.gainRate] : [bestServer, bestIncome], [null, -1]);
                const spendHashesMultThreshold = options['spend-hashes-on-server-hacking-threshold'];
                // If hacking gain multipliers are too low, assume the bitnode is meant to be won a different way and don't bother wasting hashes on boosting hack income
                // The exception is that in BN9, despite high penalties, we're definitely meant to spend hashes to boost hack income
                if (bestServer && (gain > spendHashesMultThreshold || resetInfo.currentNode == 9)) {
                    // Check whether we should be spending hashes to reduce minimum security
                    const serverMinSecurity = await getNsDataThroughFile(ns, 'ns.getServerMinSecurityLevel(ns.args[0])', null, [bestServer]);
                    const shouldReduceMinSecurity = serverMinSecurity > 2; // Each purchase reduces by 2%. Can't go below 1, but not worth the cost to keep going below 2.
                    // If we were already spending hashes to boost a server, check to see if things have changed
                    if (existingSpendHashesProc) {
                        const currentBoostTarget = existingSpendHashesProc.args[1 + existingSpendHashesProc.args.indexOf("--spend-on-server")];
                        const isReducingSecurity = existingSpendHashesProc.args.includes("Reduce_Minimum_Security");
                        if (currentBoostTarget != bestServer || isReducingSecurity != shouldReduceMinSecurity) {
                            log(ns, `Killing a prior spend-hacknet-hashes.js process targetting ${currentBoostTarget} because ` +
                                (currentBoostTarget != bestServer ? `The new best income server is ${bestServer}.` : 'We no longer need to reduce minimum security.'), true);
                            await killScript(ns, 'spend-hacknet-hashes.js', null, existingSpendHashesProc);
                            existingSpendHashesProc = false;
                        }
                    }
                    if (!existingSpendHashesProc) { // 
                        log(ns, `Identified that the best hack income server is ${bestServer} worth ${formatMoney(gain)}/sec.`);
                        const spendHashesArgs = ["--liquidate", "--spend-on-server", bestServer, "--spend-on", "Increase_Maximum_Money"];
                        if (shouldReduceMinSecurity) spendHashesArgs.push("--spend-on", "Reduce_Minimum_Security");
                        launchScriptHelper(ns, 'spend-hacknet-hashes.js', spendHashesArgs);
                    }
                } else if (gain <= 1)
                    log_once(ns, `INFO: The best server (${bestServer})'s hack income multiplier (${formatNumber(gain)}) is currently too severely penalized ` +
                        `(< ${spendHashesMultThreshold}) to merit launching spend-hacknet-hashes.js to boost servers. (Configure with --spend-hashes-on-server-hacking-threshold)`);
                else
                    log(ns, `WARNING: strServerIncomeInfo was not empty, but could not determine best server:\n${strServerIncomeInfo}`);
            }
        }

        const existingDaemon = findScript('daemon.js');
        let daemonArgs = []; // The args we currently want deamon to have
        let daemonRelaunchMessage; // Will hold any special messages we want to show the user if relaunching daemon.

        // If daemon.js is already running in --looping-mode, we should not restart it, because
        // TODO: currently daemon.js has no ability to kill it's loops on shutdown (so the next instance will be stuck with no RAM available)
        if (existingDaemon?.args.includes("--looping-mode"))
            daemonArgs = existingDaemon.args;
        else {
            // Determine the arguments we want to run daemon.js with. We will either pass these directly, or through stanek.js if we're running it first.
            const hackThreshold = options['high-hack-threshold']; // If player.skills.hacking level is about 8000, tweak daemon to increase income rates
            // When our hack level gets sufficiently high, hack/grow/weaken go so fast that spawning new scripts for each cycle becomes very
            // expensive / laggy. To help with this, daemon.js supports "looping mode", to just spawn one long-lived script that does H/G/W in a loop.
            if (false /* TODO: LOOPING MODE DISABLED UNTIL WORKING BETTER */ && player.skills.hacking >= hackThreshold) {
                daemonArgs = ["--looping-mode", "--cycle-timing-delay", 40, "--queue-delay", 2000, "--initial-max-targets", 61, "--silent-misfires", "--no-share",
                    "--recovery-thread-padding", Math.min(5.0, player.skills.hacking / hackThreshold)]; // Use more recovery thread padding as our hack level increases
                // Log a special notice if we're going to be relaunching daemon.js for this reason
                if (!existingDaemon || !(existingDaemon.args.includes("--looping-mode")))
                    daemonRelaunchMessage = `Hack level (${player.skills.hacking}) is >= ${hackThreshold} (--high-hack-threshold): Starting daemon.js in high-performance hacking mode.`;
            } else if (player.skills.hacking >= hackThreshold) { // "tight" mode. Tighter batches to increase income rate, at the cost of more frequent misfires
                daemonArgs = ["--cycle-timing-delay", 40, "--queue-delay", 50, "--silent-misfires",
                    "--recovery-thread-padding", Math.min(5.0, player.skills.hacking / hackThreshold)]; // Use more recovery thread padding as our hack level increases
            }
            else if (homeRam < 32) { // If we're in early BN 1.1 (i.e. with < 32GB home RAM), avoid squandering RAM
                daemonArgs.push("--no-share", "--initial-max-targets", 1);
            } else { // XP-ONLY MODE: We can shift daemon.js to this when we want to prioritize earning hack exp rather than money
                // Only do this if we aren't in --looping mode because TODO: currently it does not kill it's loops on shutdown, so they'd be stuck in hack exp mode
                let useXpOnlyMode = prioritizeHackForDaedalus || prioritizeHackForWd ||
                    // In BNs that give no money for hacking, always start daemon.js in this mode (except BN8, because TODO: --xp-only doesn't handle stock manipulation)
                    (bitNodeMults.ScriptHackMoney * bitNodeMults.ScriptHackMoneyGain == 0 && resetInfo.currentNode != 8);
                if (!useXpOnlyMode) { // Otherwise, respect the configured interval / duration
                    const xpInterval = Number(options['xp-mode-interval-minutes']);
                    const xpDuration = Number(options['xp-mode-duration-minutes']);
                    const minutesInAug = getTimeInAug() / 60.0 / 1000.0;
                    if (xpInterval > 0 && xpDuration > 0 && (minutesInAug % (xpInterval + xpDuration)) <= xpDuration)
                        useXpOnlyMode = true; // We're in the time window where we should focus hack exp
                    // If daemon.js was previously running in hack exp mode, prepare a message indicating that we 're switching back
                    else if (existingDaemon?.args.includes("--xp-only"))
                        daemonRelaunchMessage = `Time is up for "xp-mode", Relaunching daemon.js normally to focus on earning money for ${xpInterval} minutes (--xp-mode-interval-minutes)`;
                }
                if (useXpOnlyMode) {
                    daemonArgs.push("--xp-only", "--silent-misfires", "--no-share");
                    // If daemon.js isn't already running in hack exp mode, prepare a message to communicate the change
                    if (!existingDaemon?.args.includes("--xp-only"))
                        daemonRelaunchMessage = prioritizeHackForWd ? `We're close to the required hack level destroy the BN.` :
                            prioritizeHackForDaedalus ? `Hack Level is the only missing requirement for Daedalus, so we will run daemon.js in --xp-only mode to try and speed along the invite.` :
                                (bitNodeMults.ScriptHackMoney * bitNodeMults.ScriptHackMoneyGain == 0) ?
                                    `The current BitNode does not give any money from hacking, so we will run daemon.js in --xp-only mode.` :
                                    `Relaunching daemon.js to focus on earning Hack Experience for ${options['xp-mode-duration-minutes']} minutes (--xp-mode-duration-minutes)`;
                }
            }
            // Prevent daemon from starting "work-for-faction.js" since we now manage that script
            daemonArgs.push('--disable-script', getFilePath('work-for-factions.js'));
            // Autopilot is the single owner of the stock trader, so it can hold the portfolio out of the way while
            // the corporation's seed is raised - same hand-off as work-for-factions right above.
            daemonArgs.push('--disable-script', getFilePath('stockmaster.js'));
            // In BN8, always run in a mode that prioritizes stock market manipulation
            if (resetInfo.currentNode == 8) daemonArgs.push("--stock-manipulation-focus");
            // Don't run the script to join and manage bladeburner if it is explicitly disabled
            if (options['disable-bladeburner']) daemonArgs.push('--disable-script', getFilePath('bladeburner.js'));
            // Relay the option to suppress tail windows
            if (options['no-tail-windows']) daemonArgs.push('--no-tail-windows');
        }

        // Once stanek's gift is accepted, launch it once per reset before we launch daemon (Note: stanek's gift is auto-purchased by faction-manager.js on your first install)
        let stanekRunning = (13 in unlockedSFs) && findScript('stanek.js') !== undefined;
        if ((13 in unlockedSFs) && !stanekLaunched && !stanekRunning && installedAugmentations.includes(augStanek)) {
            stanekLaunched = true; // Once we've know we've launched stanek once, we never have to again this reset.
            const stanekArgs = ["--on-completion-script", getFilePath('daemon.js')]
            if (options['no-tail-windows']) stanekArgs.push('--no-tail'); // Relay the option to suppress tail windows
            if (daemonArgs.length >= 0) stanekArgs.push("--on-completion-script-args", JSON.stringify(daemonArgs)); // Pass in all the args we wanted to run daemon.js with
            launchScriptHelper(ns, 'stanek.js', stanekArgs);
            stanekRunning = true;
        }
        // Reserve home RAM for whatever outranks hacking batches: stanek's gift (all of home), an early
        // SF4, or the running corporation (see CORP_HOME_RESERVE). Exactly one --reserved-ram, because
        // ns.flags is non-permissive and a duplicated flag has no defined winner.
        const reservedRam = reservedHomeRam({
            stanekRunning, sf4: unlockedSFs[4], corpRunning: !!findScript('corp.js') || ns.corporation.hasCorporation(),
        });
        if (reservedRam > 0) daemonArgs.push("--reserved-ram", reservedRam);

        // Launch (or re-launch) daemon if it is not already running with all our desired args.
        // Hack: Ignore numeric arguments in the comparison, since we e.g. tweak --recovery-thread-padding over time
        // - which is exactly why a CHANGED --reserved-ram needs its own explicit check (daemonRamReserveChanged).
        let launchDaemon = !existingDaemon || daemonRamReserveChanged(existingDaemon?.args, reservedRam) ||
            daemonArgs.some(arg => !existingDaemon.args.includes(arg) && !Number.isFinite(arg)) ||
            // Special cases: We also must relaunch daemon if it is running with certain flags we wish to remove
            (["--xp-only"].some(arg => !daemonArgs.includes(arg) && existingDaemon.args.includes(arg)))
        if (launchDaemon) {
            if (existingDaemon) {
                daemonRelaunchMessage ??= `Relaunching daemon.js with new arguments since the current instance doesn't include all the args we want.`;
                log(ns, daemonRelaunchMessage);
            }
            let daemonPid = launchScriptHelper(ns, 'daemon.js', daemonArgs);
            daemonStartTime = Date.now();
            // Open the tail window if it's the start of a new BN. Especially useful to new players.
            if (getTimeInBitnode() < 1000 * 60 * 5 || homeRam == 8) // First 5 minutes, or BN1.1 where we have 8GB ram
                tail(ns, daemonPid);
        }

        // Default work for faction args we think are ideal for speed-running BNs
        const workForFactionsArgs = [
            "--fast-crimes-only", // Essentially means we do mug until we can do homicide, then stick to homicide
            "--get-invited-to-every-faction" // Join factions even we have all their augs. Good for having NeuroFlux providers
        ];
        // Relay the options to suppress tail windows and ignore bladeburner
        if (options['no-tail-windows']) workForFactionsArgs.push('--no-tail-windows');
        if (options['disable-bladeburner']) workForFactionsArgs.push("--no-bladeburner-check")
        // The following args are ideal when running 'work-for-factions.js' to rush unlocking gangs (earn karma)
        const rushGangsArgs = workForFactionsArgs.concat(...[ // Everything above, plus...
            "--crime-focus", // Start off by trying to work for each of the crime factions (generally have combat reqs)
            "--training-stat-per-multi-threshold", 200, // Be willing to spend more time grinding for stats rather than skipping a faction
            "--prioritize-invites"]); // Don't actually start working for factions until we've earned as many invites as we think we can
        // If gangs are unlocked, micro-manage how 'work-for-factions.js' is running by killing off unwanted instances
        if (2 in unlockedSFs) {
            // Check if we've joined a gang yet. (Never have to check again once we know we're in one)
            if (!playerInGang) playerInGang = await getNsDataThroughFile(ns, 'ns.gang.inGang()');
            rushGang = !options['disable-rush-gangs'] && !playerInGang;
            // Detect if a 'work-for-factions.js' instance is running with args that don't match our goal. We aren't too picky,
            // (so the player can run with custom args), but should have --crime-focus if (and only if) we're still working towards a gang.
            const wrongWork = findScript('work-for-factions.js', !rushGang ? s => s.args.includes("--crime-focus") :
                s => !rushGangsArgs.every(a => s.args.includes(a))); // Require all rushGangsArgs if we're not in a gang yet.
            // If running with the wrong args, kill it so we can start it with the desired args
            if (wrongWork) await killScript(ns, 'work-for-factions.js', null, wrongWork);

            // Start gangs immediately (even though daemon would eventually start it) since we want any income they provide right away after an ascend
            // TODO: Consider monitoring gangs territory progress and increasing their budget / decreasing their reserve to help kick-start them
            if (playerInGang && !findScript('gangs.js'))
                launchScriptHelper(ns, 'gangs.js');
        }

        // Launch work-for-factions if it isn't already running (rules for maybe killing unproductive instances are above)
        // Note: We delay launching our own 'work-for-factions.js' until daemon has warmed up, so we don't steal it's "kickstartHackXp" study focus
        if ((4 in unlockedSFs) && !findScript('work-for-factions.js') && Date.now() - daemonStartTime > 30000) {
            // If we're trying to rush gangs, run in such a way that we will spend most of our time doing crime, reducing Karma (also okay early income)
            // NOTE: Default work-for-factions behaviour is to spend hashes on coding contracts, which suits us fine
            launchScriptHelper(ns, 'work-for-factions.js', rushGang ? rushGangsArgs : workForFactionsArgs);
        }
    }

    /** Get the source of the player's earnings by category.
     * @param {NS} ns
     * @returns {Promise<MoneySources>} */
    async function getPlayerMoneySources(ns) {
        return await getNsDataThroughFile(ns, 'ns.getMoneySources()');
    }

    /** Accept Stanek's gift immediately at the start of the BN (as opposed to just before the first install)
     * if it looks like it will scale well.
     * @param {NS} ns
     * @param {Player} player */
    async function maybeAcceptStaneksGift(ns, player) {
        // Look for any reason not to accept stanek's gift (do the quickest checks first)
        if (acceptedStanek) return;
        // Don't get Stanek's gift too early if its size is reduced in this BN
        if (bitNodeMults.StaneksGiftExtraSize < 0) return;
        // If Stanek's gift size isn't reduced, but is penalized, don't get it too early 
        if (bitNodeMults.StaneksGiftExtraSize == 0 && bitNodeMults.StaneksGiftPowerMultiplier < 1) return;
        // Otherwise, it is not penalized in any way, it's probably safe to get it immediately despite the 10% penalty to all stats
        // If we won't have access to Stanek yet, skip this
        if (!(13 in unlockedSFs)) return;
        // If we've already accepted Stanek's gift (Genesis aug is installed), skip
        if (installedAugmentations.includes(augStanek)) return acceptedStanek = true;
        // If we have more than Neuroflux (aug) installed, we won't be allowed to accept the gift (but we can try)
        if (installedAugmentations.length > 1)
            log(ns, `WARNING: We think it's a good idea to accept Stanek's Gift, but it appears to be too late - other augmentations have been installed. Trying Anyway...`);
        // Use the API to accept Stanek's gift
        if (await getNsDataThroughFile(ns, 'ns.stanek.acceptGift()')) {
            log(ns, `SUCCESS: Accepted Stanek's Gift!`, true, 'success');
            installedAugmentations.push(augStanek); // Manually add Genesis to installed augmentations so checkOnRunningScripts picks up on the change.
        } else
            log(ns, `WARNING: autopilot.js tried to accepted Stanek's Gift, but was denied.`, true, 'warning');
        // Whether we succeded or failed, don't try again - if we're denied entry (due to having an augmentation) we will never be allowed in
        acceptedStanek = true;
    }

    /** Logic to steal 10b from the casino
     * @param {NS} ns
     * @param {Player} player */
    async function maybeDoCasino(ns, player) {
        if (ranCasino || options['disable-casino']) return;
        // Figure out whether we've already been kicked out of the casino for earning more than 10b there
        const moneySources = await getPlayerMoneySources(ns);
        const casinoEarnings = moneySources.sinceInstall.casino;
        if (casinoEarnings >= 1e10) {
            log(ns, `INFO: Skipping running casino.js, as we've previously earned ${formatMoney(casinoEarnings)} and been kicked out.`);
            return ranCasino = true;
        }
        // If we already have more than 1t money but hadn't run casino.js yet, don't bother. Another 10b won't move the needle much.
        const playerWealth = player.money + (await getStocksValue(ns));
        if (playerWealth >= 1e12) {
            log(ns, `INFO: Skipping running casino.js, since we're already ridiculously wealthy (${formatMoney(playerWealth)} > 1t).`);
            return ranCasino = true;
        }

        // If we're making more than ~5b / minute from the start of the BN, there's no need to run casino.
        // In BN8 this is impossible, so in that case we don't even check and head straight to the casino.
        if (resetInfo.currentNode != 8) {
            // If we've been in the BN for less than 1 minute, wait a while to establish player's income rate 
            if (getTimeInAug() < 60000)
                return log_once(ns, `INFO: Waiting a minute to establish player income before deciding whether casino.js is needed.`);
            // Since it's possible that the CashRoot Startker Kit could give a false income velocity, account for that.
            const cashRootBought = installedAugmentations.includes(`CashRoot Starter Kit`);
            const incomePerMs = (playerWealth - (cashRootBought ? 1e6 : 0)) / getTimeInAug();
            const incomePerMinute = incomePerMs * 60_000;
            if (incomePerMinute >= 5e9) {
                log(ns, `INFO: Skipping running casino.js this augmentation, since our income (${formatMoney(incomePerMinute)}/min) >= 5b/min`);
                return ranCasino = true;
            }
        }

        // If we aren't in Aevum already, wait until we have the 200K required to travel (plus some extra buffer to actually spend at the casino)
        if (player.city != "Aevum" && player.money < 300000)
            return log_once(ns, `INFO: Waiting until we have ${formatMoney(300000)} to travel to Aevum and run casino.js`);

        // Run casino.js (and expect this script to get killed in the process)
        // Make sure "work-for-factions.js" is dead first, lest it steal focus and break the casino script before it has a chance to kill all scripts.
        await killScript(ns, 'work-for-factions.js');
        await killScript(ns, 'daemon.js'); // We also have to kill daemon which can make us study.
        // Kill any action, in case we are studying or working out, as it might steal focus or funds before we can bet it at the casino.
        if (4 in unlockedSFs) // No big deal if we can't, casino.js has logic to find the stop button and click it.
            _ = await getNsDataThroughFile(ns, `ns.singularity.stopAction()`);

        const pid = launchScriptHelper(ns, 'casino.js', ['--kill-all-scripts', true, '--on-completion-script', ns.getScriptName()]);
        if (pid) {
            await waitForProcessToComplete(ns, pid);
            await ns.sleep(10000); // Give time for this script to be killed if the game is being restarted by casino.js
            // Otherwise, something went wrong
            log(ns, `ERROR: Something went wrong. casino.js was run, but we haven't been killed. It must have run into a problem...`)
        }
    }

    /** Retrieves the last faction manager output file, parses, and provides type-hints for it.
     * @returns {{ installed_augs: string[], installed_count: number, installed_count_nf: number, installed_count_ex_nf: number,
     *             owned_augs: string[], owned_count: number, owned_count_nf: number, owned_count_ex_nf: number,
     *             awaiting_install_augs: string[], awaiting_install_count: number, awaiting_install_count_nf: number, awaiting_install_count_ex_nf: number,
     *             affordable_augs: string[], affordable_count: number, affordable_count_nf: number, affordable_count_ex_nf: number,
     *             total_rep_cost: number, total_aug_cost: number, unowned_count: number }} */
    function getFactionManagerOutput(ns) {
        const facmanOutput = ns.read(factionManagerOutputFile)
        return !facmanOutput ? null : JSON.parse(facmanOutput)
    }

    /** Logic to detect if it's a good time to install augmentations, and if so, do so
     * @param {NS} ns
     * @param {Player} player */
    async function maybeInstallAugmentations(ns, player) {
        if (!(4 in unlockedSFs))  // Cannot automate augmentations or installs without singularity
            return setStatus(ns, `No singularity access, so you're on your own. You should manually work for factions and install augmentations!`);

        // If we previously attempted to reserve money for an augmentation purchase order, do a fresh facman run to ensure it's still available
        if (reservedPurchase && installCountdown <= Date.now()) {
            log(ns, "INFO: Manually running faction-manager.js to ensure previously reserved purchase is still obtainable.");
            ns.write(factionManagerOutputFile, "", "w"); // Reset the output file to ensure it isn't stale
            const pid = launchScriptHelper(ns, 'faction-manager.js');
            await waitForProcessToComplete(ns, pid, true); // Wait for the script to shut down (and output to be generated)
        }

        // Grab the latest output from faction manager to see if it's a good time to reset
        const facman = getFactionManagerOutput(ns);
        if (!facman) {
            setStatus(ns, `Faction manager output not available. Will try again later.`);
            return reservedPurchase = 0;
        }
        playerInstalledAugCount = facman.installed_count; // Augmentations bought *and installed* by the player (used for Daedalus requirement)

        // If we're in BN9 (where hacknet is most important) and we're still on our first reset (where we have an upgraded hacknet node), resist installing
        const inFirstBn9Aug = resetInfo.currentNode == 9 && Math.abs(resetInfo.lastNodeReset - resetInfo.lastAugReset) < 1000;

        // Reduce the augmentations required to reset over time, except in cetain situations. This is because in most situations,
        // pefoming an ascention in a slow-going BN will let us lock in bonuses that will speed up overall pogression.
        let reducedAugReq = Math.floor(options['reduced-aug-requirement-per-hour'] * getTimeInAug() / 3.6E6);
        // In our first BN9 augmentation and in BN8, use this mechanic to actually *increase* aug count requirements.
        if (inFirstBn9Aug || resetInfo.currentNode == 8) // In BN8, no reset bonuses are possible, and we'd lose our stock progress
            reducedAugReq = -2; // In our first BN9 augmentation, delay resetting as we'd lose our boosted hacknet server
        // Collect additional information about how many augmentations we need before it's worth resetting, based on the current configuration
        const sf11Level = dictOwnedSourceFiles[11] ?? 0; // SF11 makes augs scale cheaper, so for each level, require +1 augs
        const augsNeeded = Math.max(1, options['install-at-aug-count'] + sf11Level - reducedAugReq);
        const augsNeededInclNf = Math.max(1, options['install-at-aug-plus-nf-count'] + sf11Level - reducedAugReq);

        // Get a count of pending augmentations (augs we plan to buy, plus any we've bought but not yet installed)
        const pendingAugCount = facman.affordable_count_ex_nf + facman.awaiting_install_count_ex_nf; // Excludes neuroflux levels
        const pendingNfCount = facman.affordable_count_nf + facman.awaiting_install_count_nf; // Only neuroflux levels
        const pendingAugInclNfCount = pendingAugCount + pendingNfCount; // Includes neuroflux levels
        // Create a list of augmentations pending install or pending puchase to display. Group all nf augs into one.
        const strNF = "NeuroFlux Governor"
        let augsToInstall = facman.awaiting_install_augs.filter(aug => aug != strNF)
            .concat(...facman.affordable_augs.filter(aug => aug != strNF));
        if (pendingNfCount > 0)
            augsToInstall.push(`${strNF} (x${pendingNfCount})`)

        // Determine whether we can afford enough augmentations to merit a reset
        let totalCost = facman.total_rep_cost + facman.total_aug_cost;
        const augSummary = `${pendingAugCount} of ${facman.unpurchased_count - 1} remaining augmentations` + // Unowned - 1 because we can always buy more Neuroflux
            (pendingNfCount > 0 ? ` + ${pendingNfCount} levels of NeuroFlux.` : '.') +
            (pendingAugCount > 0 ? `\n    Augs: [\"${augsToInstall.join("\", \"")}\"]` : '');
        let resetStatus = `Reserving ${formatMoney(totalCost)} to install ${augSummary}`
        let shouldReset = options['install-for-augs'].some(a => facman.affordable_augs.includes(a)) ||
            pendingAugCount >= augsNeeded || pendingAugInclNfCount >= augsNeededInclNf;

        // If we are in Daedalus, and we do not yet have enough favour to unlock rep donations with Daedalus,
        // but we DO have enough rep to earn that favor on our next restart, trigger an install immediately (need at least 1 aug)
        // (doesn't apply in BN8, since we can immediately donate to all factions)
        if (
            player.factions.includes("Daedalus") &&
            bitNodeMults.FavorToDonateToFaction !== 0 &&
            ns.read("/Temp/Daedalus-donation-rep-attained.txt")
        ) {
            shouldReset = true;
            resetStatus = `We have enough reputation with Daedalus to unlock donations on our next reset.\n${resetStatus}`;
            if (totalCost == 0) totalCost = 1; // Hack, logic below expects some non-zero reserve in preparation for ascending.
        }

        // Heuristic: if we can afford 4 or more augs in the first ~20 minutes, it's usually worth doing a "quick install"
        // For example, in BN8, we get a big cash influx on each reset and can buy reputation immediately, so it's worth
        //     doing an few immediate installs to purchase upgrades, then reset for more free cash.
        // When in a gang, require a more augs and don't countdown as quickly, since each reset reduces gang member ascention multipliers
        const quickInstallThreshold = playerInGang ? 6 : 4;
        if (!inFirstBn9Aug && (
            (getTimeInAug() < 20 * 60 * 1000 && pendingAugInclNfCount >= quickInstallThreshold) ||
            // Heuristic: In BN8, reinstall repeatedly for the first 10 minutes to purchase every little thing we can with our flat 10B casino winnings
            (resetInfo.currentNode == 8 && getTimeInBitnode() < 10 * 60 * 1000))) {
            shouldReset = true;
            resetStatus = `We haven't been in this reset for long. We can do a quick reset immediately for a quick stat boost.\n${resetStatus}`;
            if (options['install-countdown'] > 30 * 1000 && !playerInGang)
                options['install-countdown'] = 30 * 1000; // Install relatively quickly in this scenario (30s)
        }

        // If not ready to reset, set a status with our progress and return
        if (!shouldReset) {
            setStatus(ns, `Currently at ${formatDuration(getTimeInAug())} since last aug. ` +
                `Waiting for ${augsNeeded} new augs (or ${augsNeededInclNf} including NeuroFlux levels) before installing.` +
                `\nCan currently get: ${augSummary}` + (pendingAugCount == 0 ? '' : `\n  Total Cost: ${formatMoney(totalCost)}`) +
                ` (\`run faction-manager.js\` for details)`, augSummary);
            return reservedPurchase = 0; // If we were previously reserving money for a purchase, reset that flag now
        }
        // If we want to reset, but there is a reason to delay, don't reset
        if (await shouldDelayInstall(ns, player, facman)) // If we're currently in a state where we should not be resetting, skip reset logic
            return reservedPurchase = 0;

        // Ensure the money needed for the above augs doesn't get ripped out from under us by reserving it
        if (reservedPurchase < totalCost) {
            // A countdown is displayed to give the user a heads up, and give us time to potentially earn money for more augmentations
            if (reservedPurchase == 0)
                installCountdown = Date.now() + options['install-countdown'];
            else { // If we were already reserving for a purchase and the number went up, log a notice of the timer being reset.
                let purchaseChangeLog = `INFO: The augmentation purchase we can afford has increased from ${formatMoney(reservedPurchase)} to ${formatMoney(totalCost)}.`
                // First, check if we're ready to install TRP - if so, don't delay the install for any additional augmentations.
                if (!augsToInstall.includes(augTRP)) {
                    // Otherwise, each time we can afford more augs, reset the install delay timer to take advantage of "momentum"
                    // and potentially purchase many more augmentations in this reset. To avoid delaying an install indefinitely,
                    // we reduce the additional time we're willing to wait a little bit each time this happens.
                    installCountdownResets++;
                    const newCountDown = Date.now() + Math.max(10 * 1000, // At a bare minimum, wait 10 more seconds
                        // Heuristic: Linearly reduce the cooldown until we have doubled the aug count needed.
                        options['install-countdown'] * (1 - (installCountdownResets / augsNeededInclNf)));
                    if (newCountDown > installCountdown) { // If the existing countdown remaining was longer than this, leave it be
                        installCountdown = newCountDown;
                        purchaseChangeLog = purchaseChangeLog + ' Resetting the timer before we install augmentations.'
                    }
                }
                log(ns, purchaseChangeLog, true);
            }
            ns.write("reserve.txt", totalCost, "w"); // Should prevent other scripts from spending this money
        }
        // We must wait until the configured cooldown elapses before we install augs.
        if (installCountdown > Date.now()) {
            resetStatus += `\n  Waiting for ${formatDuration(options['install-countdown'])} (--install-countdown) ` +
                `to elapse before we install, in case we're close to being able to purchase more augmentations...`;
            setStatus(ns, resetStatus);
            ns.toast(`Heads up: Autopilot plans to reset in ${formatDuration(installCountdown - Date.now())}`, 'info');
            return reservedPurchase = totalCost;
        }

        // Otherwise, we've got the money reserved, we can afford the augs, we should be confident to ascend
        const resetLog = `  Invoking ascend.js at ${formatDuration(getTimeInAug()).padEnd(11)} since last aug to install: ${augSummary}`;
        persist_log(ns, log(ns, resetLog, true, 'info'));

        // Kick off ascend.js
        let errLog;
        const ascendArgs = ['--install-augmentations', true, '--on-reset-script', ns.getScriptName()]
        if (pendingAugInclNfCount == 0) // If we know we would install 0 augs, but still wish to reset, we must enable soft resetting
            ascendArgs.push("--allow-soft-reset")
        let pid = launchScriptHelper(ns, 'ascend.js', ascendArgs);
        if (pid) {
            await waitForProcessToComplete(ns, pid, true); // Wait for the script to shut down (Ascend should get killed as it does, since the BN will be rebooting)
            await ns.sleep(1000); // If we've been scheduled to be killed, awaiting an NS function should trigger it?
            errLog = `ERROR: ascend.js ran, but we're still here. Something must have gone wrong. Will try again later`;
        } else
            errLog = `ERROR: Failed to launch ascend.js (pid == 0). Will try again later`;
        // If we got this far, something went wrong
        persist_log(ns, log(ns, errLog, true, 'error'));
    }

    /** Logic to detect if we are close to a milestone and should postpone installing augmentations until it is hit
     * @param {NS} ns
     * @param {Player} player
     * @param {{ installed_augs: string[], installed_count: number, installed_count_nf: number, installed_count_ex_nf: number,
     *           owned_augs: string[], owned_count: number, owned_count_nf: number, owned_count_ex_nf: number,
     *           awaiting_install_augs: string[], awaiting_install_count: number, awaiting_install_count_nf: number, awaiting_install_count_ex_nf: number,
     *           affordable_augs: string[], affordable_count: number, affordable_count_nf: number, affordable_count_ex_nf: number,
     *           total_rep_cost: number, total_aug_cost: number, unowned_count: number }} facmanOutput
    */
    async function shouldDelayInstall(ns, player, facmanOutput) {
        // Don't install if we're currently grafting an augmentation
        if (await checkIfGrafting(ns))
            return true;
        // Are we close to being able to afford 4S TIX data?
        if (!have4STixApi) have4STixApi = await getNsDataThroughFile(ns, `ns.stock.has4SDataTixApi()`);
        if (!options['disable-wait-for-4s'] && !have4STixApi) {
            if (!have4SData) have4SData = await getNsDataThroughFile(ns, `ns.stock.has4SData()`);
            const totalWorth = player.money + await getStocksValue(ns);
            const totalCost = 25E9 * bitNodeMults.FourSigmaMarketDataApiCost +
                (have4SData ? 0 : 1E9 * bitNodeMults.FourSigmaMarketDataCost);
            const ratio = totalWorth / totalCost;
            // If we're e.g. 50% of the way there, hold off, regardless of the '--wait-for-4s' setting
            // TODO: If ratio is > 1, we can afford it - but stockmaster won't buy until it has e.g. 20% more than the cost
            //       (so it still has money to invest). It doesn't know we want to restart ASAP. Perhaps we should purchase ourselves?
            if (ratio >= options['wait-for-4s-threshold']) {
                setStatus(ns, `Not installing until scripts purchase the 4SDataTixApi because we have ` +
                    `${(100 * totalWorth / totalCost).toFixed(0)}% of the cost (controlled by --wait-for-4s-threshold)`);
                return true;
            }
        }
        if (resetInfo.currentNode == 8) { // Many special rules for this special Bitnode
            if (player.factions.includes("Daedalus")) { // If we've already joined Daedalus
                // In BN8, large sums of money are hard to accumulate, so if we've made it into Daedalus, but can't purchase TRP rep yet,
                // remain in the BN until we have enough rep and/or money to buy TRP (Reminder: in BN8, donations are immediately unlocked for all factions)    
                if (!installedAugmentations.includes(augTRP) && !facmanOutput.affordable_augs.includes(augTRP) && !facmanOutput.awaiting_install_augs.includes(augTRP)) {
                    setStatus(ns, `We're in Daedalus, so we won't install until we can afford to purchase "${augTRP}".`);
                    return true;
                }
            } else if (playerInstalledAugCount >= bitNodeMults.DaedalusAugsRequirement && player.skills.hacking >= (2500 * 0.9)) {
                // If we meet the Daedalus aug count requirement and at least 90% of the required hack level, wait to earn the invite
                setStatus(ns, `Not installing because we're in BN8 and we have enough augs and ` + (player.skills.hacking < 2500 ? 'nearly ' : '')
                    + 'enough hack level to get invited to Daedalus once we hit $100b.');
                return true;
            } else if (getTimeInAug() > 4 * 60 * 60 * 1000) { // 4 hours = 4hrs/min * 60mins/sec * 60secs/ms * 1000ms
                // If we've been in BN8 for more than 4 hours, we shouldn't reset unless we're making significant progress towards unlocking Daedalus.
                // because it takes so long to build up money, and nothing we install will accellerate our earnings in the next augmentation.
                const augsReadyToInstall = facmanOutput.awaiting_install_count_ex_nf + facmanOutput.affordable_count_ex_nf;
                if (augsReadyToInstall < 10) { // Heuristic: 10 augs per install means max 3 installs before we meet the Daedalus aug requirement
                    setStatus(ns, `Not installing because we've in BN8 for more than 4 hours (~${Math.round(getTimeInAug() / 1000 / 60 / 60)}h) and aren't in Daedalus yet, ` +
                        `so our threshold is at least 10 new augs installed to merit resetting (currently at ${augsReadyToInstall}).`);
                    return true;
                }
            }
        }
        // If we're reserving money because we're close to getting an invite to Daedalus don't reset.
        if (reservingMoneyForDaedalus) {
            setStatus(ns, `Not installing since we are close to earning an invite from Daedalus.`);
            return true;
        }

        // In BN10, it takes a while to build up the 100q needed to purchase the last sleeve, so don't reset if we're close
        if (resetInfo.currentNode == 10 && player.money >= 10e15 && !sleevesMaxedOut) { // Heuristic: If we hit 10q (10% the cost of the last sleeve) before an install, we can probably go all the way
            setStatus(ns, `Not installing anymore since we are nearing the 100q needed to purchase the 6th sleeve from the Covenant.`);
            return true;
        }

        // TODO: Bladeburner black-op in progress
        // TODO: Close to the rep needed for unlocking donations with a new faction?
        return false;
    }

    let wasGrafting = false;

    /** Checks if we are current grafting. If so, certain actions should not be taken.
     * @param {NS} ns
     * @returns {bool} true if the player is grafting, false otherwise. */
    async function checkIfGrafting(ns) {
        let currentWork = (/**@returns{Task|null}*/() => null)();
        currentWork = await getNsDataThroughFile(ns, 'ns.singularity.getCurrentWork()');
        // Never interrupt grafting
        if (currentWork?.type == "GRAFTING") {
            if (!wasGrafting) // Only log the first time we detect we've started grafting
                log(ns, "Grafting in progress. autopilot.js will make sure to not install augmentations or otherwise interrupt it.");
            return wasGrafting = true;
        }
        else
            return wasGrafting = false
    }

    /** Consolidated logic for all the times we want to reserve money
     * @param {NS} ns
     * @param {Player} player */
    function manageReservedMoney(ns, player, stocksValue) {
        if (reservedPurchase) return; // Do not mess with money reserved for installing augmentations
        const currentReserve = Number(ns.read("reserve.txt") || 0);
        if (reservingMoneyForDaedalus) // Reserve 100b to get the daedalus invite
            return currentReserve == 100E9 ? true : ns.write("reserve.txt", 100E9, "w");
        // Otherwise, reserve money for stocks for a while, as it's our main source of income early in the BN
        // It also acts as a decent way to save up for augmentations
        const minStockValue = 8E9; // At a minimum 8 of the 10 billion earned from the casino must be reserved for buying stock
        // As we earn more money, reserve a percentage of it for further investing in stock. Decrease this as the BN progresses.
        const minStockPercent = Math.max(0, 0.8 - 0.1 * getTimeInBitnode() / 3.6E6); // Reduce by 10% per hour in the BN
        const reserveCap = 1E12; // As we start start to earn crazy money, we will hit the stock market cap, so cap the maximum reserve
        // Dynamically update reserved cash based on how much money is already converted to stocks.
        const reserve = Math.min(reserveCap, Math.max(0, player.money * minStockPercent, minStockValue - stocksValue));
        return currentReserve == reserve ? true : ns.write("reserve.txt", reserve, "w"); // Reserve for stocks
        // NOTE: After several iterations, I decided that the above is actually best to keep in all scenarios:
        // - Casino.js ignores the reserve, so the above takes care of ensuring our casino seed money isn't spent
        // - In low-income situations, stockmaster will be our best source of income. We invoke it such that it ignores
        //	 the global reserve, so this 8B is for stocks only. The 2B remaining is plenty to kickstart the rest.
        // - Once high-hack/gang income is achieved, this 8B will not be missed anyway.
        /*
        if(!ranCasino) {
            ns.write("reserve.txt", 300000, "w"); // Prevent other scripts from spending our casino seed money
            return moneyReserved = true;
        }
        // Otherwise, clear any reserve we previously had
        if(moneyReserved) ns.write("reserve.txt", 0, "w"); // Remove the casino reserve we would have placed
        return moneyReserved = false;
        */
    }

    /** Logic to determine whether we should keep running, or shut down autopilot.js for some reason.
     * @param {NS} ns
     * @returns {boolean} true if we should keep running. False if we should shut down this script. */
    function shouldWeKeepRunning(ns) {
        if (4 in unlockedSFs)
            return true; // If we have SF4 - run always
        // If we've gotten daemon.js launched, but only have 8GB ram, we must shut down for now
        if (homeRam == 8 && daemonStartTime > 0) {
            log(ns, `WARN: (not an actual warning, just trying to make this message stand out.)` +
                `\n` + '-'.repeat(100) +
                `\n\n  Welcome to bitburner and thanks for using my scripts!` +
                `\n\n  Currently, your available RAM on home (8 GB) is too small to keep autopilot.js running.` +
                `\n  The priority should just be to run "daemon.js" for a while until you have enough money to` +
                `\n  purchase some home RAM (which you must do manually at a store like [alpha ent.] in the city),` +
                `\n\n  Once you have more home ram, feel free to 'run ${ns.getScriptName()}' again!` +
                `\n\n` + '-'.repeat(100), true);
            return false; // Daemon.js needs more room to breath
        }
        // Otherwise, keep running
        return true;
    }

    /** Helper to launch a script and log whether if it succeeded or failed
     * @param {NS} ns */
    function launchScriptHelper(ns, baseScriptName, args = [], convertFileName = true) {
        if (!options['no-tail-windows'])
            tail(ns); // If we're going to be launching scripts, show our tail window so that we can easily be killed if the user wants to interrupt.
        let pid, err;
        try { pid = ns.run(convertFileName ? getFilePath(baseScriptName) : baseScriptName, 1, ...args); }
        catch (e) { err = e; }
        if (pid)
            log(ns, `INFO: Launched ${baseScriptName} (pid: ${pid}) with args: [${args.join(", ")}]`, true);
        else
            log(ns, `ERROR: Failed to launch ${baseScriptName} with args: [${args.join(", ")}]` +
                (err ? `\nCaught: ${getErrorInfo(err)}` : ''), true, 'error');
        return pid;
    }

    let lastStatusLog = ""; // The current or last-assigned long-term status (what this script is waiting to happen)

    /** Helper to set a global status and print it if it changes
     * @param {NS} ns */
    function setStatus(ns, status, uniquePart = null) {
        uniquePart = uniquePart || status; // Can be used to consider a logs "the same" (not worth re-printing) even if they have some different text
        if (lastStatusLog == uniquePart) return;
        lastStatusLog = uniquePart
        log(ns, status);
    }

    /** Append the specified text (with timestamp) to a persistent log in the home directory
     * @param {NS} ns */
    function persist_log(ns, text) {
        ns.write(persistentLog, `${(new Date()).toISOString().substring(0, 19)} ${text}\n`, "a")
    }

    let logged_once = new Set();
    /** Helper to log a message, but only the first time it is encountered.
     * @param {NS} ns
     * @param {string} message The message to log, only if it hasn't been previously logged. 
     * @param {boolean} alsoPrintToTerminal Set to true to print not only to the current script's tail file, but to the terminal
     * @param {""|"success"|"warning"|"error"|"info"} toastStyle - If specified, your log will will also become a toast notification */
    function log_once(ns, message, alsoPrintToTerminal, toastStyle) {
        if (logged_once.has(message))
            return;
        logged_once.add(log(ns, message, alsoPrintToTerminal, toastStyle));
    }

    // Invoke the main function
    await main_start(ns);
}