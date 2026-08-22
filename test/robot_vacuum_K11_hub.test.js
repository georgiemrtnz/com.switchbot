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

const VacuumK11HubDevice = require('../drivers/robot_vacuum_K11_hub/device');

Module._load = originalLoad;

function createDevice(values = {}, overrides = {})
{
	return Object.assign(Object.create(VacuumK11HubDevice.prototype), {
		getCapabilityValue: (capability) => values[capability] ?? null,
	}, overrides);
}

test('Play starts the selected clean mode with the selected fan level and repeat count', async () => {
	const calls = [];
	const device = createDevice({
		vaccum_clean_mode: 'vacuumAndMop',
		vaccum_fan_level: '3',
		vaccum_times: '2',
	}, {
		startVacuum: async (...args) => {
			calls.push(args);
			return 'started';
		},
	});

	assert.equal(await device.onCapabilityPlay(true, {}), 'started');
	assert.deepEqual(calls, [['vacuumAndMop', '3', '2']]);
});

test('Play uses safe defaults when vacuum options have not been set', async () => {
	const calls = [];
	const device = createDevice({}, {
		startVacuum: async (...args) => calls.push(args),
	});

	await device.onCapabilityPlay(true, {});
	assert.deepEqual(calls, [['sweep', '1', '1']]);
});

test('Play returns a failed start command to Homey', async () => {
	const expected = new Error('start rejected');
	const device = createDevice({}, {
		startVacuum: async () => { throw expected; },
	});

	await assert.rejects(device.onCapabilityPlay(true, {}), expected);
});

test('startVacuum serializes numeric options for the SwitchBot command', async () => {
	const calls = [];
	const device = createDevice({}, {
		setDeviceData: async (data) => {
			calls.push(data);
			return true;
		},
	});

	assert.equal(await device.startVacuum('sweep', '2', '3'), true);
	assert.deepEqual(calls, [{
		command: 'startClean',
		parameter: { action: 'sweep', param: { fanLevel: 2, times: 3 } },
		commandType: 'command',
	}]);
});
