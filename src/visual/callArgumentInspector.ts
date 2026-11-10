import * as vscode from 'vscode';
import { SymbolIndexer } from '../indexer/symbolIndexer';
import { SymbolDefinition } from '../types';
import { getOmniConfig, debounce } from '../utils';

export interface ParamSpec {
  name: string;
  hasDefault: boolean;
  isVararg: boolean; // *args
  isVarkwarg: boolean; // **kwargs
  isKeywordOnly: boolean;
}

export interface FunctionSignatureInfo {
  name: string;
  minPositional: number;
  maxPositional: number;
  hasVarargs: boolean;
  hasVarkwargs: boolean;
  params: ParamSpec[];
}

export interface CallArgumentResult {
  positionalCount: number;
  keywords: string[];
  hasUnpack: boolean;
  argRange: vscode.Range;
}

const PYTHON_BUILTINS = new Set([
  'print',
  'len',
  'range',
  'enumerate',
  'zip',
  'map',
  'filter',
  'isinstance',
  'issubclass',
  'getattr',
  'setattr',
  'hasattr',
  'delattr',
  'str',
  'int',
  'float',
  'bool',
  'list',
  'dict',
  'set',
  'tuple',
  'bytes',
  'super',
  'type',
  'id',
  'hash',
  'repr',
  'format',
  'open',
  'input',
  'min',
  'max',
  'sum',
  'all',
  'any',
  'abs',
  'round',
  'divmod',
  'pow',
  'iter',
  'next',
  'callable',
  'vars',
  'dir',
  'locals',
  'globals',
]);

/**
 * PyCharm-style Heuristic Call Arguments Inspector.
 * Detects mismatched argument counts on function and method calls in Python
 * even when variables have no type annotations (such as dynamic lookup_object).
 */
export class CallArgumentInspector implements vscode.Disposable {
  private diagnosticCollection: vscode.DiagnosticCollection;
  private disposables: vscode.Disposable[] = [];
  private debouncedInspect: ((editor: vscode.TextEditor) => void) & { cancel: () => void };
  private sigCache = new Map<string, FunctionSignatureInfo | null>();

  constructor(private readonly indexer: SymbolIndexer) {
    this.diagnosticCollection =
      vscode.languages.createDiagnosticCollection('xfOmniNav-callArgs');

    this.debouncedInspect = debounce((editor: vscode.TextEditor) => {
      this.inspectDocument(editor.document);
    }, 250);

    this.disposables.push(this.diagnosticCollection);
  }

  /**
   * Parse Python signature into positional/keyword parameter constraints.
   */
  public parsePythonSignature(
    signature: string,
    isMethod = false
  ): FunctionSignatureInfo | null {
    if (!signature) return null;
    const cacheKey = `${isMethod ? 'm:' : 'f:'}${signature}`;
    if (this.sigCache.has(cacheKey)) {
      return this.sigCache.get(cacheKey) || null;
    }

    const parenStart = signature.indexOf('(');
    const parenEnd = signature.lastIndexOf(')');
    if (parenStart === -1 || parenEnd === -1 || parenEnd <= parenStart) {
      this.sigCache.set(cacheKey, null);
      return null;
    }

    const rawParams = signature.slice(parenStart + 1, parenEnd).trim();
    if (!rawParams) {
      const info: FunctionSignatureInfo = {
        name: '',
        minPositional: 0,
        maxPositional: 0,
        hasVarargs: false,
        hasVarkwargs: false,
        params: [],
      };
      this.sigCache.set(cacheKey, info);
      return info;
    }

    // Split parameters by top-level comma
    const params: string[] = [];
    let depth = 0;
    let cur = '';
    for (let i = 0; i < rawParams.length; i++) {
      const ch = rawParams[i];
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      else if (ch === ',' && depth === 0) {
        if (cur.trim()) params.push(cur.trim());
        cur = '';
        continue;
      }
      cur += ch;
    }
    if (cur.trim()) params.push(cur.trim());

    let hasVarargs = false;
    let hasVarkwargs = false;
    const positionalParams: ParamSpec[] = [];
    const keywordOnlyParams: ParamSpec[] = [];
    let isKwOnly = false;

    for (const p of params) {
      if (p === '/') continue;
      if (p === '*') {
        isKwOnly = true;
        continue;
      }
      if (p.startsWith('**')) {
        hasVarkwargs = true;
        continue;
      }
      if (p.startsWith('*')) {
        hasVarargs = true;
        isKwOnly = true;
        continue;
      }

      const hasDefault = p.includes('=');
      const name = p.split(/[:=]/)[0].trim();
      const spec: ParamSpec = {
        name,
        hasDefault,
        isVararg: false,
        isVarkwarg: false,
        isKeywordOnly: isKwOnly,
      };

      if (isKwOnly) {
        keywordOnlyParams.push(spec);
      } else {
        positionalParams.push(spec);
      }
    }

    // If method, strip implicit 'self' or 'cls' receiver
    if (isMethod && positionalParams.length > 0) {
      const first = positionalParams[0].name;
      if (first === 'self' || first === 'cls') {
        positionalParams.shift();
      }
    }

    let minPos = 0;
    const maxPos = hasVarargs ? Infinity : positionalParams.length;
    for (const p of positionalParams) {
      if (!p.hasDefault) minPos++;
    }

    const info: FunctionSignatureInfo = {
      name: '',
      minPositional: minPos,
      maxPositional: maxPos,
      hasVarargs,
      hasVarkwargs,
      params: positionalParams,
    };

    if (this.sigCache.size >= 1024) {
      this.sigCache.clear();
    }
    this.sigCache.set(cacheKey, info);
    return info;
  }

  /**
   * Parse arguments of a call expression between '(' and ')'.
   */
  public parseCallArguments(
    document: vscode.TextDocument,
    lineIdx: number,
    openParenChar: number
  ): CallArgumentResult | null {
    const lines = document.getText().split(/\r?\n/);
    let depth = 1;
    let argText = '';
    let curLine = lineIdx;
    let curCol = openParenChar + 1;
    let endLine = lineIdx;
    let endCol = openParenChar + 1;
    let inQuote: string | null = null;
    let foundEnd = false;

    const maxLine = Math.min(lines.length - 1, lineIdx + 25);
    while (curLine <= maxLine) {
      const line = lines[curLine];
      for (let c = curCol; c < line.length; c++) {
        const ch = line[c];
        if (inQuote) {
          if (ch === inQuote && line[c - 1] !== '\\') inQuote = null;
          argText += ch;
          continue;
        }
        if (ch === '"' || ch === "'") {
          inQuote = ch;
          argText += ch;
          continue;
        }
        if (ch === '#' && !inQuote) {
          break; // python comment
        }
        if (ch === '(' || ch === '[' || ch === '{') {
          depth++;
        } else if (ch === ')' || ch === ']' || ch === '}') {
          depth--;
          if (depth === 0) {
            endLine = curLine;
            endCol = c;
            foundEnd = true;
            break;
          }
        }
        argText += ch;
      }
      if (foundEnd) break;
      argText += '\n';
      curLine++;
      curCol = 0;
    }

    if (!foundEnd) return null;

    const argRange = new vscode.Range(
      new vscode.Position(lineIdx, openParenChar + 1),
      new vscode.Position(endLine, endCol)
    );

    const trimmed = argText.trim();
    if (!trimmed) {
      return { positionalCount: 0, keywords: [], hasUnpack: false, argRange };
    }

    // Split args by top-level comma
    const rawArgs: string[] = [];
    depth = 0;
    let cur = '';
    inQuote = null;
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (inQuote) {
        if (ch === inQuote && trimmed[i - 1] !== '\\') inQuote = null;
        cur += ch;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inQuote = ch;
        cur += ch;
        continue;
      }
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      else if (ch === ',' && depth === 0) {
        if (cur.trim()) rawArgs.push(cur.trim());
        cur = '';
        continue;
      }
      cur += ch;
    }
    if (cur.trim()) rawArgs.push(cur.trim());

    let positionalCount = 0;
    const keywords: string[] = [];
    let hasUnpack = false;

    for (const arg of rawArgs) {
      if (arg.startsWith('*') || arg.startsWith('**')) {
        hasUnpack = true;
        continue;
      }
      const eqIdx = arg.indexOf('=');
      if (
        eqIdx > 0 &&
        arg[eqIdx - 1] !== '=' &&
        arg[eqIdx - 1] !== '!' &&
        arg[eqIdx - 1] !== '<' &&
        arg[eqIdx - 1] !== '>' &&
        arg[eqIdx + 1] !== '='
      ) {
        const kw = arg.slice(0, eqIdx).trim();
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(kw)) {
          keywords.push(kw);
          continue;
        }
      }
      positionalCount++;
    }

    return { positionalCount, keywords, hasUnpack, argRange };
  }

  /**
   * Inspect a Python document and generate diagnostics for call argument mismatches.
   */
  public inspectDocument(document: vscode.TextDocument): vscode.Diagnostic[] {
    if (document.languageId !== 'python') {
      return [];
    }

    const isEnabled = getOmniConfig<boolean>('enableCallArgumentInspection', true);
    if (!isEnabled) {
      this.diagnosticCollection.delete(document.uri);
      return [];
    }

    const severityStr = getOmniConfig<string>('callArgumentSeverity', 'warning');
    const severity =
      severityStr === 'error'
        ? vscode.DiagnosticSeverity.Error
        : severityStr === 'information'
        ? vscode.DiagnosticSeverity.Information
        : vscode.DiagnosticSeverity.Warning;

    const diagnostics: vscode.Diagnostic[] = [];
    const text = document.getText();
    const lines = text.split(/\r?\n/);

    let currentClassName: string | null = null;
    let currentClassIndent = -1;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      // Track enclosing class
      const indent = line.length - line.trimStart().length;
      if (currentClassName && indent <= currentClassIndent && !trimmed.startsWith('@')) {
        currentClassName = null;
        currentClassIndent = -1;
      }
      if (trimmed.startsWith('class ')) {
        const classMatch = trimmed.match(/^class\s+([A-Za-z0-9_]+)/);
        if (classMatch) {
          currentClassName = classMatch[1];
          currentClassIndent = indent;
        }
        continue;
      }
      if (trimmed.startsWith('def ') || trimmed.startsWith('async def ')) {
        continue;
      }

      // Regex matching function and method calls: e.g. obj.method(...) or func(...)
      const callRegex = /(?:([A-Za-z0-9_]+)\.)?([A-Za-z0-9_]+)\s*\(/g;
      let match: RegExpExecArray | null;

      while ((match = callRegex.exec(line)) !== null) {
        const receiver = match[1];
        const methodName = match[2];

        // Skip Python built-ins unless locally defined
        if (!receiver && PYTHON_BUILTINS.has(methodName)) {
          continue;
        }

        const openParenChar = match.index + match[0].lastIndexOf('(');
        const callArgs = this.parseCallArguments(document, lineIdx, openParenChar);
        if (!callArgs || callArgs.hasUnpack) {
          continue;
        }

        // Query candidates from symbol indexer
        const exactDefs = this.indexer.findExact(methodName);
        let candidateDefs = exactDefs.filter(
          (d) => d.kind === 'method' || d.kind === 'function'
        );

        if (candidateDefs.length === 0) {
          continue;
        }

        // Intra-class prioritization: if receiver is 'self' and we are inside a class
        if (receiver === 'self' && currentClassName) {
          const classSpecific = candidateDefs.filter(
            (d) => d.containerName === currentClassName
          );
          if (classSpecific.length > 0) {
            candidateDefs = classSpecific;
          }
        }

        // Parse signatures of candidate definitions
        const sigInfos: FunctionSignatureInfo[] = [];
        for (const def of candidateDefs) {
          const isMethod = def.kind === 'method' || Boolean(def.containerName);
          const sigInfo = this.parsePythonSignature(def.signature, isMethod);
          if (sigInfo) {
            sigInfos.push(sigInfo);
          }
        }

        if (sigInfos.length === 0) {
          continue;
        }

        // Check 1: Too many positional arguments
        // If ALL candidate definitions agree that callArgs.positionalCount > maxPositional
        let allRejectExcess = true;
        let maxAllowed = 0;
        for (const s of sigInfos) {
          if (s.hasVarargs || callArgs.positionalCount <= s.maxPositional) {
            allRejectExcess = false;
            break;
          }
          if (s.maxPositional > maxAllowed) {
            maxAllowed = s.maxPositional;
          }
        }

        if (allRejectExcess && callArgs.positionalCount > maxAllowed) {
          const targetRange =
            callArgs.argRange.isEmpty || callArgs.positionalCount === 0
              ? new vscode.Range(
                  lineIdx,
                  match.index,
                  lineIdx,
                  openParenChar + 1
                )
              : callArgs.argRange;

          const diag = new vscode.Diagnostic(
            targetRange,
            `XF OmniNav: '${methodName}' 最多接收 ${maxAllowed} 个位置参数，但实际传入了 ${callArgs.positionalCount} 个 (PyCharm 风格参数检查)`,
            severity
          );
          diag.source = 'XF OmniNav';
          diag.code = 'too-many-arguments';
          diagnostics.push(diag);
        }
      }
    }

    this.diagnosticCollection.set(document.uri, diagnostics);
    return diagnostics;
  }

  public triggerInspect(editor: vscode.TextEditor): void {
    if (editor.document.languageId === 'python') {
      this.debouncedInspect(editor);
    }
  }

  public clearDocument(uri: vscode.Uri): void {
    this.diagnosticCollection.delete(uri);
  }

  public clearAll(): void {
    this.diagnosticCollection.clear();
    this.sigCache.clear();
  }

  dispose(): void {
    this.debouncedInspect.cancel();
    this.diagnosticCollection.clear();
    this.sigCache.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
