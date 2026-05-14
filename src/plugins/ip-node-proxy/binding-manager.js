/**
 * IP Node Proxy - Binding Manager
 *
 * Responsible for:
 *  1. Persisting per-account outbound proxy bindings to configs/ip-node-proxy.json
 *  2. Looking up the proxy URL for a (providerType, uuid) pair at request time
 *  3. Tracking which client IPs have accessed which (provider, uuid) pair
 *     (for showing suggestions in the admin UI)
 *  4. Invalidating the cached provider adapter when a binding mutates so the
 *     newly-configured outbound proxy takes effect on the next request.
 */

import { atomicWriteFile } from '../../utils/file-lock.js';
import { promises as fs, existsSync, readFileSync } from 'fs';
import path from 'path';
import crypto from 'crypto';
import logger from '../../utils/logger.js';
import { invalidateServiceAdapter } from '../../providers/adapter.js';
import { parseProxyUrl } from '../../utils/proxy-utils.js';

const STORE_FILE = path.join(process.cwd(), 'configs', 'ip-node-proxy.json');

const PERSIST_INTERVAL_MS = 5000;
const MAX_TRACKED_IPS_PER_NODE = 32;
const ACCESS_PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // keep 7 days

let store = null;
let dirty = false;
let writing = false;
let persistTimer = null;

function defaultStore() {
    return {
        version: 1,
        bindings: {},
        accessStats: {}
    };
}

function statsKey(providerType, uuid) {
    return `${providerType}::${uuid}`;
}

function nowMs() {
    return Date.now();
}

function ensureLoaded() {
    if (store !== null) return;
    try {
        if (existsSync(STORE_FILE)) {
            const content = readFileSync(STORE_FILE, 'utf8');
            const parsed = JSON.parse(content);
            store = {
                ...defaultStore(),
                ...parsed,
                bindings: parsed.bindings && typeof parsed.bindings === 'object' ? parsed.bindings : {},
                accessStats: parsed.accessStats && typeof parsed.accessStats === 'object' ? parsed.accessStats : {}
            };
        } else {
            store = defaultStore();
        }
    } catch (err) {
        logger.error(`[IPNodeProxy] Failed to load ${STORE_FILE}: ${err.message}. Starting with empty store.`);
        store = defaultStore();
    }
}

async function loadStoreAsync() {
    if (existsSync(STORE_FILE)) {
        try {
            const content = await fs.readFile(STORE_FILE, 'utf8');
            const parsed = JSON.parse(content);
            store = {
                ...defaultStore(),
                ...parsed,
                bindings: parsed.bindings && typeof parsed.bindings === 'object' ? parsed.bindings : {},
                accessStats: parsed.accessStats && typeof parsed.accessStats === 'object' ? parsed.accessStats : {}
            };
        } catch (err) {
            logger.error(`[IPNodeProxy] Failed to load ${STORE_FILE}: ${err.message}. Starting with empty store.`);
            store = defaultStore();
        }
    } else {
        store = defaultStore();
    }
}

function markDirty() {
    dirty = true;
    if (!persistTimer) {
        persistTimer = setTimeout(flushPersist, PERSIST_INTERVAL_MS);
    }
}

async function flushPersist() {
    persistTimer = null;
    if (!dirty || writing || store === null) return;
    writing = true;
    try {
        const snapshot = JSON.stringify(store, null, 2);
        const dir = path.dirname(STORE_FILE);
        if (!existsSync(dir)) {
            await fs.mkdir(dir, { recursive: true });
        }
        await atomicWriteFile(STORE_FILE, snapshot, { encoding: 'utf8', mode: 0o600 });
        dirty = false;
    } catch (err) {
        logger.error(`[IPNodeProxy] Failed to persist ${STORE_FILE}: ${err.message}`);
    } finally {
        writing = false;
        if (dirty && !persistTimer) {
            persistTimer = setTimeout(flushPersist, PERSIST_INTERVAL_MS);
        }
    }
}

export async function init() {
    await loadStoreAsync();
    pruneAccessStats();
    logger.info(`[IPNodeProxy] Binding manager initialized. ${Object.keys(store.bindings).length} bindings loaded.`);
}

export async function shutdown() {
    if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
    }
    if (dirty) {
        await flushPersist();
    }
}

function pruneAccessStats() {
    if (!store) return;
    const cutoff = nowMs() - ACCESS_PRUNE_AGE_MS;
    for (const key of Object.keys(store.accessStats)) {
        const node = store.accessStats[key];
        if (!node || typeof node !== 'object') {
            delete store.accessStats[key];
            continue;
        }
        if (node.clientIps && typeof node.clientIps === 'object') {
            for (const ip of Object.keys(node.clientIps)) {
                const entry = node.clientIps[ip];
                if (!entry || typeof entry !== 'object' || entry.lastSeen < cutoff) {
                    delete node.clientIps[ip];
                }
            }
        }
        if (!node.clientIps || Object.keys(node.clientIps).length === 0) {
            delete store.accessStats[key];
        }
    }
}

function normalizeClientIps(input) {
    if (input === undefined || input === null) {
        return ['*'];
    }
    if (typeof input === 'string') {
        const trimmed = input.trim();
        if (!trimmed) return ['*'];
        return [trimmed];
    }
    if (Array.isArray(input)) {
        const cleaned = input
            .map((s) => (typeof s === 'string' ? s.trim() : ''))
            .filter(Boolean);
        return cleaned.length > 0 ? cleaned : ['*'];
    }
    return ['*'];
}

function validateProxyUrl(proxyUrl) {
    if (!proxyUrl || typeof proxyUrl !== 'string' || !proxyUrl.trim()) {
        throw new Error('proxyUrl is required');
    }
    const trimmed = proxyUrl.trim();
    const parsed = parseProxyUrl(trimmed);
    if (!parsed) {
        throw new Error(`Invalid proxy URL: ${trimmed}. Use http://host:port, https://host:port or socks5://host:port`);
    }
    return trimmed;
}

function genId() {
    if (typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return crypto.randomBytes(16).toString('hex');
}

export function listBindings() {
    ensureLoaded();
    return Object.values(store.bindings).sort((a, b) => {
        if (a.providerType !== b.providerType) return a.providerType.localeCompare(b.providerType);
        const aName = a.customName || a.uuid;
        const bName = b.customName || b.uuid;
        return aName.localeCompare(bName);
    });
}

export function getBinding(id) {
    ensureLoaded();
    return store.bindings[id] || null;
}

export function findBinding(providerType, uuid) {
    ensureLoaded();
    if (!providerType || !uuid) return null;
    for (const binding of Object.values(store.bindings)) {
        if (binding.providerType === providerType && binding.uuid === uuid) {
            return binding;
        }
    }
    return null;
}

export async function createBinding(data) {
    ensureLoaded();
    const providerType = (data?.providerType || '').trim();
    const uuid = (data?.uuid || '').trim();
    if (!providerType) throw new Error('providerType is required');
    if (!uuid) throw new Error('uuid is required');

    const existing = findBinding(providerType, uuid);
    if (existing) {
        throw new Error(`A binding for ${providerType} / ${uuid} already exists (id=${existing.id})`);
    }

    const proxyUrl = validateProxyUrl(data.proxyUrl);

    const binding = {
        id: genId(),
        providerType,
        uuid,
        customName: (data.customName || '').toString().trim(),
        proxyUrl,
        clientIps: normalizeClientIps(data.clientIps),
        enabled: data.enabled !== false,
        note: (data.note || '').toString(),
        createdAt: nowMs(),
        updatedAt: nowMs()
    };

    store.bindings[binding.id] = binding;
    markDirty();
    invalidateAdapter(providerType, uuid);
    return binding;
}

export async function updateBinding(id, patch = {}) {
    ensureLoaded();
    const binding = store.bindings[id];
    if (!binding) return null;

    let providerChanged = false;
    if (patch.providerType !== undefined) {
        const next = String(patch.providerType).trim();
        if (next && next !== binding.providerType) {
            const conflict = findBinding(next, binding.uuid);
            if (conflict && conflict.id !== id) {
                throw new Error(`A binding for ${next} / ${binding.uuid} already exists`);
            }
            providerChanged = true;
            binding.providerType = next;
        }
    }
    let uuidChanged = false;
    if (patch.uuid !== undefined) {
        const next = String(patch.uuid).trim();
        if (next && next !== binding.uuid) {
            const conflict = findBinding(binding.providerType, next);
            if (conflict && conflict.id !== id) {
                throw new Error(`A binding for ${binding.providerType} / ${next} already exists`);
            }
            uuidChanged = true;
            binding.uuid = next;
        }
    }
    if (patch.customName !== undefined) {
        binding.customName = String(patch.customName).trim();
    }
    if (patch.proxyUrl !== undefined) {
        binding.proxyUrl = validateProxyUrl(patch.proxyUrl);
    }
    if (patch.clientIps !== undefined) {
        binding.clientIps = normalizeClientIps(patch.clientIps);
    }
    if (patch.enabled !== undefined) {
        binding.enabled = !!patch.enabled;
    }
    if (patch.note !== undefined) {
        binding.note = String(patch.note);
    }
    binding.updatedAt = nowMs();
    markDirty();

    // 任何与代理相关的字段变更都需要让缓存的 adapter 重建以使新代理生效
    invalidateAdapter(binding.providerType, binding.uuid);
    if (providerChanged || uuidChanged) {
        invalidateAdapter(binding.providerType, binding.uuid);
    }
    return binding;
}

export async function deleteBinding(id) {
    ensureLoaded();
    const binding = store.bindings[id];
    if (!binding) return false;
    delete store.bindings[id];
    markDirty();
    invalidateAdapter(binding.providerType, binding.uuid);
    return true;
}

export async function toggleBinding(id) {
    ensureLoaded();
    const binding = store.bindings[id];
    if (!binding) return null;
    binding.enabled = !binding.enabled;
    binding.updatedAt = nowMs();
    markDirty();
    invalidateAdapter(binding.providerType, binding.uuid);
    return binding;
}

function invalidateAdapter(providerType, uuid) {
    try {
        const ok = invalidateServiceAdapter(providerType, uuid);
        if (ok) {
            logger.info(`[IPNodeProxy] Invalidated adapter cache for ${providerType}/${uuid} to apply new proxy binding.`);
        }
    } catch (err) {
        logger.error(`[IPNodeProxy] Failed to invalidate adapter for ${providerType}/${uuid}: ${err.message}`);
    }
}

export function reinvalidateAll() {
    ensureLoaded();
    for (const binding of Object.values(store.bindings)) {
        invalidateAdapter(binding.providerType, binding.uuid);
    }
    return Object.keys(store.bindings).length;
}

/**
 * Looks up the outbound proxy URL bound to a (providerType, uuid) pair.
 * Optionally filters by clientIp when the binding specifies an allow-list.
 * Returns null when no binding matches.
 */
export function lookupProxyUrl(providerType, uuid, clientIp) {
    ensureLoaded();
    if (!providerType || !uuid) return null;
    const binding = findBinding(providerType, uuid);
    if (!binding || !binding.enabled) return null;

    if (clientIp && Array.isArray(binding.clientIps) && binding.clientIps.length > 0) {
        const allowAny = binding.clientIps.includes('*');
        if (!allowAny && !binding.clientIps.includes(clientIp)) {
            logger.debug?.(`[IPNodeProxy] Binding ${binding.id} skipped: clientIp ${clientIp} not in allow-list.`);
            return null;
        }
    }

    return binding.proxyUrl;
}

/**
 * Record that a clientIp has accessed (providerType, uuid). Used to populate
 * the management UI with realistic IP suggestions.
 */
export function recordAccess(providerType, uuid, clientIp) {
    if (!providerType || !uuid || !clientIp) return;
    ensureLoaded();
    const key = statsKey(providerType, uuid);
    let node = store.accessStats[key];
    if (!node) {
        node = { clientIps: {}, lastIp: clientIp, totalRequests: 0 };
        store.accessStats[key] = node;
    }
    node.lastIp = clientIp;
    node.totalRequests = (node.totalRequests || 0) + 1;
    if (!node.clientIps || typeof node.clientIps !== 'object') node.clientIps = {};
    const ipEntry = node.clientIps[clientIp] || { count: 0, lastSeen: 0 };
    ipEntry.count = (ipEntry.count || 0) + 1;
    ipEntry.lastSeen = nowMs();
    node.clientIps[clientIp] = ipEntry;

    const ipKeys = Object.keys(node.clientIps);
    if (ipKeys.length > MAX_TRACKED_IPS_PER_NODE) {
        const sorted = ipKeys.sort((a, b) => node.clientIps[a].lastSeen - node.clientIps[b].lastSeen);
        const removeCount = ipKeys.length - MAX_TRACKED_IPS_PER_NODE;
        for (let i = 0; i < removeCount; i++) {
            delete node.clientIps[sorted[i]];
        }
    }
    markDirty();
}

export function getAccessStats() {
    ensureLoaded();
    return store.accessStats;
}

export function getStoreSnapshot() {
    ensureLoaded();
    return {
        version: store.version,
        bindings: Object.values(store.bindings),
        accessStats: store.accessStats
    };
}

export const __test__ = {
    reset() {
        store = defaultStore();
        dirty = false;
        if (persistTimer) {
            clearTimeout(persistTimer);
            persistTimer = null;
        }
    },
    storePath: STORE_FILE
};
