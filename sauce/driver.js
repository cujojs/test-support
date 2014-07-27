/*
 * Copyright 2013-2014 the original author or authors
 * @license MIT, see LICENSE.txt for details
 *
 * @author Scott Andrews
 */

var childProcess          = require('child_process'),
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

	sauceRestClient = rest.wrap(mimeInterceptor, { mime: 'application/json' })
	                      .wrap(basicAuthInterceptor, { username: username, password: accessKey })
	                      .wrap(pathPrefixInterceptor, { prefix: 'http://saucelabs.com/rest/v1' });
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
		argv = ['-p', '' + port, '-e', 'browser'];

		childProcess.exec(
			'command -v buster-static',
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

	// must use a port that sauce connect will tunnel
	buster = launchBuster(opts.port);

	console.log('Opening tunnel to Sauce Labs');
	sauceConnect({ username: username, accessKey: accessKey, tunnelIdentifier: tunnelIdentifier, 'no_progress': true }, function (err, tunnel) {

		if (err) {
			// some tunnel error occur as a normal result of testing
			// TODO optionally log
			return;
		}

		console.log('Sauce Labs tunnel is ready for traffic');

		if (opts.manual) {
			// let the user run test manually, hold the tunnel open until this process is killed
			return;
		}

		sauceRestClient({
			method: 'post',
			path: '/{username}/js-tests',
			params: {
				username: username
			},
			entity: {
				framework: 'custom',
				url: 'http://localhost:' + opts.port + '/?reporter=sauce',
				platforms: opts.browsers,
				tunnel_identifier: tunnelIdentifier
			}
		}).then(function (response) {
			// poll for success
			console.log(response);
		}).finally(function () {
			console.log('Stopping buster');
			buster.exit();

			console.log('Closing tunnel to Sauce Labs');
			tunnel.close();

			process.exit(suiteFailed ? 1 : 0);
		});

	});

};
