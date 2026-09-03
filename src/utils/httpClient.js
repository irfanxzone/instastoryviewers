'use strict';

require('dotenv').config();
const axios = require('axios');
const proxyService = require('../services/proxyService');

const timeout = Number(process.env.REQUEST_TIMEOUT_MS || 6000);

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
];

function randomUa() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function buildAxiosConfig(headers, proxyUrl, options = {}) {
  const config = {
    timeout,
    maxRedirects: options.maxRedirects ?? 5,
    // Accept 4xx so callers can inspect status; 5xx still throws
    validateStatus: status => status >= 200 && status < 500,
    headers: {
      'User-Agent': randomUa(),
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      ...headers
    }
  };

  if (proxyUrl) {
    const axiosProxy = proxyService.getAxiosProxyConfig(proxyUrl);
    if (axiosProxy) config.proxy = axiosProxy;
  }

  return config;
}

async function get(url, headers = {}, options = {}) {
  // Explicit proxy override in options, or use the current proxy from the pool
  const hasExplicitProxy = Object.prototype.hasOwnProperty.call(options, 'proxy');
  const maxAttempts = hasExplicitProxy ? 1 : Math.max(1, proxyService.getProxyCount());
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const proxyUrl = hasExplicitProxy ? options.proxy : proxyService.getCurrentProxy();
    const config = buildAxiosConfig(headers, proxyUrl, options);

    try {
      const response = await axios.get(url, config);
      // Axios intentionally returns 4xx responses to callers, but 407 is a
      // proxy-authentication failure and must never pin the whole pool.
      if (response.status !== 407 || hasExplicitProxy || !proxyService.hasProxies()) {
        return response;
      }
      lastError = new Error('Proxy authentication failed (407)');
    } catch (err) {
      lastError = err;
      if (hasExplicitProxy || !proxyService.hasProxies() || !proxyService.shouldRotateOnError(err)) {
        throw err;
      }
    }

    proxyService.rotateProxy();
  }

  throw lastError || new Error('No working outbound proxy is available.');
}

module.exports = { get, randomUa };
