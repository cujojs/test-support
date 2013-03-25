/*
 * Copyright 2013 the original author or authors
 * @license MIT, see LICENSE.txt for details
 *
 * @author Scott Andrews
 */

var childProcess = require('child_process'),
    webdriver    = require('wd'),
    sauceConnect = require('sauce-connect-launcher'),
    when         = require('when'),
    sequence     = require('when/sequence'),
    rest         = require('rest'),
    interceptor  = require('rest/interceptor'),
    pathPrefix   = require('rest/interceptor/pathPrefix'),
    basicAuth    = require('rest/interceptor/basicAuth'),
    mime         = require('rest/interceptor/mime');


/**
 * Distributed in browser testing with Sauce Labs
 */
exports.drive = function drive(opts) {
	'use strict';

	var failed, projectName, travisJobNumber, travisCommit, subAccountClient, buster;

	failed = false;

	projectName = require('../../../package.json').name;
	travisJobNumber = process.env.TRAVIS_JOB_NUMBER || '';
	travisCommit = process.env.TRAVIS_COMMIT || '';

	if (travisJobNumber && !/\.1$/.test(travisJobNumber)) {
		// give up this is not the primary job for the build
		return;
	}

	subAccountClient = (function (username, password) {

		if (!travisJobNumber) {
			// manual build, no need for a sub account
			/*jshint camelcase:false */
			return function (request) {
				return when({
					request: request,
					entity: { id: username, access_key: password }
				});
			};
		}

		return rest.chain(pathPrefix, { prefix: 'https://saucelabs.com/rest/v1/users/{username}' })
		           .chain(mime, { mime: 'application/json' })
		           .chain(basicAuth, { username: username, password: password });

	}(opts.user, opts.pass));

	function launchBuster(port) {
		var buster, argv;
		
		buster = {};
		argv = ['static', '-p', '' + port, '-e', 'browser'];

		childProcess.exec(
			'command -v buster',
			function (error, stdout /*, stderr */) {
				if (error) {
					console.log('Unknown error occurred when running wrapper script.');
				}
				else {
					var mod = stdout.split('\n')[0];
					var run = childProcess.spawn(mod, argv, { stdio: 'pipe' });
					buster.exit = function () {
						run.kill();
					};
				}
			}
		);

		return buster;
	}

	function testWith(browser, environment, passFailInterceptor) {
		var d, passFail;

		d = when.defer();

		environment.name = projectName + ' - ' +
			(travisJobNumber ? travisJobNumber + ' - ' : '') +
			environment.browserName + ' ' + (environment.version || 'latest') +
			' on ' + (environment.platform || 'any platform');
		environment.build = travisJobNumber ? travisJobNumber + ' - ' + travisCommit : 'manual';
		environment['max-duration'] = 300; // 5 minutes

		// most info is below the fold, so images are not helpful, html source is
		environment['record-video'] = false;
		environment['record-screenshots'] = false;
		environment['capture-html'] = true;

		try {
			browser.init(environment, function (err, sessionID) {
				console.log('Testing ' + environment.name);
				passFail = passFailInterceptor({ jobId: sessionID });
				browser.get('http://localhost:' + opts.port + '/', function (err) {
					if (err) {
						throw err;
					}
					browser.waitForElementByCssSelector('.stats > h2', 3e5, function (/* err */) {
						browser.elementByCssSelector('.stats > h2', function (err, stats) {
							browser.text(stats, function (err, text) {
								browser.quit(function () {
									var passed = text === 'Tests OK';
									console.log((passed ? 'PASS' : 'FAIL') + ' ' + environment.name);
									if (!passed) {
										failed = true;
									}
									passFail(passed).always(d.resolve);
								});
							});
						});
					});
				});
			});
		}
		catch (e) {
			console.log('FAIL ' + environment.name);
			console.error(e.message);
			failed = true;
			if (passFail) {
				passFail(false);
			}
			d.reject(e);
		}

		return d.promise;
	}

	// must use a port that sauce connect will tunnel
	buster = launchBuster(opts.port);

	// create a sub account to allow multiple concurrent tunnels
	subAccountClient({ method: 'post', params: { username: opts.user }, entity: { username: opts.user + '-' + travisJobNumber + '-' + Date.now(), password: Math.floor(Math.random() * 1e6).toString(), 'name': 'transient account', email: 'transient@example.com' } }).then(function (subAccount) {

		var username, accessKey, passFailInterceptor;

		/*jshint camelcase:false */
		username = subAccount.entity.id;
		accessKey = subAccount.entity.access_key;

		passFailInterceptor = (function (username, password) {
			return interceptor({
				request: function (passed, config) {
					return {
						method: 'put',
						path: 'http://saucelabs.com/rest/v1/{username}/jobs/{jobId}',
						params: {
							username: username,
							jobId: config.jobId
						},
						entity: {
							passed: passed
						}
					};
				},
				client: basicAuth(mime({ mime: 'application/json' }), { username: username, password: password })
			});
		}(username, accessKey));

		console.log('Opening tunnel to Sauce Labs');
		sauceConnect({ username: username, accessKey: accessKey, 'no_progress': true }, function (err, tunnel) {

			if (err) {
				// some tunnel error occur as a normal result of testing
				// TODO optionally log
				return;
			}

			if (opts.manual) {
				// let the user run test manually, hold the tunnel open until this process is killed
				return;
			}

			var browser, tasks;

			browser = webdriver.remote(opts['remote-host'], opts['remote-port'], username, accessKey);

			browser.on('status', function (info) {
				console.log('\x1b[36m%s\x1b[0m', info);
			});
			browser.on('command', function (meth, path) {
				console.log(' > \x1b[33m%s\x1b[0m: %s', meth, path);
			});

			tasks = opts.browsers.map(function (environment) {
				return function () {
					return testWith(browser, environment, passFailInterceptor);
				};
			});

			sequence(tasks).always(function () {
				console.log('Stopping buster');
				buster.exit();

				console.log('Closing tunnel to Sauce Labs');
				tunnel.close();

				subAccountClient({ method: 'delete', params: { username: username } }).always(function () {
					// TODO find out if delete is actaully possible

					// should exit cleanly, but sometimes the tunnel is stuck open
					process.exit(failed ? 1 : 0);
				});
			});

		});

	});

};
