/*
 * Seal fork-CI driver: runs the jQuery QUnit suite (test/index.html) in
 * headless Chrome via puppeteer-core and reports results on stdout.
 *
 * Usage: node test/seal-browser-runner.js <url>
 *   CHROME_PATH       Chrome/Chromium executable (required)
 *   SEAL_TEST_FILTER  optional QUnit `filter` (substring of "module: test")
 *   SEAL_SKIP_TESTS   optional "||"-separated list of exact "module: test" names
 *                     that are not registered (printed as SKIPPED)
 *
 * Exit: 0 all green, 1 failures, 2 timeout / suite never finished.
 */
/* jshint node: true */
( function() {
"use strict";

var puppeteer = require( "puppeteer-core" );

var OVERALL_TIMEOUT_MS = 40 * 60 * 1000;
var HEARTBEAT_MS = 120 * 1000;
var PREFIX = "__SEAL__";

var targetUrl = process.argv[ 2 ];
var testFilter = process.env.SEAL_TEST_FILTER || "";
var skipList = ( process.env.SEAL_SKIP_TESTS || "" ).split( "||" ).map( function( s ) {
	return s.trim();
} ).filter( function( s ) {
	return s.length > 0;
} );

if ( !targetUrl ) {
	console.error( "usage: node test/seal-browser-runner.js <url>" );
	process.exit( 2 );
}
if ( !process.env.CHROME_PATH ) {
	console.error( "CHROME_PATH is not set" );
	process.exit( 2 );
}
if ( testFilter ) {
	targetUrl += ( targetUrl.indexOf( "?" ) >= 0 ? "&" : "?" ) + "filter=" +
		encodeURIComponent( testFilter );
}

/*
 * Runs in every frame before any page script (serialized by puppeteer).
 * Only the top frame is hooked: the suite spawns many iframes that use
 * parent.QUnit or load QUnit themselves.
 */
function pageHook( skipNames ) {

	// Snapshot natives up front: a test that swaps window.JSON for a stub would
	// otherwise make the reporter throw from inside a QUnit callback, which can
	// wedge the whole suite.
	var nativeJSON = window.JSON,
		nativeStringify = nativeJSON.stringify,
		nativeLog = window.console.log,
		nativeConsole = window.console,
		skip = {},
		hooked = false,
		qunitRef, i;

	if ( window.top !== window ) {
		return;
	}

	for ( i = 0; i < skipNames.length; i++ ) {
		skip[ skipNames[ i ] ] = true;
	}

	function emit( type, data ) {
		try {
			nativeLog.call( nativeConsole, "__SEAL__" +
				nativeStringify.call( nativeJSON, { type: type, data: data } ) );
		} catch ( e ) {
			try {
				nativeLog.call( nativeConsole, "__SEAL__" + nativeStringify.call( nativeJSON, {
					type: type, data: { error: "unserializable payload: " + e }
				} ) );
			} catch ( e2 ) {
				nativeLog.call( nativeConsole, "seal reporter: cannot serialize " + type );
			}
		}
	}

	function dump( value ) {
		var out;
		try {
			if ( qunitRef && qunitRef.dump ) {
				out = qunitRef.dump.parse( value );
			} else {
				out = String( value );
			}
		} catch ( e ) {
			try {
				out = String( value );
			} catch ( e2 ) {
				out = "<undumpable>";
			}
		}
		if ( typeof out === "string" && out.length > 2000 ) {
			out = out.slice( 0, 2000 ) + "...";
		}
		return out;
	}

	function hookQUnit( qunit ) {
		var origTest;

		if ( hooked || !qunit ) {
			return;
		}
		hooked = true;

		// QUnit 1.17.1 assigns window.QUnit last, after config and the logging
		// callback registrars exist, so the public API is usable right here.
		qunit.config.reorder = false;

		// Keep pending and passed result rows out of the layout (QUnit's own
		// "hidepassed" option). QUnit 1.17 pre-renders a row for every test, so
		// otherwise the page outgrows the viewport and the window keeps the
		// 1px scroll that the offset module's setup forces, which breaks
		// "offset: hidden (display: none) element" (expects 0, reads 1).
		qunit.config.hidepassed = true;

		qunit.begin( function() {
			emit( "begin", {} );
		} );
		qunit.moduleStart( function( d ) {
			emit( "moduleStart", { name: d.name } );
		} );
		qunit.testStart( function( d ) {
			emit( "testStart", { name: d.name, module: d.module } );
		} );
		qunit.log( function( d ) {
			if ( d.result ) {
				return;
			}
			emit( "log", {
				module: d.module,
				name: d.name,
				message: d.message === undefined ? "" : String( d.message ),
				actual: dump( d.actual ),
				expected: dump( d.expected ),
				source: d.source === undefined ? "" : String( d.source )
			} );
		} );
		qunit.testDone( function( d ) {
			emit( "testDone", {
				name: d.name,
				module: d.module,
				failed: d.failed,
				passed: d.passed,
				total: d.total
			} );
		} );
		qunit.done( function( d ) {
			emit( "done", {
				failed: d.failed,
				passed: d.passed,
				total: d.total,
				runtime: d.runtime
			} );
		} );

		// Skip support: every registration path (QUnit.test, window.test,
		// QUnit.asyncTest, testinit.js's ajaxTest/testIframe helpers) ends in a
		// property lookup of QUnit.test, where the current module is known.
		origTest = qunit.test;
		qunit.test = function( testName ) {
			var mod = qunit.config.currentModule,
				key = ( mod && mod.name ? mod.name + ": " : "" ) + testName;
			if ( skip[ key ] ) {
				emit( "skip", { name: key } );
				return;
			}
			return origTest.apply( this, arguments );
		};
		window.test = qunit.test;
	}

	Object.defineProperty( window, "QUnit", {
		configurable: true,
		enumerable: true,
		get: function() {
			return qunitRef;
		},
		set: function( v ) {
			qunitRef = v;
			hookQUnit( v );
		}
	} );
}

function pad( s, n ) {
	s = String( s );
	while ( s.length < n ) {
		s += " ";
	}
	return s;
}

function main() {
	var browser, page,
		finished = false,
		qunitDone = null,
		modules = {},
		moduleOrder = [],
		failedTests = 0,
		passedTests = 0,
		assertions = 0,
		failedAssertions = 0,
		skippedTests = [],
		currentTest = null,
		lastProgress = Date.now(),
		lastHeartbeat = Date.now(),
		heartbeatTimer, overallTimer;

	function moduleStats( name ) {
		if ( !modules[ name ] ) {
			modules[ name ] = { tests: 0, failedTests: 0, assertions: 0, failedAssertions: 0 };
			moduleOrder.push( name );
		}
		return modules[ name ];
	}

	function printSummary() {
		var totalTests = passedTests + failedTests,
			unmatched = skipList.filter( function( n ) {
				return skippedTests.indexOf( n ) < 0;
			} );

		console.log( "" );
		console.log( "==================== SUMMARY ====================" );
		if ( skippedTests.length ) {
			console.log( "Skipped (not registered): " + skippedTests.length );
			skippedTests.forEach( function( n ) {
				console.log( "  SKIPPED: " + n );
			} );
		}
		unmatched.forEach( function( n ) {
			console.log( "  WARNING: SEAL_SKIP_TESTS entry matched no test: " + n );
		} );
		console.log( pad( "module", 28 ) + pad( "tests", 8 ) + pad( "failed", 8 ) +
			pad( "assertions", 12 ) + "failed" );
		moduleOrder.forEach( function( name ) {
			var m = modules[ name ];
			console.log( pad( name, 28 ) + pad( m.tests, 8 ) + pad( m.failedTests, 8 ) +
				pad( m.assertions, 12 ) + m.failedAssertions );
		} );
		if ( qunitDone ) {
			console.log( "QUnit done: assertions " + qunitDone.passed + " passed, " +
				qunitDone.failed + " failed, " + qunitDone.total + " total; runtime " +
				qunitDone.runtime + " ms" );
		} else {
			console.log( "QUnit done NEVER fired" );
		}
		console.log( "RESULT: " + totalTests + " tests / " + assertions + " assertions, " +
			failedAssertions + " failed (" + failedTests + " failed tests, " +
			skippedTests.length + " skipped)" );
	}

	function finish( code, reason ) {
		var closing;

		if ( finished ) {
			return;
		}
		finished = true;
		clearInterval( heartbeatTimer );
		clearTimeout( overallTimer );
		if ( reason ) {
			console.log( reason );
		}
		printSummary();
		console.log( "exit code " + code );
		closing = browser ? browser.close() : Promise.resolve();
		closing[ "catch" ]( function() {} ).then( function() {
			process.exit( code );
		} );

		// Do not let a hung browser.close() keep us alive.
		setTimeout( function() {
			process.exit( code );
		}, 15000 ).unref();
	}

	function onEvent( ev ) {
		var d = ev.data || {},
			m;

		switch ( ev.type ) {
		case "begin":
			console.log( "QUnit begin" );
			break;
		case "moduleStart":
			console.log( "MODULE " + d.name );
			break;
		case "testStart":
			currentTest = ( d.module ? d.module + ": " : "" ) + d.name;
			break;
		case "log":
			console.log( "    assertion failed: " + d.message );
			console.log( "      expected: " + d.expected );
			console.log( "      actual:   " + d.actual );
			if ( d.source ) {
				console.log( "      source:   " +
					String( d.source ).split( "\n" ).join( "\n                " ) );
			}
			break;
		case "testDone":
			lastProgress = Date.now();
			lastHeartbeat = lastProgress;
			currentTest = null;
			m = moduleStats( d.module || "(no module)" );
			m.tests++;
			m.assertions += d.total;
			m.failedAssertions += d.failed;
			assertions += d.total;
			failedAssertions += d.failed;
			if ( d.failed > 0 ) {
				m.failedTests++;
				failedTests++;
			} else {
				passedTests++;
			}
			console.log( ( d.failed > 0 ? "FAIL" : "PASS" ) + " [" + d.module + "] " + d.name +
				" (" + d.passed + "/" + d.total + ")" );
			break;
		case "skip":
			skippedTests.push( d.name );
			console.log( "SKIPPED: " + d.name );
			break;
		case "done":
			qunitDone = d;
			finish( d.failed === 0 && failedTests === 0 && passedTests > 0 ? 0 : 1 );
			break;
		default:
			console.log( "unknown event: " + JSON.stringify( ev ) );
		}
	}

	overallTimer = setTimeout( function() {
		finish( 2, "TIMEOUT: suite did not finish within " + ( OVERALL_TIMEOUT_MS / 60000 ) +
			" minutes" + ( currentTest ? " (running: " + currentTest + ")" : "" ) );
	}, OVERALL_TIMEOUT_MS );

	heartbeatTimer = setInterval( function() {
		var now = Date.now();
		if ( now - lastHeartbeat >= HEARTBEAT_MS ) {
			lastHeartbeat = now;
			console.log( "HEARTBEAT: no test completed in " +
				Math.round( ( now - lastProgress ) / 1000 ) + "s; running: " +
				( currentTest || "(none / between tests)" ) );
		}
	}, 5000 );

	console.log( "URL: " + targetUrl );
	if ( skipList.length ) {
		console.log( "SEAL_SKIP_TESTS: " + skipList.length + " test(s)" );
		skipList.forEach( function( n ) {
			console.log( "  - " + n );
		} );
	}

	puppeteer.launch( {
		executablePath: process.env.CHROME_PATH,
		headless: true,
		args: [ "--no-sandbox", "--disable-gpu", "--force-device-scale-factor=1" ]
	} ).then( function( b ) {
		browser = b;
		browser.on( "disconnected", function() {
			finish( 2, "ERROR: browser disconnected before QUnit done" );
		} );
		return browser.newPage();
	} ).then( function( p ) {
		page = p;
		page.on( "console", function( msg ) {
			var text = msg.text(),
				ev;
			if ( text.indexOf( PREFIX ) !== 0 ) {
				return;
			}
			try {
				ev = JSON.parse( text.slice( PREFIX.length ) );
			} catch ( e ) {
				console.log( "unparseable reporter line: " + text.slice( 0, 500 ) );
				return;
			}
			onEvent( ev );
		} );
		page.on( "pageerror", function( err ) {
			console.log( "PAGE ERROR: " + ( err && err.message ? err.message : String( err ) ) );
		} );
		page.on( "dialog", function( dialog ) {
			console.log( "DIALOG (" + dialog.type() + "): " + dialog.message() );
			dialog.dismiss()[ "catch" ]( function() {} );
		} );
		page.on( "error", function( err ) {
			finish( 2, "ERROR: page crashed: " +
				( err && err.message ? err.message : String( err ) ) );
		} );
		return page.evaluateOnNewDocument( pageHook, skipList );
	} ).then( function() {
		return page[ "goto" ]( targetUrl, { waitUntil: "load", timeout: 120000 } );
	} ).then( function() {
		console.log( "page loaded; waiting for QUnit done" );
	} )[ "catch" ]( function( err ) {
		finish( 2, "ERROR: " + ( err && err.stack ? err.stack : String( err ) ) );
	} );
}

main();
} )();
