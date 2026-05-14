/**
 * IP Node Proxy Plugin
 *
 * Binds an outbound HTTP/HTTPS/SOCKS5 proxy to a specific provider account
 * (providerType + uuid). The existing proxy-utils layer already looks for
 * `config.ipNodeProxy.getProxyUrl(providerType, uuid)`; this plugin installs
 * that hook on the global server config and persists the binding table to
 * configs/ip-node-proxy.json.
 *
 * Problem this solves:
 *   - Accessing kiro from mainland China requires a proxy to even reach the
 *     /usage endpoint. A globally-shared PROXY_URL forces every account to
 *     share the same upstream IP, which dramatically increases the chance
 *     of multi-account bans.
 *   - With this plugin each account (uuid) can be bound to its own outbound
 *     proxy, so account A uses node A, account B uses node B, etc.
 *
 * Lifecycle:
 *   - init(): load store, attach getProxyUrl to the global config, mark all
 *     currently-cached adapters dirty so the binding takes effect immediately.
 *   - middleware(): record the per-request clientIp into the per-request
 *     config (for logging) and capture access stats for the UI.
 *   - destroy(): flush pending writes.
 */

import logger from '../../utils/logger.js';
import {
    init as initManager,
    shutdown as shutdownManager,
    listBindings,
    getBinding,
    findBinding,
    createBinding,
    updateBinding,
    deleteBinding,
    toggleBinding,
    lookupProxyUrl,
    recordAccess,
    reinvalidateAll,
    getAccessStats,
    getStoreSnapshot
} from './binding-manager.js';
import { handleIpNodeProxyApiRoutes } from './api-routes.js';
import { getClientIp } from '../../utils/common.js';

let serverConfigRef = null;

/**
 * Returns a function suitable for `config.ipNodeProxy.getProxyUrl`. We close
 * over no per-request state; the function itself reads the current binding
 * table from the persistent store on every call so newly-added bindings are
 * picked up without server restart.
 */
function buildGetProxyUrl() {
    return function getProxyUrl(providerType, uuid, clientIp) {
        try {
            return lookupProxyUrl(providerType, uuid, clientIp);
        } catch (err) {
            logger.error(`[IPNodeProxy] lookupProxyUrl error: ${err.message}`);
            return null;
        }
    };
}

const ipNodeProxyPlugin = {
    name: 'ip-node-proxy',
    version: '1.0.0',
    description:
        'IP 节点代理绑定 - 为每个 Provider 账号 (uuid) 单独绑定出站 HTTP/SOCKS5 代理，避免多账号共享同一公网 IP 造成的封号风险。<br>管理页面：<a href="ip-node-proxy.html" target="_blank">ip-node-proxy.html</a>',

    type: 'middleware',
    _priority: 50,

    async init(config) {
        serverConfigRef = config;
        await initManager();

        const getProxyUrl = buildGetProxyUrl();

        config.ipNodeProxy = {
            ...(config.ipNodeProxy || {}),
            getProxyUrl,
            enabled: true
        };

        // 启用后清理已缓存的 adapter，使下次请求按最新绑定重新构建 axios 实例
        const invalidated = reinvalidateAll();
        logger.info(`[IPNodeProxy] Plugin initialized. Invalidated ${invalidated} cached adapters.`);
    },

    async destroy() {
        if (serverConfigRef && serverConfigRef.ipNodeProxy) {
            // 关闭时取消注入，避免插件被禁用后仍然命中绑定
            serverConfigRef.ipNodeProxy.enabled = false;
            delete serverConfigRef.ipNodeProxy.getProxyUrl;
            reinvalidateAll();
        }
        await shutdownManager();
        logger.info('[IPNodeProxy] Plugin destroyed.');
    },

    staticPaths: ['ip-node-proxy.html'],

    routes: [
        {
            method: '*',
            path: '/api/ip-node-proxy',
            handler: handleIpNodeProxyApiRoutes
        }
    ],

    async middleware(req, res, requestUrl, config) {
        const clientIp = getClientIp(req);
        if (!config.ipNodeProxy || typeof config.ipNodeProxy !== 'object') {
            config.ipNodeProxy = {};
        }
        config.ipNodeProxy.clientIp = clientIp;

        // 当前请求 config 还没有合并 provider pool 的节点信息，因此在 hooks.onBeforeRequest
        // 阶段才能拿到 uuid。这里只负责挂载 clientIp 以便 proxy-utils 日志使用。
        return { handled: false };
    },

    hooks: {
        // onContentGenerated 在 pool 选择并完成请求后被调用，hookContext 包含
        // 最终生效的 MODEL_PROVIDER 与 uuid，是记录 clientIp 访问轨迹的最佳时机。
        async onContentGenerated(hookContext) {
            try {
                const providerType = hookContext?.MODEL_PROVIDER;
                const uuid = hookContext?.uuid;
                const clientIp = hookContext?.ipNodeProxy?.clientIp;
                if (providerType && uuid && clientIp) {
                    recordAccess(providerType, uuid, clientIp);
                }
            } catch (err) {
                logger.error(`[IPNodeProxy] Failed to record access: ${err.message}`);
            }
        }
    },

    exports: {
        listBindings,
        getBinding,
        findBinding,
        createBinding,
        updateBinding,
        deleteBinding,
        toggleBinding,
        lookupProxyUrl,
        reinvalidateAll,
        getAccessStats,
        getStoreSnapshot
    }
};

export default ipNodeProxyPlugin;

export {
    listBindings,
    getBinding,
    findBinding,
    createBinding,
    updateBinding,
    deleteBinding,
    toggleBinding,
    lookupProxyUrl,
    reinvalidateAll,
    getAccessStats,
    getStoreSnapshot
};
