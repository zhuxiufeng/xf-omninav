import * as vscode from 'vscode';
import { InheritanceMarker } from '../types';
import { getTreeConfig, areMarkersEqual } from '../utils';

export class InheritanceCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  private markersMap = new Map<string, InheritanceMarker[]>();

  public updateMarkers(uri: vscode.Uri, markers: InheritanceMarker[]): void {
    const uriStr = uri.toString();
    const existing = this.markersMap.get(uriStr);
    if (existing && areMarkersEqual(existing, markers)) {
      return;
    }
    this.markersMap.set(uriStr, markers);
    this._onDidChangeCodeLenses.fire();
  }

  public clear(uri?: vscode.Uri): void {
    if (uri) {
      this.markersMap.delete(uri.toString());
    } else {
      this.markersMap.clear();
    }
    this._onDidChangeCodeLenses.fire();
  }

  public provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): vscode.CodeLens[] {
    if (!getTreeConfig<boolean>('enable', true) || !getTreeConfig<boolean>('enableCodeLens', true)) {
      return [];
    }

    const markers = this.markersMap.get(document.uri.toString()) || [];
    const codeLenses: vscode.CodeLens[] = [];
    const seenKeys = new Set<string>();

    const addLens = (lens: vscode.CodeLens) => {
      const key = `${lens.range.start.line}#${lens.command?.title || ''}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        codeLenses.push(lens);
      }
    };

    for (const marker of markers) {
      const lineRange = new vscode.Range(
        marker.selectionRange.start.line,
        0,
        marker.selectionRange.start.line,
        0
      );

      // Super / Parent CodeLens
      if (marker.parents.length > 0) {
        if (marker.parents.length === 1) {
          const parent = marker.parents[0];
          addLens(
            new vscode.CodeLens(lineRange, {
              title: `⬆ ${parent.name || 'Super'}`,
              tooltip: `Jump to ${parent.description || parent.name}`,
              command: 'xfOmniTree.jumpToLocation',
              arguments: [parent],
            })
          );
        } else {
          addLens(
            new vscode.CodeLens(lineRange, {
              title: `⬆ Supers (${marker.parents.length})`,
              tooltip: 'Click to select superclass / method to jump to',
              command: 'xfOmniTree.showTargetsQuickPick',
              arguments: [marker.parents, `Select superclass / method for ${marker.symbolName}`],
            })
          );
        }
      }

      // Sub / Children CodeLens
      if (marker.children.length > 0) {
        if (marker.children.length === 1) {
          const child = marker.children[0];
          addLens(
            new vscode.CodeLens(lineRange, {
              title: `⬇ ${child.name || 'Sub'}`,
              tooltip: `Jump to ${child.description || child.name}`,
              command: 'xfOmniTree.jumpToLocation',
              arguments: [child],
            })
          );
        } else {
          const names = marker.children
            .map((c) => c.name.split('.').pop() || c.name)
            .slice(0, 3)
            .join(', ');
          const more = marker.children.length > 3 ? ` +${marker.children.length - 3}` : '';
          addLens(
            new vscode.CodeLens(lineRange, {
              title: `⬇ ${names}${more} (${marker.children.length})`,
              tooltip: 'Click to select subclass / overriding method to jump to',
              command: 'xfOmniTree.showTargetsQuickPick',
              arguments: [
                marker.children,
                `Select subclass / implementation for ${marker.symbolName}`,
              ],
            })
          );
        }
      }
    }

    return codeLenses;
  }
}
