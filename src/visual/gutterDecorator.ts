import * as vscode from 'vscode';
import * as path from 'path';
import { InheritanceMarker, TargetLocation } from '../types';
import { createCommandUri, formatLocationLabel, ICON_DATA_URIS, getTreeConfig, areMarkersEqual } from '../utils';

export class InheritanceDecorator implements vscode.Disposable {
  private upDecorationType!: vscode.TextEditorDecorationType;
  private downDecorationType!: vscode.TextEditorDecorationType;
  private upDownDecorationType!: vscode.TextEditorDecorationType;

  // Active markers map: editor URI -> markers
  private activeMarkers = new Map<string, InheritanceMarker[]>();

  // Track editors that already have current decorations applied to prevent re-render flicker
  private appliedEditors = new WeakSet<vscode.TextEditor>();

  constructor(private context: vscode.ExtensionContext) {
    this.createDecorationTypes();
  }

  /**
   * Create or re-create decoration types based on user configuration.
   */
  public createDecorationTypes(): void {
    this.appliedEditors = new WeakSet();
    if (this.upDecorationType) {
      this.upDecorationType.dispose();
      this.downDecorationType.dispose();
      this.upDownDecorationType.dispose();
    }

    const gutterPosition = getTreeConfig<'inline' | 'glyphMargin' | 'both'>('gutterPosition', 'glyphMargin');

    if (gutterPosition === 'inline') {
      this.upDecorationType = vscode.window.createTextEditorDecorationType({
        before: {
          contentText: ' ⬆ ',
          color: '#4EC9B0',
          fontWeight: 'bold',
        },
      });

      this.downDecorationType = vscode.window.createTextEditorDecorationType({
        before: {
          contentText: ' ⬇ ',
          color: '#4EC9B0',
          fontWeight: 'bold',
        },
      });

      this.upDownDecorationType = vscode.window.createTextEditorDecorationType({
        before: {
          contentText: ' ↕ ',
          color: '#4EC9B0',
          fontWeight: 'bold',
        },
      });
    } else if (gutterPosition === 'both') {
      this.upDecorationType = vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.parse(ICON_DATA_URIS.dark_up_arrow),
        gutterIconSize: 'contain',
        dark: { gutterIconPath: vscode.Uri.parse(ICON_DATA_URIS.dark_up_arrow) },
        light: { gutterIconPath: vscode.Uri.parse(ICON_DATA_URIS.light_up_arrow) },
        before: {
          contentText: ' ⬆ ',
          color: '#4EC9B0',
          fontWeight: 'bold',
        },
      });

      this.downDecorationType = vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.parse(ICON_DATA_URIS.dark_down_arrow),
        gutterIconSize: 'contain',
        dark: { gutterIconPath: vscode.Uri.parse(ICON_DATA_URIS.dark_down_arrow) },
        light: { gutterIconPath: vscode.Uri.parse(ICON_DATA_URIS.light_down_arrow) },
        before: {
          contentText: ' ⬇ ',
          color: '#4EC9B0',
          fontWeight: 'bold',
        },
      });

      this.upDownDecorationType = vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.parse(ICON_DATA_URIS.dark_up_down_arrow),
        gutterIconSize: 'contain',
        dark: { gutterIconPath: vscode.Uri.parse(ICON_DATA_URIS.dark_up_down_arrow) },
        light: { gutterIconPath: vscode.Uri.parse(ICON_DATA_URIS.light_up_down_arrow) },
        before: {
          contentText: ' ↕ ',
          color: '#4EC9B0',
          fontWeight: 'bold',
        },
      });
    } else {
      // Default: glyphMargin (Classic PyCharm style)
      this.upDecorationType = vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.parse(ICON_DATA_URIS.dark_up_arrow),
        gutterIconSize: 'contain',
        dark: { gutterIconPath: vscode.Uri.parse(ICON_DATA_URIS.dark_up_arrow) },
        light: { gutterIconPath: vscode.Uri.parse(ICON_DATA_URIS.light_up_arrow) },
      });

      this.downDecorationType = vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.parse(ICON_DATA_URIS.dark_down_arrow),
        gutterIconSize: 'contain',
        dark: { gutterIconPath: vscode.Uri.parse(ICON_DATA_URIS.dark_down_arrow) },
        light: { gutterIconPath: vscode.Uri.parse(ICON_DATA_URIS.light_down_arrow) },
      });

      this.upDownDecorationType = vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.parse(ICON_DATA_URIS.dark_up_down_arrow),
        gutterIconSize: 'contain',
        dark: { gutterIconPath: vscode.Uri.parse(ICON_DATA_URIS.dark_up_down_arrow) },
        light: { gutterIconPath: vscode.Uri.parse(ICON_DATA_URIS.light_up_down_arrow) },
      });
    }
  }

  /**
   * Apply markers to the given editor.
   */
  public applyDecorations(editor: vscode.TextEditor, markers: InheritanceMarker[]): void {
    const uriStr = editor.document.uri.toString();
    const existing = this.activeMarkers.get(uriStr);

    // If active markers already match and were already set on this editor, skip to avoid flicker
    if (existing && this.appliedEditors.has(editor) && areMarkersEqual(existing, markers)) {
      return;
    }

    this.activeMarkers.set(uriStr, markers);
    this.appliedEditors.add(editor);

    const enableGutterIcons = getTreeConfig<boolean>('enableGutterIcons', true);
    const gutterPosition = getTreeConfig<'inline' | 'glyphMargin' | 'both'>('gutterPosition', 'glyphMargin');

    if (!enableGutterIcons) {
      editor.setDecorations(this.upDecorationType, []);
      editor.setDecorations(this.downDecorationType, []);
      editor.setDecorations(this.upDownDecorationType, []);
      return;
    }

    // Get active breakpoint lines to avoid colliding with user breakpoints in glyphMargin mode
    const breakpointLines = new Set<number>();
    if (vscode.debug && vscode.debug.breakpoints) {
      for (const bp of vscode.debug.breakpoints) {
        if (bp instanceof vscode.SourceBreakpoint) {
          if (bp.location && bp.location.uri.toString() === editor.document.uri.toString()) {
            breakpointLines.add(bp.location.range.start.line);
          }
        }
      }
    }

    const upOptions: vscode.DecorationOptions[] = [];
    const downOptions: vscode.DecorationOptions[] = [];
    const upDownOptions: vscode.DecorationOptions[] = [];

    for (const marker of markers) {
      const lineNum = marker.selectionRange.start.line;
      // In glyphMargin mode, if user has set a breakpoint on this line, yield to the breakpoint
      if (gutterPosition === 'glyphMargin' && breakpointLines.has(lineNum)) {
        continue;
      }

      const targetRange =
        gutterPosition === 'inline'
          ? new vscode.Range(marker.selectionRange.start, marker.selectionRange.start)
          : editor.document.lineAt(lineNum).range;

      const hoverMessage = this.buildHoverMessage(marker);
      const decorationOption: vscode.DecorationOptions = {
        range: targetRange,
        hoverMessage,
      };

      if (marker.markerKind === 'both') {
        upDownOptions.push(decorationOption);
      } else if (marker.markerKind === 'super') {
        upOptions.push(decorationOption);
      } else if (marker.markerKind === 'sub') {
        downOptions.push(decorationOption);
      }
    }

    editor.setDecorations(this.upDecorationType, upOptions);
    editor.setDecorations(this.downDecorationType, downOptions);
    editor.setDecorations(this.upDownDecorationType, upDownOptions);
  }

  /**
   * Clear all decorations on an editor.
   */
  public clearDecorations(editor: vscode.TextEditor): void {
    this.appliedEditors.delete(editor);
    editor.setDecorations(this.upDecorationType, []);
    editor.setDecorations(this.downDecorationType, []);
    editor.setDecorations(this.upDownDecorationType, []);
    this.activeMarkers.delete(editor.document.uri.toString());
  }

  /**
   * Get markers for a document.
   */
  public getMarkers(uri: vscode.Uri): InheritanceMarker[] {
    return this.activeMarkers.get(uri.toString()) || [];
  }

  /**
   * Find marker at a given position in an editor.
   */
  public getMarkerAtPosition(
    uri: vscode.Uri,
    position: vscode.Position
  ): InheritanceMarker | undefined {
    const markers = this.getMarkers(uri);
    const exact = markers.find((m) => m.range.contains(position));
    if (exact) {
      return exact;
    }
    return markers.find((m) => m.range.start.line === position.line);
  }

  /**
   * Build markdown hover message with clickable navigation links.
   */
  private buildHoverMessage(marker: InheritanceMarker): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;

    const isMethod =
      marker.symbolKind === vscode.SymbolKind.Method ||
      marker.symbolKind === vscode.SymbolKind.Function;

    if (marker.markerKind === 'super') {
      const title = isMethod
        ? `$(arrow-up) **Overrides method in superclass**`
        : `$(arrow-up) **Inherits from superclass**`;
      md.appendMarkdown(`${title}\n\n`);
      this.appendTargetLinks(md, marker.parents);
    } else if (marker.markerKind === 'sub') {
      const title = isMethod
        ? `$(arrow-down) **Is overridden in subclass**`
        : `$(arrow-down) **Is extended by subclass**`;
      md.appendMarkdown(`${title}\n\n`);
      this.appendTargetLinks(md, marker.children);
    } else if (marker.markerKind === 'both') {
      md.appendMarkdown(
        `$(arrow-both) **Inheritance & Overrides for \`${marker.symbolName}\`**\n\n`
      );
      if (marker.parents.length > 0) {
        md.appendMarkdown(`**Superclass / Declaration:**\n`);
        this.appendTargetLinks(md, marker.parents);
      }
      if (marker.children.length > 0) {
        md.appendMarkdown(`\n**Subclass / Overrides:**\n`);
        this.appendTargetLinks(md, marker.children);
      }
    }

    md.appendMarkdown(`\n---\n*💡 Click any link above or press \`Ctrl+U\` / \`Ctrl+Alt+B\` to jump.*`);
    return md;
  }

  /**
   * Append markdown links with command URIs.
   */
  private appendTargetLinks(md: vscode.MarkdownString, targets: TargetLocation[]): void {
    for (const target of targets) {
      const locLabel = formatLocationLabel(target.uri, target.range.startLine);
      const displayName = target.name || locLabel;
      const commandUri = createCommandUri('xfOmniTree.jumpToLocation', target);

      md.appendMarkdown(`* [${displayName} \`(${locLabel})\`](${commandUri})`);
      if (target.description) {
        md.appendMarkdown(` — *${target.description}*`);
      }
      md.appendMarkdown(`\n`);
    }
  }

  public dispose(): void {
    this.upDecorationType.dispose();
    this.downDecorationType.dispose();
    this.upDownDecorationType.dispose();
    this.activeMarkers.clear();
  }
}
