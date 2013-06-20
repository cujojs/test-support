/*
 * Copyright 2013 the original author or authors
 * @license MIT, see LICENSE.txt for details
 *
 * @author Scott Andrews
 */

var childProcess          = require('child_process'),
    webdriver             = require('wd'),
    sauceConnect          = require('sauce-connect-launcher'),
    when                  = require('when'),
    sequence              = require('when/sequence'),
    rest                  = require('rest'),
    interceptor           = require('rest/interceptor'),
    basicAuthInterceptor  = require('rest/interceptor/basicAuth'),
    mimeInterceptor       = require('rest/interceptor/mime'),
    pathPrefixInterceptor = require('rest/interceptor/pathPrefix');

/**
 * Distributed in browser testing with Sauce Labs
 */
exports.drive = function drive(opts) {
	'use strict';

	var username, accessKey, suiteFailed, projectName, travisJobNumber, travisCommit, tunnelIdentifier, buster, sauceRestClient, passedStatusInterceptor;

	suiteFailed = false;

	username = opts.user;
	accessKey = opts.pass;
	travisJobNumber = process.env.TRAVIS_JOB_NUMBER || '';
	travisCommit = process.env.TRAVIS_COMMIT || '';
	tunnelIdentifier = travisJobNumber || Math.floor(Math.random() * 10000);

	try {
		projectName = require('../../../package.json').name;
	}
	catch (e) {
		projectName = 'unknown';
	}

	if (travisJobNumber && !/\.1$/.test(travisJobNumber)) {
		// give up this is not the primary job for the build
		return;
	}

	sauceRestClient = rest.chain(mimeInterceptor, { mime: 'application/json' })
	                      .chain(basicAuthInterceptor, { username: username, password: accessKey })
	                      .chain(pathPrefixInterceptor, { prefix: 'http://saucelabs.com/rest/v1' });
	passedStatusInterceptor = interceptor({
		request: function (passed, config) {
			return {
				method: 'put',
				path: '/{username}/jobs/{jobId}',
				params: {
					username: config.username,
					jobId: config.jobId
				},
				entity: {
					passed: passed
				}
			};
		}
	});

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

	function testWith(browser, environment) {
		var d, updateEnvironmentPassedStatus;

		d = when.defer();

		environment.name = projectName + ' - ' +
			(travisJobNumber ? travisJobNumber + ' - ' : '') +
			environment.browserName + ' ' + (environment.version || 'latest') +
			' on ' + (environment.platform || 'any platform');
		environment.build = travisJobNumber ? travisJobNumber + ' - ' + travisCommit : 'manual';
		environment['tunnel-identifier'] = tunnelIdentifier;
		environment['max-duration'] = 300; // 5 minutes

		// most info is below the fold, so images are not helpful, html source is
		environment['record-video'] = false;
		environment['record-screenshots'] = false;
		environment['capture-html'] = true;

		try {
			browser.init(environment, function (err, sessionID) {
				console.log('Testing ' + environment.name);
				updateEnvironmentPassedStatus = sauceRestClient.chain(passedStatusInterceptor, { username: username, jobId: sessionID });
				browser.get('http://localhost:' + opts.port + '/', function (err) {
					if (err) {
						throw err;
					}
					browser.waitForElementByCssSelector('.stats > h2', 3e5, function (/* err */) {
						browser.elementByCssSelector('.stats > h2', function (err, stats) {
							browser.text(stats, function (err, text) {
								browser.quit(function () {
									environment.passed = text === 'Tests OK';
									console.log((environment.passed ? 'PASS' : 'FAIL') + ' ' + environment.name);
									if (!environment.passed) {
										suiteFailed = true;
									}
									updateEnvironmentPassedStatus(environment.passed).always(d.resolve);
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
			suiteFailed = true;
			if (updateEnvironmentPassedStatus) {
				updateEnvironmentPassedStatus(false);
			}
			d.reject(e);
		}

		return d.promise;
	}

	// must use a port that sauce connect will tunnel
	buster = launchBuster(opts.port);

	console.log('Opening tunnel to Sauce Labs');
	sauceConnect({ username: username, accessKey: accessKey, tunnelIdentifier: tunnelIdentifier, 'no_progress': true }, function (err, tunnel) {

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
				return testWith(browser, environment);
			};
		});

		sequence(tasks).always(function () {
			console.log('Stopping buster');
			buster.exit();

			console.log('Closing tunnel to Sauce Labs');
			tunnel.close();

			process.exit(suiteFailed ? 1 : 0);
		});

	});

};
