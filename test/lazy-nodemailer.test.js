'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

const homeyStub = {
	App: class App {},
	Device: class {},
	Driver: class {},
	env: { MAIL_HOST: 'mail.example', MAIL_USER: 'user@example', MAIL_SECRET: 'pw', MAIL_RECIPIENT: 'to@example' },
	manifest: { version: '0.0.0' },
};
const originalLoad = Module._load;
Module._load = function mockHomey(request, parent, isMain)
{
	if (request === 'homey-oauth2app') return { OAuth2App: class OAuth2App {}, OAuth2Client: class OAuth2Client {}, OAuth2Device: class {}, OAuth2Driver: class {}, OAuth2Token: class {}, OAuth2Error: class extends Error {} };
	if (request === 'homey') return homeyStub;
	return originalLoad.call(this, request, parent, isMain);
};
const App = require('../app');
Module._load = originalLoad;

const nodemailerPath = require.resolve('nodemailer', { paths: [path.join(__dirname, '..')] });

// app.js memoizes the module after first use, so a single stub serves every test.
const created = [];
const sent = [];
let closed = 0;
let failSend = false;

function installNodemailerStub()
{
	require.cache[nodemailerPath] = {
		id: nodemailerPath,
		filename: nodemailerPath,
		loaded: true,
		exports: {
			createTransport(options)
			{
				created.push(options);
				return {
					async sendMail(message)
					{
						if (failSend) throw new Error('smtp down');
						sent.push(message);
						return { messageId: 'id-1' };
					},
					close() { closed++; },
				};
			},
		},
	};
}

function createApp()
{
	return Object.assign(Object.create(App.prototype), { homeyHash: 'hash', updateLog() {} });
}

test('app.js does not load nodemailer at startup', () =>
{
	assert.equal(Object.keys(require.cache).some((key) => key.includes(`${path.sep}nodemailer${path.sep}`)), false);
});

test('diagnostic sends load nodemailer on demand, keep transport options and close the transporter', async () =>
{
	installNodemailerStub();
	const app = createApp();
	const result = await app.sendUnsupportedDevices([{ x: 1 }]);
	assert.deepEqual(result, { message: 'id-1' });
	assert.equal(created.length, 1);
	const options = created[0];
	assert.equal(options.pool, true);
	assert.equal(options.maxConnections, 1);
	assert.equal(options.host, 'mail.example');
	assert.equal(options.port, 465);
	assert.equal(options.secure, true);
	assert.deepEqual(options.auth, { user: 'user@example', pass: 'pw' });
	assert.equal(typeof options.getSocket, 'function');
	assert.equal(options.getSocket.name, 'createPinnedMailSocket');
	assert.equal(sent[0].to, 'to@example');
	assert.equal(sent[0].text, JSON.stringify([{ x: 1 }], null, 2));
	assert.equal(closed, 1);

	// sendLog uses the same pinned socket and also closes its transporter.
	app.diagLog = 'log text';
	const logResult = await app.sendLog('infoLog');
	assert.equal(logResult.message, 'OK');
	assert.equal(created.length, 2);
	assert.equal(created[1].getSocket, options.getSocket);
	assert.equal(created[1].port, 465);
	assert.equal(created[1].ignoreTLS, false);
	assert.equal(sent[1].text, 'log text');
	assert.equal(closed, 2);
});

test('the transporter is closed when sending fails', async () =>
{
	failSend = true;
	const app = createApp();
	await assert.rejects(app.sendUnsupportedDevices([{ x: 1 }]), /smtp down/);
	assert.equal(closed, 3);
	const logResult = await app.sendLog('infoLog');
	assert.equal(logResult.message, null);
	assert.equal(closed, 4);
});
