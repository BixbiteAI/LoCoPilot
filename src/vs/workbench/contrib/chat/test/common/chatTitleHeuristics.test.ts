/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { DEFAULT_CHAT_TITLE, classifyChatIntent, generateHeuristicChatTitle } from '../../common/chatTitleHeuristics.js';

suite('ChatTitleHeuristics', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('empty / invalid input falls back to the default title', () => {
		assert.strictEqual(generateHeuristicChatTitle(''), DEFAULT_CHAT_TITLE);
		assert.strictEqual(generateHeuristicChatTitle('   \n  '), DEFAULT_CHAT_TITLE);
		assert.strictEqual(generateHeuristicChatTitle(undefined), DEFAULT_CHAT_TITLE);
		assert.strictEqual(generateHeuristicChatTitle(null), DEFAULT_CHAT_TITLE);
		assert.strictEqual(generateHeuristicChatTitle('```\nconst a = 1;\n```'), DEFAULT_CHAT_TITLE);
	});

	test('titles are always upper case', () => {
		for (const message of ['hi', 'fix the login bug', 'explain chatModel.ts', 'please do it']) {
			const title = generateHeuristicChatTitle(message);
			assert.strictEqual(title, title.toUpperCase(), `not upper case: ${title}`);
		}
	});

	test('social messages get a subjectless label', () => {
		assert.strictEqual(generateHeuristicChatTitle('hi'), 'GREETING');
		assert.strictEqual(generateHeuristicChatTitle('Hello there!'), 'GREETING');
		assert.strictEqual(generateHeuristicChatTitle('good morning, ready to work?'), 'GREETING');
		assert.strictEqual(generateHeuristicChatTitle('thanks!'), 'THANKS');
		assert.strictEqual(generateHeuristicChatTitle('who are you?'), 'CAPABILITIES');
	});

	test('classifies common coding intents', () => {
		const expectations: [string, string][] = [
			['fix the login token refresh bug', 'FIX'],
			['my app crashes when I open the settings page', 'DEBUG'],
			['write unit tests for src/utils/parser.ts', 'TEST'],
			['review my changes before I merge', 'REVIEW'],
			['refactor the ChatWidget class', 'REFACTOR'],
			['optimize the model loading time on startup', 'OPTIMIZE'],
			['migrate from webpack to vite', 'MIGRATE'],
			['update the README with install instructions', 'DOCS'],
			['install docker and set up CI for this repo', 'SETUP'],
			['remove the deprecated oldApi module', 'REMOVE'],
			['add a dark theme toggle to the settings page', 'BUILD'],
			['rename the sessionId field to chatId', 'UPDATE'],
			['where is the code that handles websocket reconnects?', 'SEARCH'],
			['explain how chatModel.ts works', 'EXPLAIN'],
			['should I use a worker here?', 'QUESTION'],
		];
		for (const [message, label] of expectations) {
			assert.strictEqual(classifyChatIntent(message).label, label, `wrong intent for: ${message}`);
			assert.ok(generateHeuristicChatTitle(message).startsWith(`${label}:`), `wrong title prefix for: ${message}`);
		}
	});

	test('keeps the distinguishing words in the subject', () => {
		assert.strictEqual(generateHeuristicChatTitle('fix the login token refresh bug'), 'FIX: LOGIN TOKEN REFRESH BUG');
		assert.strictEqual(generateHeuristicChatTitle('migrate from webpack to vite'), 'MIGRATE: WEBPACK VITE');
	});

	test('strips markdown, code fences, urls and chat references', () => {
		const title = generateHeuristicChatTitle('**fix** the `parser` in #file:src/parser.ts see https://example.com/docs');
		assert.strictEqual(title.includes('HTTPS'), false);
		assert.strictEqual(title.includes('#FILE'), false);
		assert.strictEqual(title.startsWith('FIX:'), true);
		assert.strictEqual(title.includes('PARSER'), true);
	});

	test('a path and its file name are not repeated in the subject', () => {
		const title = generateHeuristicChatTitle('write unit tests for src/utils/parser.ts');
		assert.strictEqual(title.split('PARSER.TS').length - 1, 1, `duplicated file name: ${title}`);
	});

	test('titles stay short even for long messages', () => {
		const long = 'I want to build a full stack e-commerce application with authentication, payments, an admin dashboard, and a mobile client using React and Node';
		const title = generateHeuristicChatTitle(long);
		assert.ok(title.length <= 56, `title too long (${title.length}): ${title}`);
		assert.ok(title.startsWith('BUILD:'));
	});

	test('only the first line/sentence drives the subject', () => {
		const title = generateHeuristicChatTitle('fix the crash on startup.\nAlso there is a totally unrelated typo in the changelog.');
		assert.strictEqual(title.includes('CHANGELOG'), false, title);
	});

	test('messages with no content words still produce a usable title', () => {
		assert.strictEqual(generateHeuristicChatTitle('please do it'), 'PLEASE DO IT');
	});
});
