import test from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { activate } from '../src/extension';

test('Extension Lifecycle tests', async (t) => {
  await t.test('activate: should cleanly initialize all subsystems without runtime TypeError', () => {
    const mockContext: any = {
      subscriptions: [],
      extensionPath: '/mock/path',
      globalState: {
        get: () => undefined,
        update: () => Promise.resolve(),
      },
      workspaceState: {
        get: () => undefined,
        update: () => Promise.resolve(),
      },
    };

    assert.doesNotThrow(() => {
      activate(mockContext);
    }, 'activate() should never throw runtime TypeError on subsystem calls');

    assert.ok(mockContext.subscriptions.length > 0, 'Should register subscriptions');
  });
});
