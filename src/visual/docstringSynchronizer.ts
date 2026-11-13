import * as vscode from 'vscode';

export interface DocstringMismatchInfo {
  functionName: string;
  funcDefLine: number;
  docstringRange: vscode.Range;
  actualParams: string[];
  docParams: string[];
  missingParams: string[];
  orphanParams: string[];
  docstringStyle: 'sphinx' | 'google';
  docstringIndent: string;
}

/**
 * Validates consistency between Python function parameters and docstring parameter tags.
 * Supports Sphinx (:param name:) and Google (Args: name:) docstring formats.
 */
export class DocstringSynchronizer {
  /**
   * Scans document functions and detects mismatches between parameters and docstrings.
   */
  public static inspectDocstrings(document: vscode.TextDocument): {
    diagnostics: vscode.Diagnostic[];
    mismatches: DocstringMismatchInfo[];
  } {
    if (document.languageId !== 'python') {
      return { diagnostics: [], mismatches: [] };
    }

    const diagnostics: vscode.Diagnostic[] = [];
    const mismatches: DocstringMismatchInfo[] = [];
    const lineCount = document.lineCount;

    for (let l = 0; l < lineCount; l++) {
      const lineText = document.lineAt(l).text;
      const defMatch = lineText.match(/^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*)/);
      if (!defMatch) continue;

      const funcName = defMatch[1];
      if (funcName.startsWith('__') && funcName.endsWith('__') && funcName !== '__init__') {
        continue; // Skip standard magic methods like __repr__, __str__
      }

      // Collect complete signature across multiline def
      let sigEndLine = l;
      let fullSig = lineText;
      while (!fullSig.includes('):') && sigEndLine < lineCount - 1) {
        sigEndLine++;
        fullSig += ' ' + document.lineAt(sigEndLine).text;
      }

      const parenStart = fullSig.indexOf('(');
      const parenEnd = fullSig.lastIndexOf(')');
      if (parenStart === -1 || parenEnd === -1 || parenEnd <= parenStart) continue;

      const rawParams = fullSig.slice(parenStart + 1, parenEnd);
      const actualParams = this.extractParamNames(rawParams);

      // Check if immediately followed by docstring
      let docStartLine = sigEndLine + 1;
      while (docStartLine < lineCount && !document.lineAt(docStartLine).text.trim()) {
        docStartLine++;
      }
      if (docStartLine >= lineCount) continue;

      const docStartText = document.lineAt(docStartLine).text;
      const trimmedDocStart = docStartText.trim();
      const quoteType = trimmedDocStart.startsWith('"""')
        ? '"""'
        : trimmedDocStart.startsWith("'''")
        ? "'''"
        : null;

      if (!quoteType) continue;

      // Find docstring end
      let docEndLine = docStartLine;
      let docContent = docStartText;
      const isSingleLine =
        trimmedDocStart.length > 3 && trimmedDocStart.slice(3).includes(quoteType);

      if (!isSingleLine) {
        for (let el = docStartLine + 1; el < lineCount; el++) {
          const elText = document.lineAt(el).text;
          docContent += '\n' + elText;
          if (elText.includes(quoteType)) {
            docEndLine = el;
            break;
          }
        }
      }

      const docRange = new vscode.Range(
        docStartLine,
        document.lineAt(docStartLine).firstNonWhitespaceCharacterIndex,
        docEndLine,
        document.lineAt(docEndLine).text.length
      );

      // Parse documented params
      const parsedDoc = this.parseDocstringParams(docContent);
      if (!parsedDoc.hasParamSection) {
        // Docstring doesn't attempt to document parameters, do not force/harass user
        continue;
      }

      const missingParams = actualParams.filter((p) => !parsedDoc.paramNames.includes(p));
      const orphanParams = parsedDoc.paramNames.filter((p) => !actualParams.includes(p));

      if (missingParams.length > 0 || orphanParams.length > 0) {
        const details: string[] = [];
        if (missingParams.length > 0) {
          details.push(`缺少: ${missingParams.join(', ')}`);
        }
        if (orphanParams.length > 0) {
          details.push(`已废弃多余: ${orphanParams.join(', ')}`);
        }

        const diag = new vscode.Diagnostic(
          new vscode.Range(l, defMatch.index || 0, l, (defMatch.index || 0) + defMatch[0].length),
          `XF OmniNav: 函数 '${funcName}' 的文档注释 (Docstring) 参数说明不一致 (${details.join('; ')})`,
          vscode.DiagnosticSeverity.Information
        );
        diag.source = 'XF OmniNav';
        diag.code = 'docstring-param-mismatch';
        diagnostics.push(diag);

        const indentMatch = docStartText.match(/^\s*/);
        const docstringIndent = indentMatch ? indentMatch[0] : '    ';

        mismatches.push({
          functionName: funcName,
          funcDefLine: l,
          docstringRange: docRange,
          actualParams,
          docParams: parsedDoc.paramNames,
          missingParams,
          orphanParams,
          docstringStyle: parsedDoc.style,
          docstringIndent,
        });
      }
    }

    return { diagnostics, mismatches };
  }

  private static extractParamNames(rawParams: string): string[] {
    const names: string[] = [];
    const parts = rawParams.split(',');
    for (const p of parts) {
      const clean = p.trim();
      if (!clean || clean === '/' || clean === '*' || clean.startsWith('*')) continue;
      const eqIdx = clean.indexOf('=');
      const colonIdx = clean.indexOf(':');
      let name = clean;
      if (colonIdx !== -1 && (eqIdx === -1 || colonIdx < eqIdx)) {
        name = clean.slice(0, colonIdx).trim();
      } else if (eqIdx !== -1) {
        name = clean.slice(0, eqIdx).trim();
      }
      if (name === 'self' || name === 'cls') continue;
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        names.push(name);
      }
    }
    return names;
  }

  private static parseDocstringParams(
    docContent: string
  ): { hasParamSection: boolean; paramNames: string[]; style: 'sphinx' | 'google' } {
    const sphinxMatches = Array.from(docContent.matchAll(/:param\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/g));
    if (sphinxMatches.length > 0) {
      return {
        hasParamSection: true,
        paramNames: sphinxMatches.map((m) => m[1]),
        style: 'sphinx',
      };
    }

    // Google style: "Args:\n    name (type): desc"
    const argsIdx = docContent.indexOf('Args:');
    if (argsIdx !== -1) {
      const argsSection = docContent.slice(argsIdx);
      const googleMatches = Array.from(
        argsSection.matchAll(/^\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^)]*\))?\s*:/gm)
      );
      if (googleMatches.length > 0) {
        return {
          hasParamSection: true,
          paramNames: googleMatches.map((m) => m[1]),
          style: 'google',
        };
      }
    }

    return { hasParamSection: false, paramNames: [], style: 'sphinx' };
  }
}
