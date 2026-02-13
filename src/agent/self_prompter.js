import * as world from './library/world.js';
import settings from './settings.js';
import { AGIPlanner } from './agi/agi_planner.js';

const STOPPED = 0;
const ACTIVE = 1;
const PAUSED = 2;

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
    enable_agi_by_default: true,
    agi_replan_interval_ms: 120000,
    agi_max_stagnation_cycles: 5,
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
    merged.enable_agi_by_default = toSafeBool(merged.enable_agi_by_default, DEFAULT_AUTONOMY_CONFIG.enable_agi_by_default);
    merged.agi_replan_interval_ms = toSafeInteger(merged.agi_replan_interval_ms, DEFAULT_AUTONOMY_CONFIG.agi_replan_interval_ms, 10000);
    merged.agi_max_stagnation_cycles = toSafeInteger(merged.agi_max_stagnation_cycles, DEFAULT_AUTONOMY_CONFIG.agi_max_stagnation_cycles, 1);
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
        this.agi_planner = new AGIPlanner({
            replan_interval_ms: this.config.agi_replan_interval_ms,
            max_stagnation_cycles: this.config.agi_max_stagnation_cycles
        });

        this.state = STOPPED;
        this.loop_active = false;
        this.interrupt = false;
        this.idle_time = 0;

        this.cooldown = this.config.cooldown_ms;
        this.prompt = '';
        this.primary_goal = '';
        this.active_subgoal = '';
        this.infinite_mode = false;
        this.agi_mode = false;

        this.loop_count = 0;
        this.no_command_count = 0;
        this.stalled_cycles = 0;
        this.last_stats_injection = 0;
        this.last_snapshot_signature = null;
    }

    start(prompt = null) {
        console.log('Self-prompting started.');
        if ((prompt === null || prompt === undefined) && this.infinite_mode) {
            return this.startInfinite(this.primary_goal || this.prompt, this.agi_mode);
        }
        const resolvedPrompt = normalizeGoal(prompt, this.primary_goal || this.prompt);
        if (!resolvedPrompt) {
            return 'No prompt specified. Ignoring request.';
        }
        this.infinite_mode = false;
        this.agi_mode = false;
        this.agi_planner.stop();
        this.state = ACTIVE;
        this.primary_goal = resolvedPrompt;
        this.prompt = resolvedPrompt;
        this.active_subgoal = '';
        this.startLoop();
        return null;
    }

    startInfinite(primaryGoal = null, agiMode = this.config.enable_agi_by_default, preservePlanner = false) {
        const resolvedGoal = normalizeGoal(primaryGoal, this.primary_goal || this.config.default_infinite_goal);
        if (!resolvedGoal) {
            return 'No infinite goal specified. Ignoring request.';
        }
        this.state = ACTIVE;
        this.infinite_mode = true;
        this.agi_mode = !!agiMode;
        this.primary_goal = resolvedGoal;
        this.prompt = resolvedGoal;
        this.active_subgoal = '';
        if (this.agi_mode) {
            if (!preservePlanner || !this.agi_planner.isEnabled() || this.agi_planner.getStatus().objective !== this.primary_goal) {
                this.agi_planner.start(this.primary_goal, this.config.infinite_goal_pool, this._captureSnapshot());
            }
        } else {
            this.agi_planner.stop();
        }
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
            agi_mode: this.agi_mode,
            primary_goal: this.primary_goal,
            active_subgoal: this.active_subgoal,
            loop_count: this.loop_count,
            no_command_count: this.no_command_count,
            stalled_cycles: this.stalled_cycles,
            agi_planner: this.agi_planner.exportState()
        };
    }

    getStatus() {
        const agiStatus = this.agi_planner.getStatus();
        return {
            state: this.state,
            state_name: this.state === ACTIVE ? 'ACTIVE' : (this.state === PAUSED ? 'PAUSED' : 'STOPPED'),
            loop_active: this.loop_active,
            infinite_mode: this.infinite_mode,
            agi_mode: this.agi_mode,
            goal: this.prompt,
            primary_goal: this.primary_goal,
            active_subgoal: this.active_subgoal,
            loop_count: this.loop_count,
            no_command_count: this.no_command_count,
            stalled_cycles: this.stalled_cycles,
            cooldown_ms: this.cooldown,
            agi_objective: agiStatus.objective,
            agi_current_milestone: agiStatus.current_milestone,
            agi_remaining_milestones: agiStatus.remaining_milestones,
            agi_recent_completed: agiStatus.completed_recent,
            agi_recent_failed: agiStatus.failed_recent
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
            this.agi_mode = toSafeBool(persistentState.agi_mode, this.agi_mode);
            this.primary_goal = normalizeGoal(persistentState.primary_goal, this.primary_goal);
            this.active_subgoal = normalizeGoal(persistentState.active_subgoal, '');
            this.loop_count = toSafeInteger(persistentState.loop_count, this.loop_count, 0);
            this.no_command_count = toSafeInteger(persistentState.no_command_count, this.no_command_count, 0);
            this.stalled_cycles = toSafeInteger(persistentState.stalled_cycles, this.stalled_cycles, 0);
            this.agi_planner.load(persistentState.agi_planner);
            this.prompt = normalizeGoal(this.prompt, this.primary_goal);
        }

        if (state !== STOPPED && !this.primary_goal && !this.prompt) {
            throw new Error('No prompt loaded when self-prompting is active');
        }
        if (state === ACTIVE) {
            if (this.infinite_mode) {
                await this.startInfinite(this.primary_goal || this.prompt, this.agi_mode, true);
            } else {
                await this.start(this.primary_goal || this.prompt);
            }
        }
    }

    setPromptPaused(prompt, infiniteMode = false, agiMode = false) {
        const resolvedPrompt = normalizeGoal(prompt, this.primary_goal || this.prompt);
        if (!resolvedPrompt) {
            return;
        }
        this.primary_goal = resolvedPrompt;
        this.prompt = resolvedPrompt;
        this.active_subgoal = '';
        this.infinite_mode = !!infiniteMode;
        this.agi_mode = !!agiMode;
        if (this.agi_mode && this.infinite_mode) {
            this.agi_planner.start(this.primary_goal, this.config.infinite_goal_pool, this._captureSnapshot());
        } else {
            this.agi_planner.stop();
        }
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
        this.infinite_mode = false;
        this.agi_mode = false;
        this.agi_planner.stop();
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
        if (this.agi_mode) {
            if (!this.agi_planner.isEnabled()) {
                this.agi_planner.start(this.primary_goal, this.config.infinite_goal_pool, snapshot);
            }
            this.active_subgoal = this.agi_planner.getCurrentDirective(snapshot, this.config.infinite_goal_pool);
        } else {
            const pool = this.config.infinite_goal_pool;
            this.active_subgoal = pool[this.loop_count % pool.length] || 'Continue safe progression.';
        }
        return `${this.primary_goal}\nCurrent priority: ${this.active_subgoal}`;
    }

    _buildLoopPrompt(runtimeGoal, snapshot, forceCommand) {
        const commandRule = forceCommand
            ? 'MANDATORY: your next response must include exactly one command with !commandName syntax.'
            : 'Respond with exactly one command using !commandName syntax.';
        const plannerRule = this.agi_mode
            ? '- Treat the current priority as a milestone inside a larger AGI plan. If blocked, gather information and pivot.'
            : '- Keep making forward progress toward the goal with practical short actions.';
        return `Autonomy cycle #${this.loop_count + 1}.
Goal:
${runtimeGoal}
Snapshot: health=${snapshot.health}/20, hunger=${snapshot.hunger}/20, inventory_total=${snapshot.inventory_total}, position=${formatPos(snapshot.position)}.
${commandRule}
Rules:
- Prefer finite, high-signal actions over endless follow/stay loops.
- If uncertain, gather information first (!stats, !inventory, !nearbyBlocks, !entities, !craftable).
- Do not repeat a failing strategy; pivot quickly and continue forward progress.
${plannerRule}
Respond now.`;
    }

    _trackProgress(snapshot, usedCommand) {
        if (usedCommand) {
            this.no_command_count = 0;
        } else {
            this.no_command_count++;
        }

        const currentSignature = `${formatPos(snapshot.position)}|${snapshot.health}|${snapshot.hunger}|${snapshot.inventory_signature}`;
        const progressed = this.last_snapshot_signature !== currentSignature;
        if (this.last_snapshot_signature === currentSignature && this.agent.isIdle()) {
            this.stalled_cycles++;
        } else {
            this.stalled_cycles = 0;
        }
        this.last_snapshot_signature = currentSignature;

        if (this.infinite_mode && this.agi_mode) {
            this.agi_planner.recordCycle({
                usedCommand,
                progressed,
                snapshot,
                goalPool: this.config.infinite_goal_pool
            });
        }
    }

    async _recoverNoCommand() {
        const warning = `Autonomy watchdog: no command used for ${this.config.max_no_command_cycles} cycles.`;
        console.warn(warning);
        await this.agent.history.add('system', `${warning} You must issue a command next cycle.`);
        this.no_command_count = 0;
        if (this.infinite_mode && this.agi_mode) {
            this.agi_planner.noteFailure('No command used during autonomy cycle.', this._captureSnapshot(), this.config.infinite_goal_pool);
        }
    }

    async _recoverFromStall() {
        const warning = `Autonomy watchdog: stalled for ${this.config.max_stalled_cycles} cycles. Triggering recovery movement.`;
        console.warn(warning);
        await this.agent.history.add('system', warning);
        this.stalled_cycles = 0;
        if (this.infinite_mode && this.agi_mode) {
            this.agi_planner.noteFailure('No measurable progress detected; forcing recovery.', this._captureSnapshot(), this.config.infinite_goal_pool);
        }

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
        const heartbeat = `[Autonomy heartbeat] loop=${this.loop_count}, pos=${formatPos(snapshot.position)}, health=${snapshot.health}, hunger=${snapshot.hunger}, inventory_total=${snapshot.inventory_total}, subgoal=${this.active_subgoal || 'none'}`;
        await this.agent.history.add('system', heartbeat);
    }

    async _executeDirectCommand(commandText) {
        const commands = await import('./commands/index.js');
        return commands.executeCommand(this.agent, commandText);
    }
}