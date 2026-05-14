/**
 * IP Node Proxy - Admin API routes
 *
 * All routes live under /api/ip-node-proxy and require admin auth
 * (Bearer token from the management UI or REQUIRED_API_KEY).
 */

import axios from 'axios';
import logger from '../../utils/logger.js';
import { checkAuth } from '../../ui-modules/auth.js';
import { isAuthorized } from '../../utils/common.js';
import { parseProxyUrl } from '../../utils/proxy-utils.js';
import { getProviderPoolManager } from '../../services/service-manager.js';
import {
    listBindings,
    getBinding,
    findBinding,
    createBinding,
    updateBinding,
    deleteBinding,
    toggleBinding,
    reinvalidateAll,
    getAccessStats
} from './binding-manager.js';

const PLUGIN_TAG = '[IPNodeProxy API]';
const ROUTE_PREFIX = '/api/ip-node-proxy';

function parseRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk.toString();
        });
        req.on('end', () => {
            if (!body) return resolve({});
            try {
                resolve(JSON.parse(body));
            } catch (err) {
                reject(new Error('Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}

function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
}

async function checkAdminAuth(req, config) {
    try {
        if (await checkAuth(req)) return true;
        if (config?.REQUIRED_API_KEY) {
            const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
            return isAuthorized(req, requestUrl, config.REQUIRED_API_KEY);
        }
        return false;
    } catch (err) {
        logger.error(`${PLUGIN_TAG} auth check error: ${err.message}`);
        return false;
    }
}

/**
 * Lists every (provider, uuid) pair from the running pool manager so the
 * UI can render account dropdowns rich with health / customName context.
 */
function listProviderNodes() {
    const pm = getProviderPoolManager();
    const nodes = [];
    if (!pm || !pm.providerStatus) return nodes;
    for (const providerType of Object.keys(pm.providerStatus)) {
        const pool = pm.providerStatus[providerType];
        if (!Array.isArray(pool)) continue;
        for (const entry of pool) {
            const cfg = entry?.config || {};
            nodes.push({
                providerType,
                uuid: cfg.uuid || entry.uuid || null,
                customName: cfg.customName || null,
                isHealthy: cfg.isHealthy !== false,
                isDisabled: !!cfg.isDisabled,
                lastErrorTime: cfg.lastErrorTime || null,
                lastErrorMessage: cfg.lastErrorMessage || null
            });
        }
    }
    return nodes;
}

async function probeProxy(proxyUrl, target = 'https://www.google.com/generate_204', timeoutMs = 8000) {
    const parsed = parseProxyUrl(proxyUrl);
    if (!parsed) {
        return { ok: false, message: `Invalid proxy URL: ${proxyUrl}` };
    }
    const startedAt = Date.now();
    try {
        const resp = await axios.get(target, {
            timeout: timeoutMs,
            proxy: false,
            httpAgent: parsed.httpAgent,
            httpsAgent: parsed.httpsAgent,
            validateStatus: () => true,
            maxRedirects: 0
        });
        const elapsedMs = Date.now() - startedAt;
        const ok = resp.status >= 200 && resp.status < 500; // 任何上游响应都视为代理可达
        return {
            ok,
            statusCode: resp.status,
            proxyType: parsed.proxyType,
            elapsedMs,
            target,
            message: ok ? 'Proxy is reachable.' : `Upstream returned ${resp.status}.`
        };
    } catch (err) {
        return {
            ok: false,
            proxyType: parsed.proxyType,
            elapsedMs: Date.now() - startedAt,
            target,
            message: err.message
        };
    }
}

export async function handleIpNodeProxyApiRoutes(method, fullPath, req, res, config) {
    if (!fullPath.startsWith(ROUTE_PREFIX)) {
        return false;
    }

    const authorized = await checkAdminAuth(req, config);
    if (!authorized) {
        sendJson(res, 401, {
            success: false,
            error: { message: '未授权：请先登录或提供有效 API Key', code: 'UNAUTHORIZED' }
        });
        return true;
    }

    const subPath = fullPath.slice(ROUTE_PREFIX.length) || '/';

    try {
        if (method === 'GET' && (subPath === '' || subPath === '/')) {
            sendJson(res, 200, {
                success: true,
                data: {
                    bindings: listBindings(),
                    accessStats: getAccessStats()
                }
            });
            return true;
        }

        if (method === 'GET' && subPath === '/nodes') {
            sendJson(res, 200, {
                success: true,
                data: { nodes: listProviderNodes() }
            });
            return true;
        }

        if (method === 'POST' && subPath === '/test') {
            const body = await parseRequestBody(req);
            const proxyUrl = (body?.proxyUrl || '').toString().trim();
            const target = (body?.target || '').toString().trim() || undefined;
            const timeoutMs = Number(body?.timeoutMs) > 0 ? Number(body.timeoutMs) : undefined;
            if (!proxyUrl) {
                sendJson(res, 400, {
                    success: false,
                    error: { message: 'proxyUrl is required' }
                });
                return true;
            }
            const result = await probeProxy(proxyUrl, target, timeoutMs);
            sendJson(res, 200, { success: true, data: result });
            return true;
        }

        if (method === 'POST' && subPath === '/reinvalidate') {
            const count = reinvalidateAll();
            sendJson(res, 200, {
                success: true,
                message: `Invalidated ${count} adapter caches.`,
                data: { invalidated: count }
            });
            return true;
        }

        if (method === 'GET' && subPath === '/bindings') {
            sendJson(res, 200, { success: true, data: { bindings: listBindings() } });
            return true;
        }

        if (method === 'POST' && subPath === '/bindings') {
            const body = await parseRequestBody(req);
            try {
                const binding = await createBinding(body);
                sendJson(res, 201, { success: true, data: binding });
            } catch (err) {
                sendJson(res, 400, { success: false, error: { message: err.message } });
            }
            return true;
        }

        const bindingMatch = subPath.match(/^\/bindings\/([^/]+)(\/.*)?$/);
        if (bindingMatch) {
            const id = decodeURIComponent(bindingMatch[1]);
            const tail = bindingMatch[2] || '';
            if (method === 'GET' && !tail) {
                const binding = getBinding(id);
                if (!binding) {
                    sendJson(res, 404, { success: false, error: { message: 'Binding not found' } });
                    return true;
                }
                sendJson(res, 200, { success: true, data: binding });
                return true;
            }
            if ((method === 'PUT' || method === 'PATCH') && !tail) {
                const body = await parseRequestBody(req);
                try {
                    const binding = await updateBinding(id, body);
                    if (!binding) {
                        sendJson(res, 404, { success: false, error: { message: 'Binding not found' } });
                        return true;
                    }
                    sendJson(res, 200, { success: true, data: binding });
                } catch (err) {
                    sendJson(res, 400, { success: false, error: { message: err.message } });
                }
                return true;
            }
            if (method === 'DELETE' && !tail) {
                const ok = await deleteBinding(id);
                if (!ok) {
                    sendJson(res, 404, { success: false, error: { message: 'Binding not found' } });
                    return true;
                }
                sendJson(res, 200, { success: true, message: 'Binding deleted' });
                return true;
            }
            if (method === 'POST' && tail === '/toggle') {
                const binding = await toggleBinding(id);
                if (!binding) {
                    sendJson(res, 404, { success: false, error: { message: 'Binding not found' } });
                    return true;
                }
                sendJson(res, 200, {
                    success: true,
                    message: `Binding ${binding.enabled ? 'enabled' : 'disabled'}`,
                    data: binding
                });
                return true;
            }
        }

        // 未匹配的子路径：让 plugin manager 继续往下走
        return false;
    } catch (err) {
        logger.error(`${PLUGIN_TAG} route error: ${err.message}`);
        sendJson(res, 500, {
            success: false,
            error: { message: err.message }
        });
        return true;
    }
}
