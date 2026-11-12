import * as fs from 'fs';
import * as path from 'path';
import * as vscode from '../test/vscode-mock';
import { SymbolIndexer } from '../src/indexer/symbolIndexer';
import { CallArgumentInspector } from '../src/visual/callArgumentInspector';

async function main() {
  console.log('=== Starting Real Klipper Diagnostic Audit ===');
  const indexer = new SymbolIndexer();
  const inspector = new CallArgumentInspector(indexer);

  const klipperDir = '/home/zxf/cxsw/code/F039/kl_klipper_440x/klippy/extras';
  const targetFiles = [
    'box_nano_wrapper.py',
    'box_wrapper.py',
    'nozzle_manager_wrapper.py',
    'gcode_move.py',
  ];

  // 1. Index all target files first
  console.log('Indexing files...');
  const t0 = Date.now();
  for (const f of targetFiles) {
    const fullPath = path.join(klipperDir, f);
    if (fs.existsSync(fullPath)) {
      const text = fs.readFileSync(fullPath, 'utf8');
      const uri = (vscode as any).Uri.file(fullPath);
      indexer.indexFile(uri, text);
      console.log(`Indexed ${f}: ${text.split('\n').length} lines`);
    }
  }
  console.log(`Indexing completed in ${Date.now() - t0}ms. Total symbols: ${indexer.totalSymbols}`);

  // 2. Run inspectDocument on each file and collect diagnostics
  for (const f of targetFiles) {
    const fullPath = path.join(klipperDir, f);
    if (!fs.existsSync(fullPath)) continue;

    const text = fs.readFileSync(fullPath, 'utf8');
    const doc = new (vscode as any).MockTextDocument(text, fullPath, 'python');
    const tStart = Date.now();
    const diags = inspector.inspectDocument(doc);
    const duration = Date.now() - tStart;

    console.log(`\n========================================`);
    console.log(`File: ${f} (${doc.lineCount} lines) - Scanned in ${duration}ms`);
    console.log(`Total diagnostics found: ${diags.length}`);
    console.log(`========================================`);

    for (const d of diags) {
      const lineNum = d.range.start.line + 1;
      const lineText = doc.lineAt(d.range.start.line).text.trim();
      console.log(`  Line ${lineNum}: [${d.code || 'error'}] ${d.message}`);
      console.log(`    Code: ${lineText}`);
    }
  }

  inspector.dispose();
  indexer.dispose();
}

main().catch(console.error);
