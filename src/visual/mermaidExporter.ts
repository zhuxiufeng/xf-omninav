import * as vscode from 'vscode';
import { SymbolIndexer } from '../indexer/symbolIndexer';
import { ContextResolver } from '../resolver/contextResolver';

export class MermaidHierarchyExporter {
  public static async exportClassHierarchy(
    indexer: SymbolIndexer,
    targetClassName?: string
  ): Promise<void> {
    const hierarchyMap = indexer.getClassHierarchyMap();
    const allClasses = indexer.getAllClassNames();

    if (allClasses.length === 0) {
      vscode.window.showInformationMessage(
        'XF OmniNav: No class hierarchy detected in workspace. Run "XF OmniNav: Rebuild Symbol Index" first.'
      );
      return;
    }

    let focusClass = targetClassName;

    // If no target class specified, try to infer from active text editor cursor
    if (!focusClass) {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const enclosing = ContextResolver.getEnclosingClass(
          editor.document,
          editor.selection.active
        );
        if (enclosing) {
          focusClass = enclosing.name;
        } else {
          const lineText = editor.document.lineAt(editor.selection.active.line).text;
          const match = lineText.match(/^\s*(?:export\s+)?class\s+([A-Za-z0-9_]+)/);
          if (match) {
            focusClass = match[1];
          }
        }
      }
    }

    // If still no focus class, show a QuickPick letting user choose specific class or all classes
    if (!focusClass) {
      interface ClassPickItem extends vscode.QuickPickItem {
        className?: string;
        all?: boolean;
      }

      const items: ClassPickItem[] = [
        {
          label: '$(type-hierarchy-sub) [All Classes in Workspace]',
          description: `Generate diagram for all ${allClasses.length} classes`,
          all: true,
        },
        ...allClasses.sort().map((c) => ({
          label: `$(symbol-class) ${c}`,
          description: hierarchyMap.has(c)
            ? `Extends ${hierarchyMap.get(c)!.join(', ')}`
            : undefined,
          className: c,
        })),
      ];

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a class hierarchy to export as Mermaid diagram',
      });

      if (!selected) {
        return;
      }

      if (selected.className) {
        focusClass = selected.className;
      }
    }

    // Generate diagram
    const markdown = this.generateMermaidMarkdown(indexer, focusClass);

    // Open untitled markdown document with diagram
    const doc = await vscode.workspace.openTextDocument({
      content: markdown,
      language: 'markdown',
    });

    await vscode.window.showTextDocument(doc, { preview: false });

    try {
      await vscode.commands.executeCommand('markdown.showPreviewToSide', doc.uri);
    } catch {}

    vscode.window.showInformationMessage(
      `XF OmniNav: Class hierarchy exported to Mermaid diagram (${focusClass || 'All Classes'}).`
    );
  }

  public static generateMermaidMarkdown(
    indexer: SymbolIndexer,
    focusClass?: string
  ): string {
    const hierarchyMap = indexer.getClassHierarchyMap();
    const relevantClasses = new Set<string>();

    if (focusClass) {
      relevantClasses.add(focusClass);
      const ancestors = indexer.getSuperClasses(focusClass);
      ancestors.forEach((a) => relevantClasses.add(a));
      const descendants = indexer.getSubClasses(focusClass);
      descendants.forEach((d) => relevantClasses.add(d));
    } else {
      for (const [cls, parents] of hierarchyMap) {
        relevantClasses.add(cls);
        parents.forEach((p) => relevantClasses.add(p));
      }
    }

    const lines: string[] = [];
    lines.push('```mermaid');
    lines.push('classDiagram');
    lines.push('    direction BT');

    // Output class blocks with methods
    for (const cls of Array.from(relevantClasses).sort()) {
      const methods = indexer.getClassMethods(cls);
      lines.push(`    class ${cls} {`);
      if (methods.length > 0) {
        for (const m of methods.slice(0, 15)) {
          let isOverride = false;
          const parents = indexer.getSuperClasses(cls);
          for (const p of parents) {
            const pMethods = indexer.getClassMethods(p);
            if (pMethods.includes(m)) {
              isOverride = true;
              break;
            }
          }
          const overrideMarker = isOverride ? '*' : '';
          lines.push(`        +${m}()${overrideMarker}`);
        }
        if (methods.length > 15) {
          lines.push(`        +... ${methods.length - 15} more methods`);
        }
      }
      lines.push('    }');
    }

    // Output inheritance links
    for (const child of Array.from(relevantClasses).sort()) {
      const parents = hierarchyMap.get(child);
      if (parents) {
        for (const parent of parents) {
          if (relevantClasses.has(parent)) {
            lines.push(`    ${parent} <|-- ${child}`);
          }
        }
      }
    }

    lines.push('```');

    const title = focusClass
      ? `Class Hierarchy: \`${focusClass}\``
      : 'Workspace Class Hierarchy';
    return [
      `# ${title}`,
      '',
      `> Generated by **XF OmniNav**`,
      `> Methods marked with \`*\` are overriding superclass methods.`,
      '',
      ...lines,
      '',
    ].join('\n');
  }
}
