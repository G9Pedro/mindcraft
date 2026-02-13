function normalizeText(text, fallback = '') {
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

const DEFAULT_CONFIG = Object.freeze({
    replan_interval_ms: 120000,
    max_stagnation_cycles: 5
});

export class AGIPlanner {
    constructor(config = {}) {
        this.config = {
            ...DEFAULT_CONFIG,
            ...config
        };
        this.config.replan_interval_ms = toSafeInteger(this.config.replan_interval_ms, DEFAULT_CONFIG.replan_interval_ms, 10000);
        this.config.max_stagnation_cycles = toSafeInteger(this.config.max_stagnation_cycles, DEFAULT_CONFIG.max_stagnation_cycles, 1);

        this.enabled = false;
        this.objective = '';
        this.milestones = [];
        this.current_idx = 0;
        this.completed = [];
        this.failed = [];
        this.stagnation_cycles = 0;
        this.last_replan_time = 0;
        this.pool_idx = 0;
    }

    start(objective, goalPool = [], snapshot = null) {
        this.enabled = true;
        this.objective = normalizeText(objective);
        this.completed = [];
        this.failed = [];
        this.current_idx = 0;
        this.stagnation_cycles = 0;
        this.last_replan_time = 0;
        this._replan(snapshot, goalPool);
    }

    stop() {
        this.enabled = false;
        this.objective = '';
        this.milestones = [];
        this.current_idx = 0;
        this.completed = [];
        this.failed = [];
        this.stagnation_cycles = 0;
        this.last_replan_time = 0;
    }

    isEnabled() {
        return this.enabled;
    }

    getCurrentDirective(snapshot, goalPool = []) {
        if (!this.enabled) {
            return '';
        }
        if (this._shouldReplan()) {
            this._replan(snapshot, goalPool);
        }
        if (this.milestones.length === 0) {
            this._replan(snapshot, goalPool);
        }
        const current = this.milestones[this.current_idx];
        return current || normalizeText(this.objective, 'Keep progressing safely and efficiently.');
    }

    recordCycle({ usedCommand, progressed, snapshot, goalPool = [] }) {
        if (!this.enabled) {
            return;
        }
        if (progressed || usedCommand) {
            this.stagnation_cycles = 0;
        } else {
            this.stagnation_cycles++;
        }
        if (this.stagnation_cycles >= this.config.max_stagnation_cycles) {
            this.noteFailure('Stagnated while pursuing current milestone.', snapshot, goalPool);
        }
    }

    noteSuccess(reason = 'Milestone completed.', snapshot, goalPool = []) {
        if (!this.enabled || this.milestones.length === 0) {
            return;
        }
        const current = this.milestones[this.current_idx];
        if (current) {
            this.completed.push({ milestone: current, reason, at: Date.now() });
        }
        this.current_idx++;
        this.stagnation_cycles = 0;

        if (this.current_idx >= this.milestones.length) {
            this._replan(snapshot, goalPool);
        }
    }

    noteFailure(reason = 'Milestone failed.', snapshot, goalPool = []) {
        if (!this.enabled || this.milestones.length === 0) {
            return;
        }
        const current = this.milestones[this.current_idx];
        if (current) {
            this.failed.push({ milestone: current, reason, at: Date.now() });
        }
        this.stagnation_cycles = 0;
        this._replan(snapshot, goalPool);
    }

    exportState() {
        return {
            enabled: this.enabled,
            objective: this.objective,
            milestones: this.milestones,
            current_idx: this.current_idx,
            completed: this.completed.slice(-8),
            failed: this.failed.slice(-8),
            stagnation_cycles: this.stagnation_cycles,
            last_replan_time: this.last_replan_time,
            pool_idx: this.pool_idx
        };
    }

    load(state) {
        if (!state || typeof state !== 'object') {
            return;
        }
        this.enabled = !!state.enabled;
        this.objective = normalizeText(state.objective, this.objective);
        this.milestones = Array.isArray(state.milestones) ? state.milestones.filter((s) => typeof s === 'string' && s.trim().length > 0) : [];
        this.current_idx = toSafeInteger(state.current_idx, 0, 0);
        this.completed = Array.isArray(state.completed) ? state.completed : [];
        this.failed = Array.isArray(state.failed) ? state.failed : [];
        this.stagnation_cycles = toSafeInteger(state.stagnation_cycles, 0, 0);
        this.last_replan_time = toSafeInteger(state.last_replan_time, 0, 0);
        this.pool_idx = toSafeInteger(state.pool_idx, 0, 0);
        if (this.current_idx >= this.milestones.length) {
            this.current_idx = 0;
        }
    }

    getStatus() {
        return {
            enabled: this.enabled,
            objective: this.objective,
            current_milestone: this.milestones[this.current_idx] || '',
            remaining_milestones: this.milestones.slice(this.current_idx),
            stagnation_cycles: this.stagnation_cycles,
            last_replan_time: this.last_replan_time,
            completed_recent: this.completed.slice(-3),
            failed_recent: this.failed.slice(-3)
        };
    }

    _shouldReplan() {
        if (this.milestones.length === 0) {
            return true;
        }
        if (Date.now() - this.last_replan_time >= this.config.replan_interval_ms) {
            return true;
        }
        if (this.current_idx >= this.milestones.length) {
            return true;
        }
        return false;
    }

    _replan(snapshot, goalPool) {
        this.milestones = this._generateMilestones(snapshot, goalPool);
        this.current_idx = 0;
        this.last_replan_time = Date.now();
    }

    _generateMilestones(snapshot, goalPool) {
        const milestones = [];
        const inventory = snapshot?.inventory || {};
        const health = snapshot?.health ?? 20;
        const hunger = snapshot?.hunger ?? 20;

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
            milestones.push('Stabilize immediately: get safe, avoid mobs, and recover health.');
        }
        if (hunger <= 10 || food < 8) {
            milestones.push('Secure food now: gather/cook enough food for sustained exploration and combat.');
        }
        if (logs + planks < 12) {
            milestones.push('Gather wood and convert to planks for core crafting progression.');
        }
        if (!hasCraftingTable) {
            milestones.push('Craft a crafting table and keep it available.');
        }
        if (!hasWoodPick) {
            milestones.push('Craft a wooden pickaxe to unlock stone progression.');
        }
        if (!hasStonePick) {
            milestones.push('Collect cobblestone and craft a stone pickaxe.');
        }
        if (!hasFurnace && cobble < 8) {
            milestones.push('Collect at least 8 cobblestone for a furnace.');
        }
        if (!hasFurnace) {
            milestones.push('Craft a furnace and prepare fuel for smelting.');
        }
        if (!hasIronPick && rawIron + ironIngots < 3) {
            milestones.push('Mine iron ore and coal so you can smelt and upgrade tools.');
        }
        if (!hasIronPick && ironIngots >= 3 && sticks >= 2) {
            milestones.push('Craft an iron pickaxe for advanced progression.');
        }
        if (!hasShield && ironIngots >= 1 && planks >= 6) {
            milestones.push('Craft a shield to improve survivability.');
        }
        if (!hasBed && wool < 3) {
            milestones.push('Find sheep and collect wool for a bed.');
        }
        if (!hasBed && wool >= 3 && planks >= 3) {
            milestones.push('Craft/place a bed to reduce night-time risk.');
        }
        if (rawIron > 0 && coal > 0) {
            milestones.push('Smelt raw iron and reinvest ingots into durable gear.');
        }

        if (milestones.length < 3) {
            const pool = Array.isArray(goalPool) ? goalPool : [];
            if (pool.length > 0) {
                milestones.push(pool[this.pool_idx % pool.length]);
                this.pool_idx = (this.pool_idx + 1) % pool.length;
                milestones.push(pool[this.pool_idx % pool.length]);
                this.pool_idx = (this.pool_idx + 1) % pool.length;
            }
        }

        if (milestones.length === 0) {
            milestones.push('Improve your position safely: gather resources, upgrade tools, and expand capability.');
        }
        return milestones;
    }
}
