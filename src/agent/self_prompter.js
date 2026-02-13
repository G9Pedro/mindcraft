import * as world from './library/world.js';
import settings from './settings.js';

const STOPPED = 0;
const ACTIVE = 1;
const PAUSED = 2;

const FOOD_ITEM_NAMES = [
    'apple',
    'baked_potato',
    'beetroot_soup',
    'bread',
    'cake',
    'carrot',
    'cooked_beef',
    'cooked_chicken',
    'cooked_cod',
    'cooked_mutton',
    'cooked_porkchop',
    'cooked_rabbit',
    'cooked_salmon',
    'dried_kelp',
    'golden_carrot',
    'melon_slice',
    'mushroom_stew',
    'potato',
    'pumpkin_pie',
    'rabbit_stew',
    'suspicious_stew'
];

const DEFAULT_INFINITE_GOAL_POOL = [
    'Build and organize a safe base with storage, furnaces, and a bed.',
    'Upgrade to a full set of iron tools and armor, then stock backups.',
    'Create a sustainable food pipeline (farm, animals, or fishing).',
    'Map nearby biomes and collect diverse resource blocks.',
    'Set up a villager trading route and collect emeralds efficiently.',
    'Prepare for Nether exploration with spare gear and food.',
    'Gather enchanting resources and improve combat/survival loadout.',
    'Automate repetitive gathering tasks and keep inventory tidy.'
];

const DEFAULT_AUTONOMY_CONFIG = Object.freeze({
    cooldown_ms: 2000,
    max_commands_per_cycle: 1,
    max_no_command_cycles: 4,
    max_stalled_cycles: 6,
    rotate_subgoal_every_ms: 180000,
    inject_stats_every_ms: 45000,
    checkpoint_every_cycles: 12,
    auto_start_infinite_goal: true,
    default_infinite_goal: 'Survive, improve gear, and progress forever with no final endpoint.',
    infinite_goal_pool: DEFAULT_INFINITE_GOAL_POOL
});

function normalizeGoal(text, fallback = '') {
    if (typeof text === 'string' && text.trim().length > 0) {
        return text.trim();
    }
    if (typeof fallback === 'string' && fallback.trim().length > 0) {
        return fallback.trim();
    }
    return '';
}

function getItemCount(inventory, names) {
    let total = 0;
    for (const name of names) {
        total += inventory[name] || 0;
    }
    return total;
}

function getMatchingCount(inventory, predicate) {
    let total = 0;
    for (const [name, count] of Object.entries(inventory)) {
        if (predicate(name)) {
            total += count;
        }
    }
    return total;
}

function hasAnyItem(inventory, names) {
    return names.some((name) => (inventory[name] || 0) > 0);
}

function getFoodCount(inventory) {
    return getItemCount(inventory, FOOD_ITEM_NAMES);
}

function toSafeInteger(value, fallback, min = 0) {
    const parsed = Number.parseInt(value);
    if (Number.isNaN(parsed)) {
        return fallback;
    }
    return Math.max(min, parsed);
}

function toSafeBool(value, fallback = false) {
    if (typeof value === 'boolean') {
        return value;
    }
    return fallback;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatPos(pos) {
    if (!pos) {
        return 'unknown';
    }
    return `${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}`;
}

function inventorySignature(inventory) {
    return Object.entries(inventory)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, count]) => `${name}:${count}`)
        .join('|');
}

function normalizeAutonomyConfig(rawConfig) {
    const merged = {
        ...DEFAULT_AUTONOMY_CONFIG,
        infinite_goal_pool: [...DEFAULT_AUTONOMY_CONFIG.infinite_goal_pool]
    };
    if (rawConfig && typeof rawConfig === 'object') {
        for (const [key, value] of Object.entries(rawConfig)) {
            merged[key] = value;
        }
    }
    merged.cooldown_ms = toSafeInteger(merged.cooldown_ms, DEFAULT_AUTONOMY_CONFIG.cooldown_ms, 250);
    merged.max_commands_per_cycle = toSafeInteger(merged.max_commands_per_cycle, DEFAULT_AUTONOMY_CONFIG.max_commands_per_cycle, 1);
    merged.max_no_command_cycles = toSafeInteger(merged.max_no_command_cycles, DEFAULT_AUTONOMY_CONFIG.max_no_command_cycles, 1);
    merged.max_stalled_cycles = toSafeInteger(merged.max_stalled_cycles, DEFAULT_AUTONOMY_CONFIG.max_stalled_cycles, 1);
    merged.rotate_subgoal_every_ms = toSafeInteger(merged.rotate_subgoal_every_ms, DEFAULT_AUTONOMY_CONFIG.rotate_subgoal_every_ms, 10000);
    merged.inject_stats_every_ms = toSafeInteger(merged.inject_stats_every_ms, DEFAULT_AUTONOMY_CONFIG.inject_stats_every_ms, 5000);
    merged.checkpoint_every_cycles = toSafeInteger(merged.checkpoint_every_cycles, DEFAULT_AUTONOMY_CONFIG.checkpoint_every_cycles, 1);
    merged.auto_start_infinite_goal = toSafeBool(merged.auto_start_infinite_goal, DEFAULT_AUTONOMY_CONFIG.auto_start_infinite_goal);
    merged.default_infinite_goal = normalizeGoal(merged.default_infinite_goal, DEFAULT_AUTONOMY_CONFIG.default_infinite_goal);
    if (!Array.isArray(merged.infinite_goal_pool) || merged.infinite_goal_pool.length === 0) {
        merged.infinite_goal_pool = [...DEFAULT_AUTONOMY_CONFIG.infinite_goal_pool];
    } else {
        merged.infinite_goal_pool = merged.infinite_goal_pool
            .map((goal) => normalizeGoal(goal))
            .filter((goal) => goal.length > 0);
        if (merged.infinite_goal_pool.length === 0) {
            merged.infinite_goal_pool = [...DEFAULT_AUTONOMY_CONFIG.infinite_goal_pool];
        }
    }
    return merged;
}

export class SelfPrompter {
    constructor(agent) {
        this.agent = agent;
        this.config = normalizeAutonomyConfig(settings.autonomy);

        this.state = STOPPED;
        this.loop_active = false;
        this.interrupt = false;
        this.idle_time = 0;

        this.cooldown = this.config.cooldown_ms;
        this.prompt = '';
        this.primary_goal = '';
        this.active_subgoal = '';
        this.infinite_mode = false;

        this.loop_count = 0;
        this.no_command_count = 0;
        this.stalled_cycles = 0;
        this.goal_pool_index = 0;
        this.last_goal_rotation = 0;
        this.last_stats_injection = 0;
        this.last_snapshot_signature = null;
    }

    start(prompt = null) {
        console.log('Self-prompting started.');
        const resolvedPrompt = normalizeGoal(prompt, this.primary_goal || this.prompt);
        if (!resolvedPrompt) {
            return 'No prompt specified. Ignoring request.';
        }
        if (prompt !== null && prompt !== undefined) {
            this.infinite_mode = false;
        }
        this.state = ACTIVE;
        this.primary_goal = resolvedPrompt;
        this.prompt = resolvedPrompt;
        this.startLoop();
        return null;
    }

    startInfinite(primaryGoal = null) {
        const resolvedGoal = normalizeGoal(primaryGoal, this.primary_goal || this.config.default_infinite_goal);
        if (!resolvedGoal) {
            return 'No infinite goal specified. Ignoring request.';
        }
        this.state = ACTIVE;
        this.infinite_mode = true;
        this.primary_goal = resolvedGoal;
        this.prompt = resolvedGoal;
        this.active_subgoal = '';
        this.last_goal_rotation = 0;
        this.startLoop();
        return null;
    }

    isActive() {
        return this.state === ACTIVE;
    }

    isStopped() {
        return this.state === STOPPED;
    }

    isPaused() {
        return this.state === PAUSED;
    }

    isInfinite() {
        return this.infinite_mode;
    }

    getPersistentState() {
        return {
            infinite_mode: this.infinite_mode,
            primary_goal: this.primary_goal,
            active_subgoal: this.active_subgoal,
            goal_pool_index: this.goal_pool_index,
            loop_count: this.loop_count,
            no_command_count: this.no_command_count,
            stalled_cycles: this.stalled_cycles
        };
    }

    getStatus() {
        return {
            state: this.state,
            state_name: this.state === ACTIVE ? 'ACTIVE' : (this.state === PAUSED ? 'PAUSED' : 'STOPPED'),
            loop_active: this.loop_active,
            infinite_mode: this.infinite_mode,
            goal: this.prompt,
            primary_goal: this.primary_goal,
            active_subgoal: this.active_subgoal,
            loop_count: this.loop_count,
            no_command_count: this.no_command_count,
            stalled_cycles: this.stalled_cycles,
            cooldown_ms: this.cooldown
        };
    }

    async handleLoad(prompt, state, persistentState = null) {
        if (state === undefined) {
            state = STOPPED;
        }
        this.state = state;
        this.prompt = normalizeGoal(prompt);
        this.primary_goal = normalizeGoal(prompt);

        if (persistentState && typeof persistentState === 'object') {
            this.infinite_mode = toSafeBool(persistentState.infinite_mode, this.infinite_mode);
            this.primary_goal = normalizeGoal(persistentState.primary_goal, this.primary_goal);
            this.active_subgoal = normalizeGoal(persistentState.active_subgoal, '');
            this.goal_pool_index = toSafeInteger(persistentState.goal_pool_index, this.goal_pool_index, 0);
            this.loop_count = toSafeInteger(persistentState.loop_count, this.loop_count, 0);
            this.no_command_count = toSafeInteger(persistentState.no_command_count, this.no_command_count, 0);
            this.stalled_cycles = toSafeInteger(persistentState.stalled_cycles, this.stalled_cycles, 0);
            this.prompt = normalizeGoal(this.prompt, this.primary_goal);
        }

        if (state !== STOPPED && !this.primary_goal && !this.prompt) {
            throw new Error('No prompt loaded when self-prompting is active');
        }
        if (state === ACTIVE) {
            if (this.infinite_mode) {
                await this.startInfinite(this.primary_goal || this.prompt);
            } else {
                await this.start(this.primary_goal || this.prompt);
            }
        }
    }

    setPromptPaused(prompt, infiniteMode = false) {
        const resolvedPrompt = normalizeGoal(prompt, this.primary_goal || this.prompt);
        if (!resolvedPrompt) {
            return;
        }
        this.primary_goal = resolvedPrompt;
        this.prompt = resolvedPrompt;
        this.active_subgoal = '';
        this.infinite_mode = !!infiniteMode;
        this.state = PAUSED;
    }

    async startLoop() {
        if (this.loop_active) {
            console.warn('Self-prompt loop is already active. Ignoring request.');
            return;
        }

        console.log('Starting self-prompt loop');
        this.loop_active = true;

        try {
            while (!this.interrupt && this.state === ACTIVE) {
                const snapshot = this._captureSnapshot();
                const runtimeGoal = this._resolveRuntimeGoal(snapshot);
                this.prompt = runtimeGoal;

                const forceCommand = this.no_command_count >= Math.max(1, Math.floor(this.config.max_no_command_cycles / 2));
                const msg = this._buildLoopPrompt(runtimeGoal, snapshot, forceCommand);

                let usedCommand = false;
                try {
                    usedCommand = await this.agent.handleMessage('system', msg, this.config.max_commands_per_cycle);
                } catch (error) {
                    console.error('Self-prompt cycle crashed:', error);
                    await this.agent.history.add('system', `Autonomy loop error: ${error.message}`);
                }

                this.loop_count++;
                this._trackProgress(snapshot, usedCommand);

                if (this.no_command_count >= this.config.max_no_command_cycles) {
                    await this._recoverNoCommand();
                }
                if (this.stalled_cycles >= this.config.max_stalled_cycles) {
                    await this._recoverFromStall();
                }
                if (Date.now() - this.last_stats_injection >= this.config.inject_stats_every_ms) {
                    await this._injectHeartbeat(snapshot);
                }
                if (this.loop_count % this.config.checkpoint_every_cycles === 0) {
                    await this.agent.history.save();
                }

                if (this.interrupt || this.state !== ACTIVE) {
                    break;
                }
                await sleep(this.cooldown);
            }
        } finally {
            console.log('Self prompt loop stopped');
            this.loop_active = false;
            this.interrupt = false;
        }
    }

    update(delta) {
        if (this.state === ACTIVE && !this.loop_active && !this.interrupt) {
            if (this.agent.isIdle()) {
                this.idle_time += delta;
            } else {
                this.idle_time = 0;
            }

            if (this.idle_time >= this.cooldown) {
                console.log('Restarting self-prompting...');
                this.startLoop();
                this.idle_time = 0;
            }
        } else {
            this.idle_time = 0;
        }
    }

    async stopLoop() {
        if (this.interrupt) {
            return;
        }
        console.log('Stopping self-prompt loop');
        this.interrupt = true;
        while (this.loop_active) {
            await sleep(150);
        }
        this.interrupt = false;
    }

    async stop(stop_action = true) {
        this.interrupt = true;
        if (stop_action) {
            await this.agent.actions.stop();
        }
        await this.stopLoop();
        this.state = STOPPED;
        this.active_subgoal = '';
    }

    async pause() {
        this.interrupt = true;
        await this.agent.actions.stop();
        await this.stopLoop();
        this.state = PAUSED;
    }

    shouldInterrupt(is_self_prompt) { // to be called from handleMessage
        return is_self_prompt && (this.state === ACTIVE || this.state === PAUSED) && this.interrupt;
    }

    handleUserPromptedCmd(is_self_prompt, is_action) {
        // if a user messages and the bot responds with an action, stop the self-prompt loop
        if (!is_self_prompt && is_action) {
            this.stopLoop();
            // this stops it from responding from the handlemessage loop and the self-prompt loop at the same time
        }
    }

    _captureSnapshot() {
        const bot = this.agent.bot;
        if (!bot || !bot.entity) {
            return {
                position: null,
                health: 20,
                hunger: 20,
                inventory: {},
                inventory_total: 0,
                inventory_signature: ''
            };
        }

        let inventory = {};
        try {
            inventory = world.getInventoryCounts(bot);
        } catch (error) {
            console.warn('Failed to read inventory in self prompt loop:', error);
        }

        const inventoryTotal = Object.values(inventory).reduce((acc, value) => acc + value, 0);
        return {
            position: bot.entity.position.clone(),
            health: Math.round(bot.health),
            hunger: Math.round(bot.food),
            inventory,
            inventory_total: inventoryTotal,
            inventory_signature: inventorySignature(inventory)
        };
    }

    _resolveRuntimeGoal(snapshot) {
        if (!this.infinite_mode) {
            return normalizeGoal(this.primary_goal, this.prompt);
        }

        const now = Date.now();
        if (!this.active_subgoal || this._shouldRotateSubgoal(now)) {
            this.active_subgoal = this._chooseInfiniteSubgoal(snapshot);
            this.last_goal_rotation = now;
        }

        return `${this.primary_goal}\nCurrent priority: ${this.active_subgoal}`;
    }

    _shouldRotateSubgoal(now) {
        if (now - this.last_goal_rotation >= this.config.rotate_subgoal_every_ms) {
            return true;
        }
        if (this.no_command_count >= Math.max(1, Math.floor(this.config.max_no_command_cycles / 2))) {
            return true;
        }
        if (this.stalled_cycles >= Math.max(1, Math.floor(this.config.max_stalled_cycles / 2))) {
            return true;
        }
        return false;
    }

    _chooseInfiniteSubgoal(snapshot) {
        const inventory = snapshot.inventory;
        const health = snapshot.health;
        const hunger = snapshot.hunger;

        const logs = getMatchingCount(inventory, (name) => name.endsWith('_log') || name.endsWith('_stem'));
        const planks = getMatchingCount(inventory, (name) => name.endsWith('_planks'));
        const wool = getMatchingCount(inventory, (name) => name.endsWith('_wool'));
        const food = getFoodCount(inventory);
        const sticks = getItemCount(inventory, ['stick']);
        const cobble = getItemCount(inventory, ['cobblestone', 'cobbled_deepslate', 'blackstone']);
        const ironIngots = getItemCount(inventory, ['iron_ingot']);
        const rawIron = getItemCount(inventory, ['raw_iron']);
        const coal = getItemCount(inventory, ['coal', 'charcoal']);

        const hasWoodPick = hasAnyItem(inventory, ['wooden_pickaxe']);
        const hasStonePick = hasAnyItem(inventory, ['stone_pickaxe']);
        const hasIronPick = hasAnyItem(inventory, ['iron_pickaxe']);
        const hasShield = hasAnyItem(inventory, ['shield']);
        const hasCraftingTable = hasAnyItem(inventory, ['crafting_table']);
        const hasFurnace = hasAnyItem(inventory, ['furnace']);
        const hasBed = Object.keys(inventory).some((name) => name.endsWith('_bed'));

        if (health <= 10) {
            return 'Stabilize immediately: get to safety, avoid mobs, and recover health before taking risks.';
        }
        if (hunger <= 10 || food < 8) {
            return 'Secure food now: gather or cook enough food to sustain long exploration and combat.';
        }
        if (logs + planks < 12) {
            return 'Gather wood and convert enough logs to planks for crafting and utility items.';
        }
        if (!hasCraftingTable) {
            return 'Craft a crafting table and keep it available for fast progression.';
        }
        if (!hasWoodPick) {
            return 'Craft a wooden pickaxe to unlock stone progression.';
        }
        if (!hasStonePick) {
            return 'Collect cobblestone and craft a stone pickaxe for reliable mining.';
        }
        if (!hasFurnace && cobble < 8) {
            return 'Collect at least 8 cobblestone and prepare to craft a furnace.';
        }
        if (!hasFurnace) {
            return 'Craft a furnace and prepare fuel for smelting.';
        }
        if (!hasIronPick && rawIron + ironIngots < 3) {
            return 'Mine iron ore and coal so you can smelt ingots and upgrade tools.';
        }
        if (!hasIronPick && ironIngots >= 3 && sticks >= 2) {
            return 'Craft an iron pickaxe to unlock stronger progression paths.';
        }
        if (!hasShield && ironIngots >= 1 && planks >= 6) {
            return 'Craft a shield to improve survivability during long runs.';
        }
        if (!hasBed && wool < 3) {
            return 'Find sheep and collect wool for a bed to control night risk.';
        }
        if (!hasBed && wool >= 3 && planks >= 3) {
            return 'Craft and place a bed so nights are safer and recovery is easier.';
        }
        if (rawIron > 0 && coal > 0) {
            return 'Smelt raw iron and reinvest ingots into armor, tools, and safety upgrades.';
        }

        const pool = this.config.infinite_goal_pool;
        const nextGoal = pool[this.goal_pool_index % pool.length];
        this.goal_pool_index = (this.goal_pool_index + 1) % pool.length;
        return nextGoal;
    }

    _buildLoopPrompt(runtimeGoal, snapshot, forceCommand) {
        const commandRule = forceCommand
            ? 'MANDATORY: your next response must include exactly one command with !commandName syntax.'
            : 'Respond with exactly one command using !commandName syntax.';
        return `Autonomy cycle #${this.loop_count + 1}.
Goal:
${runtimeGoal}
Snapshot: health=${snapshot.health}/20, hunger=${snapshot.hunger}/20, inventory_total=${snapshot.inventory_total}, position=${formatPos(snapshot.position)}.
${commandRule}
Rules:
- Prefer finite, high-signal actions over endless follow/stay loops.
- If uncertain, gather information first (!stats, !inventory, !nearbyBlocks, !entities, !craftable).
- Do not repeat a failing strategy; pivot quickly and continue forward progress.
Respond now.`;
    }

    _trackProgress(snapshot, usedCommand) {
        if (usedCommand) {
            this.no_command_count = 0;
        } else {
            this.no_command_count++;
        }

        const currentSignature = `${formatPos(snapshot.position)}|${snapshot.health}|${snapshot.hunger}|${snapshot.inventory_signature}`;
        if (this.last_snapshot_signature === currentSignature && this.agent.isIdle()) {
            this.stalled_cycles++;
        } else {
            this.stalled_cycles = 0;
        }
        this.last_snapshot_signature = currentSignature;
    }

    async _recoverNoCommand() {
        const warning = `Autonomy watchdog: no command used for ${this.config.max_no_command_cycles} cycles.`;
        console.warn(warning);
        await this.agent.history.add('system', `${warning} You must issue a command next cycle.`);
        this.no_command_count = 0;
        if (this.infinite_mode) {
            this.active_subgoal = this._chooseInfiniteSubgoal(this._captureSnapshot());
            this.last_goal_rotation = Date.now();
        }
    }

    async _recoverFromStall() {
        const warning = `Autonomy watchdog: stalled for ${this.config.max_stalled_cycles} cycles. Triggering recovery movement.`;
        console.warn(warning);
        await this.agent.history.add('system', warning);
        this.stalled_cycles = 0;

        try {
            if (this.agent.actions.executing) {
                await this.agent.actions.stop();
            }
            const moveResult = await this._executeDirectCommand('!moveAway(8)');
            if (moveResult) {
                await this.agent.history.add('system', `[Recovery] ${moveResult}`);
            }
            const nearby = await this._executeDirectCommand('!nearbyBlocks');
            if (nearby) {
                await this.agent.history.add('system', `[Recovery] ${nearby}`);
            }
        } catch (error) {
            console.error('Autonomy recovery failed:', error);
            await this.agent.history.add('system', `Autonomy recovery failed: ${error.message}`);
        }
    }

    async _injectHeartbeat(snapshot) {
        this.last_stats_injection = Date.now();
        const heartbeat = `[Autonomy heartbeat] loop=${this.loop_count}, pos=${formatPos(snapshot.position)}, health=${snapshot.health}, hunger=${snapshot.hunger}, inventory_total=${snapshot.inventory_total}`;
        await this.agent.history.add('system', heartbeat);
    }

    async _executeDirectCommand(commandText) {
        const commands = await import('./commands/index.js');
        return commands.executeCommand(this.agent, commandText);
    }
}