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
const near = (a, b) => Math.abs(a - b) < 0.00001;

// A device instance backed by a store and capability values that outlive it,
// so a second instance models the same Homey device after an app restart.
function createDevice(persisted, telemetry)
{
	const writes = [];
	const device = Object.assign(Object.create(CurtainsHubDevice.prototype), {
		invertPosition: false,
		motionMode: 0xff,
		getData: () => ({ id: 'curtain' }),
		setAvailable: () => {}, unsetWarning: async () => {}, error: () => {},
		hasCapability: () => true,
		getCapabilityValue: key => persisted.capabilities[key],
		setCapabilityValue: async (key, value) => { persisted.capabilities[key] = value; },
		getStoreValue: key => persisted.store[key],
		setStoreValue: async (key, value) => { writes.push([key, value]); persisted.store[key] = value; },
		homey: { setTimeout: () => 1, app: {
			updateLog: () => {}, varToString: String,
			triggerPositionLessThan: async () => {}, triggerPositionGreaterThan: async () => {},
		} },
		_getHubDeviceValues: async () => telemetry.current,
		_operateCurtain: CurtainsHubDevice.prototype._operateCurtain,
	});
	return { device, writes };
}

function closedHome()
{
	return { capabilities: {}, store: {} };
}

async function confirmClose(device)
{
	device.pendingCloseUntil = Date.now() + 10000;
	await device.getHubDeviceValues();
	await flush();
}

test('a confirmed close is persisted once and survives an app restart', async () => {
	const persisted = closedHome();
	const telemetry = { current: { slidePosition: 99, moving: false, calibrate: true } };
	const first = createDevice(persisted, telemetry);
	await confirmClose(first.device);
	assert.equal(persisted.capabilities.windowcoverings_set, 0);
	assert.equal(persisted.store.closeEndpointLatch.latched, true);
	await first.device.getHubDeviceValues();
	await flush();
	assert.equal(first.writes.length, 1, 'no store write when the state is unchanged');

	// Restart: new instance, no pending close window, same store and capability.
	const second = createDevice(persisted, telemetry);
	assert.equal(second.device.restoreCloseEndpointLatch(), true);
	await second.device.getHubDeviceValues();
	await flush();
	assert.equal(persisted.capabilities.windowcoverings_set, 0);
	assert.ok(near(persisted.capabilities.position, 1), 'raw position is still reported');
	assert.equal(second.writes.length, 0);
});

test('without a stored correction a restart keeps reporting the raw 1%', async () => {
	const persisted = closedHome();
	persisted.capabilities.windowcoverings_set = 0.01;
	const telemetry = { current: { slidePosition: 99, moving: false, calibrate: true } };
	const { device } = createDevice(persisted, telemetry);
	assert.equal(device.restoreCloseEndpointLatch(), false);
	await device.getHubDeviceValues();
	assert.ok(near(persisted.capabilities.windowcoverings_set, 0.01));
});

test('a restored correction is dropped when the curtain is no longer at the endpoint', async () => {
	for (const reading of [
		{ slidePosition: 60, moving: false, calibrate: true },
		{ slidePosition: 99, moving: true, calibrate: true },
	]) {
		const persisted = closedHome();
		const telemetry = { current: { slidePosition: 99, moving: false, calibrate: true } };
		await confirmClose(createDevice(persisted, telemetry).device);
		assert.equal(persisted.store.closeEndpointLatch.latched, true);

		telemetry.current = reading;
		const restarted = createDevice(persisted, telemetry);
		restarted.device.restoreCloseEndpointLatch();
		await restarted.device.getHubDeviceValues();
		await flush();
		assert.equal(persisted.store.closeEndpointLatch, null);
		assert.ok(persisted.capabilities.windowcoverings_set > 0);

		// Back at 99 later without a new Homey close: raw 1% again.
		telemetry.current = { slidePosition: 99, moving: false, calibrate: true };
		await restarted.device.getHubDeviceValues();
		assert.ok(near(persisted.capabilities.windowcoverings_set, 0.01));
	}
});

test('a stored correction is not restored when Homey no longer holds the closed endpoint', async () => {
	const persisted = closedHome();
	persisted.store.closeEndpointLatch = { latched: true, at: '2026-11-16T21:22:04.000Z' };
	persisted.capabilities.windowcoverings_set = 0.4;
	const { device } = createDevice(persisted, { current: { slidePosition: 99, moving: false, calibrate: true } });
	assert.equal(device.restoreCloseEndpointLatch(), false);
	await flush();
	assert.equal(persisted.store.closeEndpointLatch, null);
	assert.equal(device.closeEndpointLatched, false);
});

test('opening via webhook clears the stored correction', async () => {
	const persisted = closedHome();
	const telemetry = { current: { slidePosition: 99, moving: false, calibrate: true } };
	const { device } = createDevice(persisted, telemetry);
	await confirmClose(device);
	await device.processWebhookMessage({ context: { deviceMac: 'curtain', slidePosition: 40, moving: true } });
	await flush();
	assert.equal(persisted.store.closeEndpointLatch, null);
	assert.ok(near(persisted.capabilities.windowcoverings_set, 0.6));
});

test('any new command clears the stored correction before it is sent', async () => {
	const persisted = closedHome();
	const telemetry = { current: { slidePosition: 99, moving: false, calibrate: true } };
	const { device } = createDevice(persisted, telemetry);
	await confirmClose(device);
	device._operateCurtain = async function fakeOperate()
	{
		this.commandSequence = (this.commandSequence || 0) + 1;
		this.pendingCloseUntil = null;
		this.setCloseEndpointLatched(false);
		return true;
	};
	await device.onCapabilityPosition(0.5);
	await flush();
	assert.equal(persisted.store.closeEndpointLatch, null);
	assert.equal(device.closeEndpointLatched, false);
});

test('the real command path clears the correction before calling SwitchBot', async () => {
	const persisted = closedHome();
	const { device } = createDevice(persisted, { current: { slidePosition: 99, moving: false, calibrate: true } });
	await confirmClose(device);
	let latchedAtSend;
	// Fake SwitchBot client: no network.
	device.homey.app.getFirstSavedOAuth2Client = () => ({
		setDeviceData: async () => { latchedAtSend = device.closeEndpointLatched; return { statusCode: 100 }; },
	});
	await device._operateCurtain('setPosition', '0,ff,50');
	await flush();
	assert.equal(latchedAtSend, false);
	assert.equal(persisted.store.closeEndpointLatch, null);
});
