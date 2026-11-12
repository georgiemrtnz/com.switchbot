'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;

Module._load = function mockHomeyOAuth(request, parent, isMain)
{
	if (request === 'homey-oauth2app')
	{
		return { OAuth2Device: class OAuth2Device {} };
	}

	return originalLoad.call(this, request, parent, isMain);
};

const CurtainsHubDevice = require('../drivers/curtains_hub/device');

Module._load = originalLoad;

function createDevice(overrides = {})
{
	return Object.assign(Object.create(CurtainsHubDevice.prototype), {
		invertPosition: false,
		motionMode: 0xff,
	}, overrides);
}

test('translates Homey open percentage to SwitchBot closed percentage', () => {
	const device = createDevice();

	assert.equal(device.homeyPositionToSwitchBot(0), 100);
	assert.equal(device.homeyPositionToSwitchBot(0.25), 75);
	assert.equal(device.homeyPositionToSwitchBot(1), 0);
	assert.equal(device.switchBotPositionToHomey(100), 0);
	assert.equal(device.switchBotPositionToHomey(75), 0.25);
	assert.equal(device.switchBotPositionToHomey(0), 1);
});

test('honours inversion and clamps out-of-range positions', () => {
	const device = createDevice({ invertPosition: true });

	assert.equal(device.homeyPositionToSwitchBot(-1), 0);
	assert.equal(device.homeyPositionToSwitchBot(2), 100);
	assert.equal(device.switchBotPositionToHomey(-1), 0);
	assert.equal(device.switchBotPositionToHomey(200), 1);
});

test('serializes SwitchBot motion modes with the required ff token', async () => {
	const calls = [];
	const device = createDevice({
		_operateCurtain: async (...args) => {
			calls.push(args);
			return true;
		},
	});

	await device.runToPos(30, 0xff);
	await device.runToPos(40, '0xff');
	await device.runToPos(50, 0);
	await device.runToPos(60, 1);

	assert.deepEqual(calls, [
		['setPosition', '0,ff,30'],
		['setPosition', '0,ff,40'],
		['setPosition', '0,0,50'],
		['setPosition', '0,1,60'],
	]);
});

test('maps the closed toggle and position slider to SwitchBot correctly', async () => {
	const calls = [];
	const device = createDevice({
		_operateCurtain: async (...args) => {
			calls.push(args);
			return true;
		},
	});

	await device.onCapabilityopenClose(true);
	await device.onCapabilityopenClose(false);
	await device.onCapabilityPosition(0.75, {});

	assert.deepEqual(calls, [
		['setPosition', '0,ff,100'],
		['setPosition', '0,ff,0'],
		['setPosition', '0,ff,25'],
	]);
});

test('Stop holds the reported position when Curtain3 ignores pause', async () => {
	const calls = [];
	const device = createDevice({
		delay: async () => {},
		_getHubDeviceValues: async () => ({ moving: true, slidePosition: 43 }),
		_operateCurtain: async (...args) => {
			calls.push(args);
			return true;
		},
	});

	await device.stop();

	assert.deepEqual(calls, [
		['pause', 'default'],
		['setPosition', '0,ff,43'],
	]);
});

test('Stop does not send a fallback when pause succeeded', async () => {
	const calls = [];
	const device = createDevice({
		delay: async () => {},
		_getHubDeviceValues: async () => ({ moving: false, slidePosition: 43 }),
		_operateCurtain: async (...args) => {
			calls.push(args);
			return true;
		},
	});

	await device.stop();

	assert.deepEqual(calls, [['pause', 'default']]);
});

test('Stop preserves a successful pause when its verification read fails', async () => {
	const calls = [];
	const logs = [];
	const device = createDevice({
		delay: async () => {},
		homey: { app: { updateLog: (...args) => logs.push(args) } },
		_getHubDeviceValues: async () => {
			throw new Error('temporary status error');
		},
		_operateCurtain: async (...args) => {
			calls.push(args);
			return true;
		},
	});

	assert.equal(await device.stop(), true);
	assert.deepEqual(calls, [['pause', 'default']]);
	assert.match(logs[0][0], /temporary status error/);
});

test('normalizes a calibrated stationary close endpoint while preserving raw position', async () => {
	const values = {};
	const device = createDevice({
		getData: () => ({ id: 'test' }),
		setAvailable: () => {}, unsetWarning: async () => {}, error: () => {},
		hasCapability: () => true,
		setCapabilityValue: async (key, value) => { values[key] = value; },
		homey: { app: { updateLog: () => {}, varToString: String } },
		_getHubDeviceValues: async () => ({ slidePosition: 99, moving: false, calibrate: true }),
		pendingCloseUntil: Date.now() + 10000,
	});
	await device.getHubDeviceValues();
	assert.equal(values.windowcoverings_set, 0);
	assert.ok(Math.abs(values.position - 1) < 0.00001);
	device.pendingCloseUntil = null;
	await device.getHubDeviceValues();
	assert.equal(values.windowcoverings_set, 0);
	device.closeEndpointLatched = false;
	await device.getHubDeviceValues();
	assert.ok(Math.abs(values.windowcoverings_set - 0.01) < 0.00001);
});

test('requires calibrated stationary feedback within the pending window', async () => {
	for (const data of [
		{ slidePosition: 99, moving: true, calibrate: true },
		{ slidePosition: 99, moving: false, calibrate: false },
		{ slidePosition: 99, moving: false },
	]) {
		const values = {};
		const device = createDevice({
			getData: () => ({ id: 'test' }), setAvailable: () => {}, unsetWarning: async () => {}, error: () => {},
			hasCapability: () => true, setCapabilityValue: async (key, value) => { values[key] = value; },
			homey: { app: { updateLog: () => {}, varToString: String } },
			_getHubDeviceValues: async () => data, pendingCloseUntil: Date.now() + 10000,
		});
		await device.getHubDeviceValues();
		assert.ok(Math.abs(values.windowcoverings_set - 0.01) < 0.00001);
	}
});

test('deliberate one-percent command does not arm close tolerance', async () => {
	const device = createDevice({ _operateCurtain: async () => true });
	await device.onCapabilityPosition(0.01);
	assert.equal(device.pendingCloseUntil, undefined);
	await device.onCapabilityPosition(0);
	assert.ok(device.pendingCloseUntil > Date.now());
});

test('ignores a poll overtaken by a newer command', async () => {
	let resolvePoll;
	const values = {};
	const device = createDevice({
		commandSequence: 1,
		_getHubDeviceValues: () => new Promise(resolve => { resolvePoll = resolve; }),
		setCapabilityValue: async (key, value) => { values[key] = value; },
		homey: { app: { updateLog: () => {}, varToString: String } },
	});
	const poll = device.getHubDeviceValues();
	device.commandSequence = 2;
	resolvePoll({ slidePosition: 99, moving: false, calibrate: true });
	await poll;
	assert.deepEqual(values, {});
});

test('full close via directional action arms tolerance after success', async () => {
	const device = createDevice({ _operateCurtain: async () => true });
	await device.close();
	assert.ok(device.pendingCloseUntil > Date.now());
});

test('webhook preserves a confirmed endpoint and raw telemetry', async () => {
	const values = {};
	const device = createDevice({
		getData: () => ({ id: 'test' }),
		closeEndpointLatched: true,
		setCapabilityValue: async (key, value) => { values[key] = value; },
		hasCapability: () => true,
		error: () => {},
		homey: { setTimeout: () => 1, app: {
			updateLog: () => {}, varToString: String,
			triggerPositionLessThan: async () => {}, triggerPositionGreaterThan: async () => {},
		} },
	});
	await device.processWebhookMessage({ context: { deviceMac: 'test', slidePosition: 99 } });
	assert.equal(values.windowcoverings_set, 0);
	assert.ok(Math.abs(values.position - 1) < 0.00001);
});
