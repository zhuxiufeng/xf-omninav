import * as assert from 'assert';
import { test, describe } from 'node:test';
import { formatLocationLabel, createCommandUri, rangeToSerializable, serializableToRange } from '../src/utils';
import * as vscode from 'vscode';

describe('Inheritance Navigator Utils', () => {
  test('rangeToSerializable & serializableToRange', () => {
    const range = new vscode.Range(new vscode.Position(10, 4), new vscode.Position(10, 20));
    const serialized = rangeToSerializable(range);

    assert.strictEqual(serialized.startLine, 10);
    assert.strictEqual(serialized.startCharacter, 4);
    assert.strictEqual(serialized.endLine, 10);
    assert.strictEqual(serialized.endCharacter, 20);

    const restored = serializableToRange(serialized);
    assert.strictEqual(restored.start.line, 10);
    assert.strictEqual(restored.start.character, 4);
    assert.strictEqual(restored.end.line, 10);
    assert.strictEqual(restored.end.character, 20);
  });

  test('createCommandUri', () => {
    const payload = { uri: 'file:///sample.py', range: { startLine: 5, startCharacter: 0, endLine: 5, endCharacter: 10 } };
    const commandUri = createCommandUri('inheritanceNavigator.jumpToLocation', payload);

    assert.ok(commandUri.startsWith('command:inheritanceNavigator.jumpToLocation?'));
    const queryString = commandUri.slice('command:inheritanceNavigator.jumpToLocation?'.length);
    const decoded = JSON.parse(decodeURIComponent(queryString));
    assert.deepStrictEqual(decoded, [payload]);
  });

  test('formatLocationLabel', () => {
    const label = formatLocationLabel('file:///path/to/models.py', 14);
    assert.strictEqual(label, 'models.py:15');
  });
});
