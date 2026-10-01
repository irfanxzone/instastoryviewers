'use strict';

const axios = require('axios');
const { compactNumber } = require('../utils/formatters');
const BASE = 'https://api.openhandle.dev/v1/instagram';

function formatStatNumber(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return '0';
  if (number < 10000) return number.toLocaleString('en-US');
  return compactNumber(number);
}

function requestProfile(username, retry = 0) {
  return axios.get(`${BASE}/profiles/@${encodeURIComponent(username)}`, {
    params: { freshness: '24h' },
    headers: { Authorization: `Bearer ${String(process.env.OPENHANDLE_API_KEY || '').trim()}` },
    timeout: Number(process.env.OPENHANDLE_TIMEOUT_MS || 20000),
    proxy: false,
    validateStatus: () => true
  }).then(async response => {
    if (response.status >= 200 && response.status < 300) return response;
    if (response.status === 429 && retry === 0) {
      const retryAfter = Math.max(1, Math.min(5, Number(response.headers['retry-after']) || 2));
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      return requestProfile(username, 1);
    }
    const error = new Error(
      response.data?.error?.message || response.data?.message ||
      `OpenHandle profile returned HTTP ${response.status}`
    );
    error.status = response.status;
    throw error;
  });
}

async function requestStories(username, retry = 0) {
  const response = await axios.get(`${BASE}/profiles/@${encodeURIComponent(username)}/stories`, {
    params: { freshness: 'live' },
    headers: { Authorization: `Bearer ${String(process.env.OPENHANDLE_API_KEY || '').trim()}` },
    timeout: Number(process.env.OPENHANDLE_TIMEOUT_MS || 20000),
    proxy: false,
    validateStatus: () => true
  });

  if (response.status >= 200 && response.status < 300) return response;
  if (response.status === 429 && retry === 0) {
    const retryAfter = Math.max(1, Math.min(5, Number(response.headers['retry-after']) || 2));
    await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
    return requestStories(username, 1);
  }

  const error = new Error(
    response.data?.error?.message || response.data?.message ||
    `OpenHandle Stories returned HTTP ${response.status}`
  );
  error.status = response.status;
  throw error;
}

async function requestMedia(username, resource, retry = 0) {
  const response = await axios.get(`${BASE}/profiles/@${encodeURIComponent(username)}/${resource}`, {
    params: { freshness: '24h' },
    headers: { Authorization: `Bearer ${String(process.env.OPENHANDLE_API_KEY || '').trim()}` },
    timeout: Number(process.env.OPENHANDLE_TIMEOUT_MS || 20000),
    proxy: false,
    validateStatus: () => true
  });
  if (response.status >= 200 && response.status < 300) return response;
  if (response.status === 429 && retry === 0) {
    const retryAfter = Math.max(1, Math.min(5, Number(response.headers['retry-after']) || 2));
    await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
    return requestMedia(username, resource, 1);
  }
  const error = new Error(response.data?.error?.message || response.data?.message || `OpenHandle ${resource} returned HTTP ${response.status}`);
  error.status = response.status;
  throw error;
}

function normalizeStory(item) {
  if (!item) return null;
  const media = item.media?.[0] || {};
  const isVideo = media.type === 'video';
  const directUrl = media.url || media.variants?.find(value => value?.url)?.url || '';
  const thumbnail = media.thumbnail?.url || media.firstFrame?.url || (!isVideo ? directUrl : '');
  return {
    id: item.id || media.id || null,
    shortcode: item.code || null,
    type: 'story',
    thumbnail,
    displayUrl: isVideo ? thumbnail : directUrl,
    videoUrl: isVideo ? directUrl : null,
    caption: item.text || '',
    timestamp: item.createdAt || media.createdAt || null,
    likes: 0,
    comments: 0,
    url: item.url || null
  };
}

function normalizeMedia(item, resource) {
  if (!item) return null;
  const media = item.media?.[0] || {};
  const isVideo = media.type === 'video' || item.type === 'reel';
  const directUrl = media.url || media.variants?.find(value => value?.url)?.url || '';
  const thumbnail = media.thumbnail?.url || media.firstFrame?.url || (!isVideo ? directUrl : '');
  return {
    id: item.id || media.id || null,
    shortcode: item.code || null,
    type: resource === 'reels' ? 'reel' : item.type === 'carousel' ? 'carousel' : isVideo ? 'video' : 'image',
    thumbnail,
    displayUrl: isVideo ? thumbnail : directUrl,
    videoUrl: isVideo ? directUrl : null,
    caption: item.text || '',
    timestamp: item.createdAt || media.createdAt || null,
    likes: Number(item.metrics?.likes || 0),
    comments: Number(item.metrics?.comments || 0),
    url: item.url || null
  };
}

function normalizeProfile(data, requestedUsername) {
  if (!data || typeof data !== 'object') return null;
  const metrics = data.metrics || {};
  const followers = Number(metrics.followers || 0);
  const following = Number(metrics.following || 0);
  const postsCount = Number(metrics.posts || 0);
  const username = data.handle || requestedUsername;
  const avatar = data.avatar?.url ||
    data.avatar?.variants?.find(item => item?.url)?.url ||
    data.avatar?.thumbnail?.url || '';

  return {
    id: data.id || null,
    username,
    fullName: data.displayName || '',
    avatar,
    bio: data.bio || '',
    externalUrl: data.externalUrl || data.bioLinks?.[0]?.url || '',
    followers,
    followersText: formatStatNumber(followers),
    following,
    followingText: formatStatNumber(following),
    postsCount,
    postsCountText: postsCount.toLocaleString('en-US'),
    isPrivate: Boolean(data.isPrivate),
    isVerified: Boolean(data.isVerified),
    category: data.category || '',
    instagramUrl: data.url || `https://www.instagram.com/${username}/`
  };
}

async function fetchProfileViaOpenHandle(username) {
  if (!process.env.OPENHANDLE_API_KEY) {
    const error = new Error('OPENHANDLE_API_KEY is not configured.');
    error.status = 503;
    throw error;
  }

  const response = await requestProfile(username);
  const profile = normalizeProfile(response.data?.data, username);
  if (!profile?.username) {
    const error = new Error('OpenHandle returned an empty profile.');
    error.status = 502;
    throw error;
  }
  const cost = Number(response.headers['openhandle-cost'] || 0);
  console.log(`[openhandle:profile] @${username}: id=${profile.id ? 'yes' : 'no'}, cost=$${cost.toFixed(4)}`);
  return profile;
}

async function fetchStoriesViaOpenHandle(username) {
  if (!process.env.OPENHANDLE_API_KEY) {
    const error = new Error('OPENHANDLE_API_KEY is not configured.');
    error.status = 503;
    throw error;
  }

  const response = await requestStories(username);
  const items = (Array.isArray(response.data?.data) ? response.data.data : [])
    .map(normalizeStory)
    .filter(Boolean);
  const cost = Number(response.headers['openhandle-cost'] || 0);
  console.log(`[openhandle:stories] @${username}: items=${items.length}, cost=$${cost.toFixed(4)}`);

  return {
    available: items.length > 0,
    items,
    source: 'openhandle',
    checkedAt: response.data?.capturedAt || new Date().toISOString(),
    state: items.length ? 'AVAILABLE' : 'EMPTY',
    message: items.length ? undefined : 'No active stories in the last 24 hours.'
  };
}

async function fetchMediaViaOpenHandle(username, resource) {
  if (!['posts', 'reels'].includes(resource)) throw new Error('Unsupported OpenHandle media resource.');
  const response = await requestMedia(username, resource);
  const items = (Array.isArray(response.data?.data) ? response.data.data : [])
    .map(item => normalizeMedia(item, resource))
    .filter(Boolean);
  const cost = Number(response.headers['openhandle-cost'] || 0);
  console.log(`[openhandle:${resource}:fallback] @${username}: items=${items.length}, cost=$${cost.toFixed(4)}`);
  return {
    available: items.length > 0,
    items,
    source: 'openhandle_fallback',
    message: items.length ? undefined : `No ${resource} were returned for this profile.`
  };
}

module.exports = {
  fetchProfileViaOpenHandle,
  fetchStoriesViaOpenHandle,
  fetchMediaViaOpenHandle,
  normalizeProfile
};
