import * as vscode from 'vscode';
import { InheritanceMarker } from '../types';
import { getTreeConfig, areMarkersEqual } from '../utils';

export class InheritanceInlayHintsProvider implements vscode.InlayHintsProvider {
  private _onDidChangeInlayHints = new vscode.EventEmitter<void>();
  public readonly onDidChangeInlayHints = this._onDidChangeInlayHints.event;

  private markersMap = new Map<string, InheritanceMarker[]>();

  public updateMarkers(uri: vscode.Uri, markers: InheritanceMarker[]): void {
    const uriStr = uri.toString();
    const existing = this.markersMap.get(uriStr);
    if (existing && areMarkersEqual(existing, markers)) {
      return;
    }
    this.markersMap.set(uriStr, markers);
    this._onDidChangeInlayHints.fire();
  }

  public clear(uri?: vscode.Uri): void {
    if (uri) {
      this.markersMap.delete(uri.toString());
    } else {
      this.markersMap.clear();
    }
    this._onDidChangeInlayHints.fire();
  }

  public provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range,
    _token: vscode.CancellationToken
  ): vscode.InlayHint[] {
    if (!getTreeConfig<boolean>('enable', true) || !getTreeConfig<boolean>('enableInlayHints', false)) {
      return [];
    }

    const markers = this.markersMap.get(document.uri.toString()) || [];
    const hints: vscode.InlayHint[] = [];

    for (const marker of markers) {
      // Only include markers within requested viewport range
      if (
        marker.range.start.line < range.start.line ||
        marker.range.start.line > range.end.line
      ) {
        continue;
      }

      // Position hint at the end of the declaration line
      const line = document.lineAt(marker.range.start.line);
      const position = line.range.end;

      // Super hint
      if (marker.parents.length > 0) {
        const parent = marker.parents[0];
        const text =
          marker.parents.length === 1
            ? `  ⬆ ${parent.name}`
            : `  ⬆ Supers (${marker.parents.length})`;

        const part = new vscode.InlayHintLabelPart(text);
        part.tooltip = `Click to jump to ${parent.name}`;
        if (marker.parents.length === 1) {
          part.command = {
            title: 'Jump to Super',
            command: 'xfOmniNav.jumpToLocation',
            arguments: [parent],
          };
        } else {
          part.command = {
            title: 'Select Super',
            command: 'xfOmniNav.showTargetsQuickPick',
            arguments: [marker.parents, `Select super declaration for ${marker.symbolName}`],
          };
        }

        const hint = new vscode.InlayHint(position, [part], vscode.InlayHintKind.Type);
        hint.paddingLeft = true;
        hints.push(hint);
      }

      // Sub hint
      if (marker.children.length > 0) {
        const child = marker.children[0];
        const text =
          marker.children.length === 1
            ? `  ⬇ ${child.name}`
            : `  ⬇ Subs (${marker.children.length})`;

        const part = new vscode.InlayHintLabelPart(text);
        part.tooltip = `Click to jump to ${child.name}`;
        if (marker.children.length === 1) {
          part.command = {
            title: 'Jump to Sub',
            command: 'xfOmniNav.jumpToLocation',
            arguments: [child],
          };
        } else {
          part.command = {
            title: 'Select Sub',
            command: 'xfOmniNav.showTargetsQuickPick',
            arguments: [marker.children, `Select subclass/override for ${marker.symbolName}`],
          };
        }

        const hint = new vscode.InlayHint(position, [part], vscode.InlayHintKind.Type);
        hint.paddingLeft = true;
        hints.push(hint);
      }
    }

    return hints;
  }
}
