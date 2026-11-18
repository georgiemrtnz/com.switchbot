'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;
Module._load = function mockHomeyOAuth(request, parent, isMain)
{
	if (request === 'homey-oauth2app') return { OAuth2Device: class OAuth2Device {} };
	return originalLoad.call(this, request, parent, isMain);
};
const CurtainsHubDevice = require('../drivers/curtains_hub/device');
Module._load = originalLoad;

const flush = () => new Promise(resolve => setImmediate(resolve));

function createDevice(telemetry)
{
	const persisted = { capabilities: {}, store: {} };
	const device = Object.assign(Object.create(CurtainsHubDevice.prototype), {
		invertPosition: false,
		motionMode: 0xff,
		getData: () => ({ id: 'curtain' }),
		setAvailable: () => {}, unsetWarning: async () => {}, setWarning: async () => {}, error: () => {},
		hasCapability: () => true,
		getCapabilityValue: key => persisted.capabilities[key],
		setCapabilityValue: async (key, value) => { persisted.capabilities[key] = value; },
		getStoreValue: key => persisted.store[key],
		setStoreValue: async (key, value) => { persisted.store[key] = value; },
		homey: {
			setTimeout: () => 1, clearTimeout: () => {},
			app: {
				updateLog: () => {}, varToString: String,
				triggerPositionLessThan: async () => {}, triggerPositionGreaterThan: async () => {},
				getFirstSavedOAuth2Client: () => ({ setDeviceData: async () => ({ statusCode: 100 }) }),
			},
		},
		_getHubDeviceValues: async () => telemetry.current,
	});
	return { device, persisted };
}

const webhook = context => ({ context: { deviceMac: 'curtain', ...context } });

test('a Homey close confirmed by a webhook reports 0, not 1%', async () => {
	const telemetry = { current: null };
	const { device, persisted } = createDevice(telemetry);
	await device.runToPos(100, 0xff, true);
	await device.processWebhookMessage(webhook({ slidePosition: 99, moving: false }));
	await flush();
	assert.equal(persisted.capabilities.windowcoverings_set, 0);
	assert.equal(persisted.store.closeEndpointLatch.latched, true);
});

test('a close confirmed long after the old 2-minute window still reports 0', async () => {
	const telemetry = { current: { slidePosition: 60, moving: true, calibrate: true } };
	const { device, persisted } = createDevice(telemetry);
	await device.runToPos(100, 0xff, true);
	await device.getHubDeviceValues();
	// Simulate a slow poll: the confirming reading arrives 10 minutes later.
	const realNow = Date.now;
	Date.now = () => realNow() + 10 * 60 * 1000;
	try
	{
		telemetry.current = { slidePosition: 99, moving: false, calibrate: true };
		await device.getHubDeviceValues();
		await flush();
	}
	finally
	{
		Date.now = realNow;
	}
	assert.equal(persisted.capabilities.windowcoverings_set, 0);
	assert.ok(Math.abs(persisted.capabilities.position - 1) < 0.00001, 'raw position is still reported');
});

test('a close that stops short ends the pending close; a later external 1% stays 1%', async () => {
	const telemetry = { current: { slidePosition: 70, moving: false, calibrate: true } };
	const { device, persisted } = createDevice(telemetry);
	await device.runToPos(100, 0xff, true);
	await device.getHubDeviceValues();
	assert.equal(device.pendingCloseUntil, null);
	telemetry.current = { slidePosition: 99, moving: false, calibrate: true };
	await device.getHubDeviceValues();
	await flush();
	assert.ok(Math.abs(persisted.capabilities.windowcoverings_set - 0.01) < 0.00001);
});

test('an uncalibrated curtain is never latched', async () => {
	const telemetry = { current: { slidePosition: 99, moving: false, calibrate: false } };
	const { device, persisted } = createDevice(telemetry);
	await device.runToPos(100, 0xff, true);
	await device.getHubDeviceValues();
	await flush();
	assert.ok(Math.abs(persisted.capabilities.windowcoverings_set - 0.01) < 0.00001);
});
