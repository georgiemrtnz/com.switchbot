'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

let baseRequest = async () => ({});
const originalLoad = Module._load;
Module._load = function mockDependencies(request, parent, isMain)
{
	if (request === 'homey') return { env: {} };
	if (request === 'homey-oauth2app') return {
		OAuth2Client: class {
			async _executeRequest(...args) { return baseRequest.call(this, ...args); }
		},
		OAuth2Token: class {},
		OAuth2Error: Error,
	};
	return originalLoad.call(this, request, parent, isMain);
};
const OAuthClient = require('../lib/SwitchBotOAuth2Client');
Module._load = originalLoad;

function createClient(logLevel = 3)
{
	const logged = [];
	const settings = { logLevel };
	const client = Object.assign(Object.create(OAuthClient.prototype), {
		homey: {
			setTimeout(fn) { fn(); },
			settings: { get: (key) => settings[key] },
			app: { updateLog: (message, level) => logged.push({ message, level }) },
		},
	});
	return { client, logged, settings };
}

test('debug redacts Authorization header lines and keeps the header key spelling', () =>
{
	const { client, logged } = createClient();
	client.debug('[req]', 'Authorization: Bearer abc.def');
	client.debug('[req]', 'authorization: Basic Zm9vOmJhcg==');
	client.debug('[req]', 'AUTHORIZATION: Bearer');
	client.debug('[req]', 'Content-Type: application/json');
	assert.deepEqual(logged.map((entry) => entry.message), [
		'[req] Authorization: Bearer ***',
		'[req] authorization: ***',
		'[req] AUTHORIZATION: ***',
		'[req] Content-Type: application/json',
	]);
	assert.ok(logged.every((entry) => entry.level === 3));
});

test('debug output at logLevel 3 matches the previous formatting', () =>
{
	const { client, logged } = createClient(3);
	client.debug('[res]', { ok: true, status: 200 });
	client.debug('Refreshing token...');
	const circular = {};
	circular.self = circular;
	client.debug('[req]', circular);
	assert.deepEqual(logged.map((entry) => entry.message), [
		'[res] {"ok":true,"status":200}',
		'Refreshing token...',
		'[req] [object Object]',
	]);
});

test('debug does no formatting work below logLevel 3 and reacts to live level changes', () =>
{
	const { client, logged, settings } = createClient(0);
	const originalStringify = JSON.stringify;
	let stringifyCalls = 0;
	JSON.stringify = (...args) => { stringifyCalls++; return originalStringify(...args); };
	try
	{
		client.debug('[req]', { body: 'x'.repeat(1000) });
		client.debug('Refreshed token!', { access_token: 'secret' });
		settings.logLevel = 2;
		client.debug('[res]', { status: 200 });
		assert.equal(stringifyCalls, 0);
		assert.equal(logged.length, 0);
		settings.logLevel = 3;
		client.debug('[res]', { status: 200 });
		assert.equal(stringifyCalls, 1);
	}
	finally
	{
		JSON.stringify = originalStringify;
	}
	assert.deepEqual(logged.map((entry) => entry.message), ['[res] {"status":200}']);
});

test('requests redact the bearer token in base-client header logging', async () =>
{
	const { client, logged } = createClient(3);
	baseRequest = async function logHeaders(req)
	{
		for (const key of Object.keys(req.opts.headers))
		{
			this.debug('[req]', `${key}: ${req.opts.headers[key]}`);
		}
		return { ok: true };
	};
	const result = await client._executeRequest({ method: 'POST', path: '/x', opts: { headers: { Authorization: 'Bearer top-secret', Accept: 'json' } } });
	assert.deepEqual(result, { ok: true });
	assert.deepEqual(logged.map((entry) => entry.message), ['[req] Authorization: Bearer ***', '[req] Accept: json']);
	assert.ok(!logged.some((entry) => entry.message.includes('top-secret')));
});

function getGc()
{
	if (typeof global.gc === 'function') return global.gc;
	// npm test runs without --expose-gc; enable it for this check only.
	require('node:v8').setFlagsFromString('--expose-gc');
	return require('node:vm').runInNewContext('gc');
}

test('requests leave no per-instance debug override and do not grow the heap', async () =>
{
	const gc = getGc();
	const { client } = createClient(0);
	baseRequest = async function logHeaders()
	{
		this.debug('[req]', 'GET', 'url');
		this.debug('[req]', 'Authorization: Bearer x');
		return {};
	};
	const getReq = { method: 'GET', path: '/devices', opts: { headers: { Authorization: 'Bearer x' } } };
	const postReq = { method: 'POST', path: '/commands', opts: { headers: { Authorization: 'Bearer x' } } };
	for (let i = 0; i < 1000; i++) await client._executeRequest(i % 2 ? getReq : postReq);

	gc(); gc();
	const before = process.memoryUsage().heapUsed;
	for (let i = 0; i < 10000; i++) await client._executeRequest(i % 2 ? getReq : postReq);
	await Promise.all(Array.from({ length: 50 }, (_, i) => client._executeRequest(i % 2 ? getReq : postReq)));
	gc(); gc();
	const growth = process.memoryUsage().heapUsed - before;

	assert.equal(Object.prototype.hasOwnProperty.call(client, 'debug'), false);
	assert.equal(client.debug, OAuthClient.prototype.debug);
	assert.ok(growth < 100 * 1024, `heap grew ${growth} bytes over 10,050 requests`);
});
