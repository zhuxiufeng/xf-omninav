import { parentPort } from 'worker_threads';
import { SymbolParser } from './symbolParser';

if (parentPort) {
  parentPort.on(
    'message',
    (msg: { id: number; uriStr: string; text: string; workspaceRoot?: string }) => {
      try {
        const uri = {
          scheme: 'file',
          fsPath: msg.uriStr.startsWith('file://')
            ? msg.uriStr.replace(/^file:\/\//, '')
            : msg.uriStr,
          path: msg.uriStr,
          toString() {
            return msg.uriStr;
          },
        } as any;

        const defs = SymbolParser.parseText(msg.text, uri, undefined, msg.workspaceRoot);
        const serialized = defs.map((d) => ({
          name: d.name,
          kind: d.kind,
          containerName: d.containerName,
          parentContainers: d.parentContainers,
          r: (d as any)._r || [
            d.range.start.line,
            d.range.start.character,
            d.range.end.line,
            d.range.end.character,
          ],
          sr: (d as any)._sr || [
            d.selectionRange.start.line,
            d.selectionRange.start.character,
            d.selectionRange.end.line,
            d.selectionRange.end.character,
          ],
          signature: d.signature,
          fileRelativePath: d.fileRelativePath,
          isExported: d.isExported,
          docstring: d.docstring,
        }));

        parentPort!.postMessage({ id: msg.id, uriStr: msg.uriStr, defs: serialized });
      } catch (err: any) {
        parentPort!.postMessage({ id: msg.id, uriStr: msg.uriStr, error: String(err) });
      }
    }
  );
}
