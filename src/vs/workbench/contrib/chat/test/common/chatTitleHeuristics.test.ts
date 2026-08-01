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

	test('titles are Title Case, and code identifiers keep their own casing', () => {
		assert.strictEqual(generateHeuristicChatTitle('fix the login bug'), 'Fix: Login Bug');
		assert.strictEqual(generateHeuristicChatTitle('please do it'), 'Please Do It');
		// chatModel.ts was typed with an internal capital - it must survive untouched.
		assert.ok(generateHeuristicChatTitle('explain how chatModel.ts works').includes('chatModel.ts'));
		assert.ok(generateHeuristicChatTitle('update the README file').includes('README'));
	});

	test('social messages get a subjectless label', () => {
		assert.strictEqual(generateHeuristicChatTitle('hi'), 'Greeting');
		assert.strictEqual(generateHeuristicChatTitle('Hello there!'), 'Greeting');
		assert.strictEqual(generateHeuristicChatTitle('good morning, ready to work?'), 'Greeting');
		assert.strictEqual(generateHeuristicChatTitle('thanks!'), 'Thanks');
		assert.strictEqual(generateHeuristicChatTitle('who are you?'), 'Capabilities');
	});

	test('classifies common coding intents', () => {
		const expectations: [string, string][] = [
			['fix the login token refresh bug', 'Fix'],
			['my app crashes when I open the settings page', 'Debug'],
			['write unit tests for src/utils/parser.ts', 'Test'],
			['review my changes before I merge', 'Review'],
			['refactor the ChatWidget class', 'Refactor'],
			['optimize the model loading time on startup', 'Optimize'],
			['migrate from webpack to vite', 'Migrate'],
			['update the README with install instructions', 'Docs'],
			['install docker and set up CI for this repo', 'Setup'],
			['remove the deprecated oldApi module', 'Remove'],
			['add a dark theme toggle to the settings page', 'Build'],
			['rename the sessionId field to chatId', 'Update'],
			['where is the code that handles websocket reconnects?', 'Search'],
			['explain how chatModel.ts works', 'Explain'],
			['should I use a worker here?', 'Question'],
		];
		for (const [message, label] of expectations) {
			assert.strictEqual(classifyChatIntent(message).label, label, `wrong intent for: ${message}`);
			assert.ok(generateHeuristicChatTitle(message).startsWith(`${label}:`), `wrong title prefix for: ${message}`);
		}
	});

	test('keeps the distinguishing words in the subject', () => {
		assert.strictEqual(generateHeuristicChatTitle('fix the login token refresh bug'), 'Fix: Login Token Refresh Bug');
		assert.strictEqual(generateHeuristicChatTitle('migrate from webpack to vite'), 'Migrate: Webpack Vite');
	});

	test('strips markdown, code fences, urls and chat references', () => {
		const title = generateHeuristicChatTitle('**fix** the `parser` in #file:src/parser.ts see https://example.com/docs');
		assert.strictEqual(/https/i.test(title), false);
		assert.strictEqual(title.includes('#file'), false);
		assert.strictEqual(title.startsWith('Fix:'), true);
		assert.strictEqual(/parser/i.test(title), true);
	});

	test('a path and its file name are not repeated in the subject', () => {
		const title = generateHeuristicChatTitle('write unit tests for src/utils/parser.ts');
		assert.strictEqual(title.split(/parser\.ts/i).length - 1, 1, `duplicated file name: ${title}`);
	});

	test('titles stay short even for long messages', () => {
		const long = 'I want to build a full stack e-commerce application with authentication, payments, an admin dashboard, and a mobile client using React and Node';
		const title = generateHeuristicChatTitle(long);
		assert.ok(title.length <= 56, `title too long (${title.length}): ${title}`);
		assert.ok(title.startsWith('Build:'));
	});

	test('only the first line/sentence drives the subject', () => {
		const title = generateHeuristicChatTitle('fix the crash on startup.\nAlso there is a totally unrelated typo in the changelog.');
		assert.strictEqual(/changelog/i.test(title), false, title);
	});

	test('messages with no content words still produce a usable title', () => {
		assert.strictEqual(generateHeuristicChatTitle('please do it'), 'Please Do It');
	});
});
