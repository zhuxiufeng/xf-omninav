import test from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { PyCharmFileErrorDecorator } from '../src/visual/fileErrorDecorator';

test('PyCharmFileErrorDecorator tests', async (t) => {
  const uriWithErrors = vscode.Uri.file('/workspace/test_error.py');
  const uriClean = vscode.Uri.file('/workspace/test_clean.py');
  const uriWithWarningOnly = vscode.Uri.file('/workspace/test_warning.py');

  // Set up mock diagnostics
  (vscode.languages as any).diagnosticsMap.set(uriWithErrors.toString(), [
    new (vscode as any).Diagnostic(
      new vscode.Range(0, 0, 0, 10),
      'SyntaxError: invalid syntax',
      (vscode as any).DiagnosticSeverity.Error
    ),
    new (vscode as any).Diagnostic(
      new vscode.Range(5, 0, 5, 10),
      'NameError: name foo is not defined',
      (vscode as any).DiagnosticSeverity.Error
    ),
  ]);

  (vscode.languages as any).diagnosticsMap.set(uriWithWarningOnly.toString(), [
    new (vscode as any).Diagnostic(
      new vscode.Range(2, 0, 2, 10),
      'Unused variable x',
      (vscode as any).DiagnosticSeverity.Warning
    ),
  ]);

  (vscode.languages as any).diagnosticsMap.set(uriClean.toString(), []);

  const decorator = new PyCharmFileErrorDecorator();

  await t.test('should decorate file with error badge and red error color when DiagnosticSeverity.Error is present', () => {
    const decoration = decorator.provideFileDecoration(uriWithErrors, {} as any) as any;
    assert.ok(decoration, 'Should return file decoration for file with errors');
    assert.equal(decoration.badge, '!', 'Default badge should be "!"');
    assert.equal(decoration.propagate, true, 'Propagate should be true to bubble to parent folders');
    assert.ok(decoration.color, 'ThemeColor should be defined');
    assert.equal((decoration.color as any).id, 'list.errorForeground');
    assert.ok(decoration.tooltip.includes('2 处代码错误'));
    assert.ok(decoration.tooltip.includes('SyntaxError'));
  });

  await t.test('should return undefined for clean files without errors', () => {
    const decoration = decorator.provideFileDecoration(uriClean, {} as any);
    assert.equal(decoration, undefined, 'Clean file should have no error decoration');
  });

  await t.test('should return undefined for files with only warnings (PyCharm behavior)', () => {
    const decoration = decorator.provideFileDecoration(uriWithWarningOnly, {} as any);
    assert.equal(decoration, undefined, 'Warning-only file should not receive error badge');
  });

  await t.test('should update decoration reactively when diagnostics change', () => {
    let firedUris: any = null;
    decorator.onDidChangeFileDecorations((e) => {
      firedUris = e;
    });

    // Clear errors from uriWithErrors
    (vscode.languages as any).diagnosticsMap.set(uriWithErrors.toString(), []);
    (vscode.languages as any).onDidChangeDiagnosticsEmitter.fire({
      uris: [uriWithErrors],
    });

    // After clearing, cached error count should become 0
    assert.equal(decorator.getCachedErrorCount(uriWithErrors), 0);
    const decoration = decorator.provideFileDecoration(uriWithErrors, {} as any);
    assert.equal(decoration, undefined, 'Cleared file should no longer have decoration');
  });

  decorator.dispose();
});
