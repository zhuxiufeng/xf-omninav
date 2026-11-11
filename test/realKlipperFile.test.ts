import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CallArgumentInspector } from '../src/visual/callArgumentInspector';
import { SymbolIndexer } from '../src/indexer/symbolIndexer';

test('Real Klipper File Inspection: nozzle_manager_wrapper.py', async (t) => {
  const filePath = '/home/zxf/cxsw/code/F039/kl_klipper_440x/klippy/extras/nozzle_manager_wrapper.py';
  if (!fs.existsSync(filePath)) {
    console.log('Skipping real klipper test: file not found');
    return;
  }

  const indexer = new SymbolIndexer({ subscriptions: [] } as any);
  const inspector = new CallArgumentInspector(indexer);

  // Pre-index other extras files to simulate active IDE workspace indexing
  const extrasDir = path.dirname(filePath);
  const extraFiles = ['pa_tester.py', 'adxl345.py', 'gcode_move.py', 'box_wrapper.py'];
  for (const f of extraFiles) {
    const fullPath = path.join(extrasDir, f);
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, 'utf8');
      const doc = new (vscode as any).MockTextDocument(content, fullPath, 'python');
      await indexer.indexDocument(doc);
    }
  }

  // Load nozzle_manager_wrapper.py
  const content = fs.readFileSync(filePath, 'utf8');
  const nozzleDoc = new (vscode as any).MockTextDocument(content, filePath, 'python');
  await indexer.indexDocument(nozzleDoc);

  await t.test('nozzle_manager_wrapper.py: line 3567 gcode_move.get_status should have ZERO errors', () => {
    const diags = inspector.inspectDocument(nozzleDoc);
    const line3567Diags = diags.filter((d) => d.range.start.line === 3566); // 0-based index for line 3567
    assert.equal(
      line3567Diags.length,
      0,
      `Line 3567 gcode_move.get_status() must not produce error, but got: ${line3567Diags.map((d) => d.message).join('; ')}`
    );
  });

  await t.test('nozzle_manager_wrapper.py: line 2538 result.update should have ZERO errors', () => {
    const diags = inspector.inspectDocument(nozzleDoc);
    const line2538Diags = diags.filter((d) => d.range.start.line === 2537); // 0-based index for line 2538
    assert.equal(
      line2538Diags.length,
      0,
      `Line 2538 result.update() must not produce error, but got: ${line2538Diags.map((d) => d.message).join('; ')}`
    );
  });

  await t.test('nozzle_manager_wrapper.py: line 260 config.get should have ZERO errors', () => {
    const diags = inspector.inspectDocument(nozzleDoc);
    const line260Diags = diags.filter((d) => d.range.start.line === 259); // 0-based index for line 260
    assert.equal(
      line260Diags.length,
      0,
      `Line 260 config.get() must not produce error, but got: ${line260Diags.map((d) => d.message).join('; ')}`
    );
  });

  inspector.dispose();
  indexer.dispose();
});
