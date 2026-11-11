import * as vscode from 'vscode';
import { SymbolIndexer } from '../indexer/symbolIndexer';
import { SymbolDefinition } from '../types';
import { getOmniConfig, debounce, ICON_DATA_URIS } from '../utils';
import { ContextResolver, GENERIC_VARIABLE_NAMES } from '../resolver/contextResolver';

export interface ParamSpec {
  name: string;
  hasDefault: boolean;
  isVararg: boolean; // *args
  isVarkwarg: boolean; // **kwargs
  isKeywordOnly: boolean;
  type?: string;
  defaultValue?: string;
  description?: string;
}

export interface FunctionSignatureInfo {
  name: string;
  minPositional: number;
  maxPositional: number;
  hasVarargs: boolean;
  hasVarkwargs: boolean;
  params: ParamSpec[];
  keywordOnlyParams?: ParamSpec[];
}

export interface RawArgumentItem {
  text: string;
  isKeyword: boolean;
  keywordName?: string;
  valueText?: string;
  range: vscode.Range;
  removalRange: vscode.Range;
}

export interface CallArgumentResult {
  positionalCount: number;
  keywords: string[];
  items: RawArgumentItem[];
  hasUnpack: boolean;
  argRange: vscode.Range;
  openParenPos: vscode.Position;
  closeParenPos: vscode.Position;
  parenRange: vscode.Range;
}

export interface ParsedCallInfo {
  receiver?: string;
  methodName: string;
  callArgs: CallArgumentResult;
  targetRange: vscode.Range;
  candidateDefs: SymbolDefinition[];
  sigInfos: FunctionSignatureInfo[];
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

export const COMMON_POLYMORPHIC_METHODS = new Set([
  'get',
  'set',
  'update',
  'pop',
  'append',
  'extend',
  'insert',
  'remove',
  'clear',
  'copy',
  'count',
  'index',
  'keys',
  'values',
  'items',
  'join',
  'split',
  'replace',
  'strip',
  'lstrip',
  'rstrip',
  'format',
  'run',
  'start',
  'stop',
  'reset',
  'wait',
  'close',
  'read',
  'readline',
  'readlines',
  'write',
  'writelines',
  'flush',
  'seek',
  'tell',
  'info',
  'warning',
  'error',
  'debug',
  'critical',
  'exception',
  'log',
  'median',
  'mean',
  'std',
  'min',
  'max',
  'sum',
  'abs',
  'round',
  'dump',
  'dumps',
  'load',
  'loads',
  'sleep',
  'time',
  'check',
  'init',
  'save',
  'process',
  'handler',
  'callback',
  'send',
  'recv',
  'add',
  'discard',
  'encode',
  'decode',
  'find',
  'startswith',
  'endswith',
  'lower',
  'upper',
]);

/**
 * Universal default polymorphic methods across dynamic frameworks & services.
 */
export const DEFAULT_CONFIGURED_POLYMORPHIC_METHODS: string[] = [
  'get_status',
  'get_name',
  'get_state',
  'get_time',
  'get_position',
  'get_temp',
  'get_temperature',
  'get_commanders',
  'stats',
  'dump_debug',
  'handle_connect',
  'handle_ready',
  'handle_shutdown',
];

/**
 * PyCharm-style Heuristic Call Arguments Inspector.
 * Detects mismatched argument counts, missing required parameters, and unexpected keywords
 * in Python even when variables have no type annotations (such as dynamic Klipper lookup_object).
 */
export class CallArgumentInspector implements vscode.Disposable {
  private diagnosticCollection: vscode.DiagnosticCollection;
  private errorDecorationType: vscode.TextEditorDecorationType;
  private disposables: vscode.Disposable[] = [];
  private debouncedInspect: ((editor: vscode.TextEditor) => void) & { cancel: () => void };
  private sigCache = new Map<string, FunctionSignatureInfo | null>();
  private lastDecorations = new Map<string, vscode.DecorationOptions[]>();
  private lastCalls = new Map<string, ParsedCallInfo[]>();
  private fullAuditTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly indexer: SymbolIndexer) {
    this.diagnosticCollection =
      vscode.languages.createDiagnosticCollection('xfOmniNav-callArgs');

    this.errorDecorationType = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(255, 50, 50, 0.18)',
      border: '1px solid rgba(255, 65, 65, 0.75)',
      borderRadius: '3px',
      textDecoration: 'underline wavy #ff3333 2px',
      gutterIconPath: vscode.Uri.parse(ICON_DATA_URIS.error_badge),
      gutterIconSize: 'contain',
      overviewRulerColor: '#ff2222',
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      light: {
        backgroundColor: 'rgba(255, 0, 0, 0.12)',
        border: '1px solid rgba(220, 38, 38, 0.7)',
      },
      dark: {
        backgroundColor: 'rgba(255, 50, 50, 0.22)',
        border: '1px solid rgba(248, 113, 113, 0.75)',
      },
    });

    this.debouncedInspect = debounce((editor: vscode.TextEditor) => {
      if (!editor || !editor.document) return;
      if (
        editor.document.lineCount > 1500 &&
        editor.visibleRanges &&
        editor.visibleRanges.length > 0
      ) {
        const first = editor.visibleRanges[0].start.line;
        const last = editor.visibleRanges[editor.visibleRanges.length - 1].end.line;
        const scanRange = {
          start: Math.max(0, first - 80),
          end: Math.min(editor.document.lineCount - 1, last + 80),
        };
        this.inspectDocument(editor.document, scanRange);
      } else {
        this.inspectDocument(editor.document);
      }
    }, 200);

    if (vscode.window.onDidChangeVisibleTextEditors) {
      this.disposables.push(
        vscode.window.onDidChangeVisibleTextEditors((editors) => {
          for (const editor of editors) {
            this.applyStoredDecorations(editor);
          }
        })
      );
    }

    this.disposables.push(this.diagnosticCollection, this.errorDecorationType);
  }

  /**
   * Determine whether a method is a common polymorphic / protocol method
   * (e.g. dict.get, list.update, or user-configured service methods).
   */
  public isPolymorphicMethod(methodName: string): boolean {
    if (COMMON_POLYMORPHIC_METHODS.has(methodName)) {
      return true;
    }
    const userWhitelist = getOmniConfig<string[]>(
      'polymorphicMethodWhitelist',
      DEFAULT_CONFIGURED_POLYMORPHIC_METHODS
    );
    return Array.isArray(userWhitelist) && userWhitelist.includes(methodName);
  }

  /**
   * Parse TypeScript / JavaScript signature into positional parameter constraints.
   */
  public parseTypeScriptSignature(signature: string): FunctionSignatureInfo | null {
    if (!signature) return null;
    const cacheKey = `ts:${signature}`;
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

    const params: string[] = [];
    let depth = 0;
    let cur = '';
    for (let i = 0; i < rawParams.length; i++) {
      const ch = rawParams[i];
      if (ch === '(' || ch === '[' || ch === '{' || ch === '<') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      else if (ch === '>') {
        if (i > 0 && rawParams[i - 1] === '=') {
          // '=>' in arrow function type; do NOT decrement depth
        } else {
          depth--;
        }
      } else if (ch === ',' && depth === 0) {
        if (cur.trim()) params.push(cur.trim());
        cur = '';
        continue;
      }
      cur += ch;
    }
    if (cur.trim()) params.push(cur.trim());

    let hasVarargs = false;
    const positionalParams: ParamSpec[] = [];

    for (const p of params) {
      if (p.startsWith('...')) {
        hasVarargs = true;
        continue;
      }
      // Look for '=' that is NOT part of '=>'
      const eqMatch = p.match(/=(?!>)/);
      const eqIdx = eqMatch ? eqMatch.index! : -1;
      const hasDefault = /\?\s*:/.test(p) || eqIdx !== -1;
      const name = p.split(/[:?=]/)[0].trim().replace(/^public\s+|^private\s+|^protected\s+|^readonly\s+/, '');
      if (name === 'this') continue;

      let type: string | undefined = undefined;
      let defaultValue: string | undefined = undefined;
      const colonIdx = p.indexOf(':');
      if (colonIdx !== -1) {
        if (eqIdx !== -1 && eqIdx > colonIdx) {
          type = p.slice(colonIdx + 1, eqIdx).trim();
          defaultValue = p.slice(eqIdx + 1).trim();
        } else {
          type = p.slice(colonIdx + 1).trim();
        }
      } else if (eqIdx !== -1) {
        defaultValue = p.slice(eqIdx + 1).trim();
      }

      positionalParams.push({
        name,
        hasDefault,
        isVararg: false,
        isVarkwarg: false,
        isKeywordOnly: false,
        type,
        defaultValue,
      });
    }

    let minPos = 0;
    for (const p of positionalParams) {
      if (!p.hasDefault) {
        minPos++;
      } else {
        break;
      }
    }

    const info: FunctionSignatureInfo = {
      name: '',
      minPositional: minPos,
      maxPositional: hasVarargs ? Infinity : positionalParams.length,
      hasVarargs,
      hasVarkwargs: false,
      params: positionalParams,
    };
    this.sigCache.set(cacheKey, info);
    return info;
  }

  /**
   * Parse Python signature into positional/keyword parameter constraints.
   */
  public parsePythonSignature(
    signature: string,
    isMethod = false,
    isStatic = false
  ): FunctionSignatureInfo | null {
    if (!signature) return null;
    const cacheKey = `${isStatic ? 's:' : isMethod ? 'm:' : 'f:'}${signature}`;
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

      let type: string | undefined = undefined;
      let defaultValue: string | undefined = undefined;
      const colonIdx = p.indexOf(':');
      const eqIdx = p.indexOf('=');
      if (colonIdx !== -1) {
        if (eqIdx !== -1 && eqIdx > colonIdx) {
          type = p.slice(colonIdx + 1, eqIdx).trim();
          defaultValue = p.slice(eqIdx + 1).trim();
        } else {
          type = p.slice(colonIdx + 1).trim();
        }
      } else if (eqIdx !== -1) {
        defaultValue = p.slice(eqIdx + 1).trim();
      }

      const spec: ParamSpec = {
        name,
        hasDefault,
        isVararg: false,
        isVarkwarg: false,
        isKeywordOnly: isKwOnly,
        type,
        defaultValue,
      };

      if (isKwOnly) {
        keywordOnlyParams.push(spec);
      } else {
        positionalParams.push(spec);
      }
    }

    // Strip implicit 'self' or 'cls' receiver (unless method is static)
    if (!isStatic && positionalParams.length > 0) {
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
      params: positionalParams.concat(keywordOnlyParams),
      keywordOnlyParams,
    };

    if (this.sigCache.size >= 1024) {
      this.sigCache.clear();
    }
    this.sigCache.set(cacheKey, info);
    return info;
  }

  /**
   * Extract parameter descriptions and types from Python / JSDoc / Sphinx docstrings.
   */
  public extractDocstringParams(
    docstring: string
  ): Map<string, { type?: string; description?: string }> {
    const result = new Map<string, { type?: string; description?: string }>();
    if (!docstring) return result;

    // 1. Sphinx/Epydoc style: :param [type] name: description or :type name: type
    const sphinxParamRegex =
      /:param\s+(?:([A-Za-z0-9_\[\], ]+)\s+)?([A-Za-z0-9_]+)\s*:\s*([^\n\r]+)/g;
    let m: RegExpExecArray | null;
    while ((m = sphinxParamRegex.exec(docstring)) !== null) {
      const type = m[1]?.trim();
      const name = m[2]?.trim();
      const desc = m[3]?.trim();
      if (name) {
        result.set(name, { type: type || undefined, description: desc || undefined });
      }
    }

    const sphinxTypeRegex = /:type\s+([A-Za-z0-9_]+)\s*:\s*([^\n\r]+)/g;
    while ((m = sphinxTypeRegex.exec(docstring)) !== null) {
      const name = m[1]?.trim();
      const type = m[2]?.trim();
      if (name) {
        const existing = result.get(name) || {};
        existing.type = type;
        result.set(name, existing);
      }
    }

    // 2. JSDoc style: @param {type} [name] description
    const jsdocRegex =
      /@param\s+(?:\{([^}]+)\}\s+)?(?:\[?([A-Za-z0-9_]+)(?:=[^\]]+)?\]?)\s*(?:-\s*)?([^\n\r]*)/g;
    while ((m = jsdocRegex.exec(docstring)) !== null) {
      const type = m[1]?.trim();
      const name = m[2]?.trim();
      const desc = m[3]?.trim();
      if (name && !result.has(name)) {
        result.set(name, { type: type || undefined, description: desc || undefined });
      }
    }

    // 3. Google/NumPy style: Args:\n  name (type): description
    const googleArgsMatch = docstring.match(
      /(?:Args|Parameters|Arguments):\s*([\s\S]+?)(?:\n\s*\n|[A-Z][a-z]+:|$)/
    );
    if (googleArgsMatch && googleArgsMatch[1]) {
      const lines = googleArgsMatch[1].split(/\r?\n/);
      for (const line of lines) {
        const lineMatch = line.match(/^\s*([A-Za-z0-9_]+)(?:\s*\(([^)]+)\))?\s*:\s*(.+)$/);
        if (lineMatch) {
          const name = lineMatch[1].trim();
          const type = lineMatch[2]?.trim();
          const desc = lineMatch[3]?.trim();
          if (name && !result.has(name)) {
            result.set(name, { type: type || undefined, description: desc || undefined });
          }
        }
      }
    }

    return result;
  }

  /**
   * Enrich parameter specifications with docstring types and descriptions.
   */
  public enrichParamsWithDocstring(params: ParamSpec[], docstring?: string): void {
    if (!docstring) return;
    const docMap = this.extractDocstringParams(docstring);
    if (docMap.size === 0) return;

    for (const p of params) {
      const docInfo = docMap.get(p.name);
      if (docInfo) {
        if (!p.type && docInfo.type) {
          p.type = docInfo.type;
        }
        if (!p.description && docInfo.description) {
          p.description = docInfo.description;
        }
      }
    }
  }

  /**
   * Parse arguments of a call expression between '(' and ')'.
   */
  public parseCallArguments(
    document: vscode.TextDocument,
    lineIdx: number,
    openParenChar: number,
    getLineText?: (lineNum: number) => string
  ): CallArgumentResult | null {
    let depth = 1;
    let argText = '';
    let curLine = lineIdx;
    let curCol = openParenChar + 1;
    let endLine = lineIdx;
    let endCol = openParenChar + 1;
    let inQuote: string | null = null;
    let foundEnd = false;

    const totalLines = typeof document.lineCount === 'number' ? document.lineCount : 100000;
    const maxLine = Math.min(totalLines - 1, lineIdx + 25);
    const fetchLine =
      getLineText ||
      ((l: number) => {
        if (typeof document.lineAt === 'function') {
          try {
            return document.lineAt(l).text;
          } catch {}
        }
        return '';
      });

    const isEscaped = (text: string, pos: number): boolean => {
      let backslashes = 0;
      for (let idx = pos - 1; idx >= 0 && text[idx] === '\\'; idx--) {
        backslashes++;
      }
      return backslashes % 2 === 1;
    };

    while (curLine <= maxLine) {
      const line = fetchLine(curLine);
      if (line === undefined || line === null) break;
      for (let c = curCol; c < line.length; c++) {
        const ch = line[c];
        if (inQuote) {
          if (ch === inQuote && !isEscaped(line, c)) inQuote = null;
          argText += ch;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
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

    const openParenPos = new vscode.Position(lineIdx, openParenChar);
    const closeParenPos = new vscode.Position(endLine, endCol);
    const parenRange = new vscode.Range(openParenPos, new vscode.Position(endLine, endCol + 1));
    const argRange = new vscode.Range(
      new vscode.Position(lineIdx, openParenChar + 1),
      closeParenPos
    );

    const trimmed = argText.trim();
    if (!trimmed) {
      return {
        positionalCount: 0,
        keywords: [],
        items: [],
        hasUnpack: false,
        argRange,
        openParenPos,
        closeParenPos,
        parenRange,
      };
    }

    // Split args by top-level comma and track offsets
    interface ChunkOffset {
      start: number;
      end: number;
      hasPrevComma: boolean;
      commaIndex?: number;
    }
    const chunks: ChunkOffset[] = [];
    depth = 0;
    inQuote = null;
    let chunkStart = 0;
    let lastCommaIdx = -1;

    for (let i = 0; i < argText.length; i++) {
      const ch = argText[i];
      if (inQuote) {
        if (ch === inQuote && !isEscaped(argText, i)) inQuote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        inQuote = ch;
        continue;
      }
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      else if (ch === ',' && depth === 0) {
        chunks.push({
          start: chunkStart,
          end: i,
          hasPrevComma: lastCommaIdx !== -1,
          commaIndex: lastCommaIdx,
        });
        lastCommaIdx = i;
        chunkStart = i + 1;
      }
    }
    chunks.push({
      start: chunkStart,
      end: argText.length,
      hasPrevComma: lastCommaIdx !== -1,
      commaIndex: lastCommaIdx,
    });

    const items: RawArgumentItem[] = [];
    let positionalCount = 0;
    const keywords: string[] = [];
    let hasUnpack = false;

    const offsetToPos = (offset: number): vscode.Position => {
      let l = lineIdx;
      let c = openParenChar + 1;
      for (let i = 0; i < offset && i < argText.length; i++) {
        if (argText[i] === '\n') {
          l++;
          c = 0;
        } else {
          c++;
        }
      }
      return new vscode.Position(l, c);
    };

    for (let idx = 0; idx < chunks.length; idx++) {
      const chunk = chunks[idx];
      const rawPiece = argText.slice(chunk.start, chunk.end);
      const trimmedPiece = rawPiece.trim();
      if (!trimmedPiece) continue;

      const leadingMatch = rawPiece.match(/^\s*/);
      const leadingLen = leadingMatch ? leadingMatch[0].length : 0;
      const trailingMatch = rawPiece.match(/\s*$/);
      const trailingLen = trailingMatch ? trailingMatch[0].length : 0;

      const itemStartOffset = chunk.start + leadingLen;
      const itemEndOffset = chunk.end - trailingLen;

      const itemRange = new vscode.Range(
        offsetToPos(itemStartOffset),
        offsetToPos(itemEndOffset)
      );

      // Calculate clean removalRange for QuickFix
      let removalRange: vscode.Range;
      if (chunk.hasPrevComma && chunk.commaIndex !== undefined && chunk.commaIndex >= 0) {
        removalRange = new vscode.Range(offsetToPos(chunk.commaIndex), offsetToPos(itemEndOffset));
      } else if (idx < chunks.length - 1) {
        removalRange = new vscode.Range(offsetToPos(itemStartOffset), offsetToPos(chunks[idx + 1].start));
      } else {
        removalRange = itemRange;
      }

      if (trimmedPiece.startsWith('*') || trimmedPiece.startsWith('**')) {
        hasUnpack = true;
      }

      let isKeyword = false;
      let keywordName: string | undefined = undefined;
      let valueText: string | undefined = undefined;

      if (!trimmedPiece.startsWith('*')) {
        const eqIdx = trimmedPiece.indexOf('=');
        if (
          eqIdx > 0 &&
          trimmedPiece[eqIdx - 1] !== '=' &&
          trimmedPiece[eqIdx - 1] !== '!' &&
          trimmedPiece[eqIdx - 1] !== '<' &&
          trimmedPiece[eqIdx - 1] !== '>' &&
          trimmedPiece[eqIdx + 1] !== '='
        ) {
          const kw = trimmedPiece.slice(0, eqIdx).trim();
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(kw)) {
            isKeyword = true;
            keywordName = kw;
            valueText = trimmedPiece.slice(eqIdx + 1).trim();
            keywords.push(kw);
          }
        }
      }

      if (!isKeyword && !trimmedPiece.startsWith('*')) {
        positionalCount++;
      }

      items.push({
        text: trimmedPiece,
        isKeyword,
        keywordName,
        valueText,
        range: itemRange,
        removalRange,
      });
    }

    return {
      positionalCount,
      keywords,
      items,
      hasUnpack,
      argRange,
      openParenPos,
      closeParenPos,
      parenRange,
    };
  }

  /**
   * Inspect a Python document and generate diagnostics for call argument mismatches.
   * Supports incremental scanning via scanLineRange for 10,000+ line large files.
   */
  public inspectDocument(
    document: vscode.TextDocument,
    scanLineRange?: { start: number; end: number }
  ): vscode.Diagnostic[] {
    const isPython = document.languageId === 'python';
    const isTSorJS = document.languageId === 'typescript' || document.languageId === 'javascript';
    if (!isPython && !isTSorJS) {
      return [];
    }

    const isEnabled = getOmniConfig<boolean>('enableCallArgumentInspection', true);
    if (!isEnabled) {
      this.clearDocument(document.uri);
      return [];
    }

    const severityStr = getOmniConfig<string>('callArgumentSeverity', 'error');
    const severity =
      severityStr === 'warning'
        ? vscode.DiagnosticSeverity.Warning
        : severityStr === 'information'
        ? vscode.DiagnosticSeverity.Information
        : vscode.DiagnosticSeverity.Error;

    const enableHighlight = getOmniConfig<boolean>('enableCallArgumentHighlight', true);
    const enableMissingCheck = getOmniConfig<boolean>('enableMissingArgumentInspection', true);
    const enableUnexpectedKwCheck = getOmniConfig<boolean>('enableUnexpectedKeywordInspection', true);

    const decorations: vscode.DecorationOptions[] = [];
    const diagnostics: vscode.Diagnostic[] = [];
    const parsedCalls: ParsedCallInfo[] = [];

    const totalLines =
      typeof document.lineCount === 'number'
        ? document.lineCount
        : 100000;

    const scanStart = scanLineRange ? Math.max(0, scanLineRange.start) : 0;
    const scanEnd = scanLineRange ? Math.min(totalLines - 1, scanLineRange.end) : totalLines - 1;

    let linesCache: string[] | null = null;
    const getLine = (l: number): string => {
      if (typeof document.lineAt === 'function') {
        try {
          return document.lineAt(l).text;
        } catch {}
      }
      if (!linesCache) {
        linesCache = document.getText().split(/\r?\n/);
      }
      return linesCache[l] || '';
    };

    let currentClassName: string | null = null;
    let currentClassIndent = -1;

    // When incrementally scanning a viewport range, scan backwards to detect enclosing class
    if (scanStart > 0) {
      for (let l = scanStart - 1; l >= 0; l--) {
        const line = getLine(l);
        const trimmed = line.trim();
        if (trimmed.startsWith('class ')) {
          const match = trimmed.match(/^class\s+([A-Za-z0-9_]+)/);
          if (match) {
            currentClassName = match[1];
            currentClassIndent = line.length - line.trimStart().length;
            break;
          }
        }
      }
    }

    for (let lineIdx = scanStart; lineIdx <= scanEnd; lineIdx++) {
      const line = getLine(lineIdx);
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

      // Regex matching function and method calls: e.g. obj.method(...) or self.gcode.method(...) or func(...)
      const callRegex = /(?:((?:[A-Za-z0-9_]+\.)*[A-Za-z0-9_]+)\.)?([A-Za-z0-9_]+)\s*\(/g;
      let match: RegExpExecArray | null;

      while ((match = callRegex.exec(line)) !== null) {
        const receiver = match[1];
        const methodName = match[2];

        // Skip Python built-ins or polymorphic calls without receiver
        if (!receiver && (PYTHON_BUILTINS.has(methodName) || this.isPolymorphicMethod(methodName))) {
          continue;
        }

        const openParenChar = match.index + match[0].lastIndexOf('(');
        const callArgs = this.parseCallArguments(document, lineIdx, openParenChar, getLine);
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

        // Intra-class prioritization: if receiver is 'self'/'cls' and we are inside a class
        if ((receiver === 'self' || receiver === 'cls') && currentClassName) {
          const classSpecific = candidateDefs.filter(
            (d) => d.containerName === currentClassName
          );
          if (classSpecific.length > 0) {
            candidateDefs = classSpecific;
          } else if (this.isPolymorphicMethod(methodName)) {
            continue;
          }
        } else if ((receiver === 'self' || receiver === 'cls') && this.isPolymorphicMethod(methodName)) {
          continue;
        } else if (receiver && receiver !== 'self' && receiver !== 'cls') {
          // If receiver is a variable or self property, check if it was inferred to a specific class
          const rawProp = receiver.replace(/^(?:self|this)\./, '');
          const receiverParts = receiver.split('.');
          const terminalProp = receiverParts[receiverParts.length - 1];
          const isGeneric =
            GENERIC_VARIABLE_NAMES.has(receiver) ||
            GENERIC_VARIABLE_NAMES.has(rawProp) ||
            GENERIC_VARIABLE_NAMES.has(terminalProp);

          let inferredType = ContextResolver.inferVariableType(document, receiver, lineIdx, this.indexer);
          if (!inferredType && receiver.includes('.')) {
            inferredType = ContextResolver.inferSelfPropertyType(document, rawProp, lineIdx);
          }
          if (!inferredType && terminalProp !== rawProp) {
            inferredType = ContextResolver.inferSelfPropertyType(document, terminalProp, lineIdx);
          }
          if (!inferredType) {
            inferredType = ContextResolver.inferSelfPropertyType(document, rawProp, lineIdx);
          }
          let hasComponentMatch = false;
          // Component name match fallback: e.g. gcode, toolhead, printer
          if (!inferredType && !isGeneric) {
            const cleanRaw = rawProp.replace(/_/g, '').toLowerCase();
            const cleanTerminal = terminalProp.replace(/_/g, '').toLowerCase();
            const componentMatch = candidateDefs.filter((d) => {
              const cont = d.containerName?.replace(/_/g, '').toLowerCase();
              const pth = d.uri.fsPath.replace(/_/g, '').toLowerCase();
              return (
                cont === cleanRaw ||
                cont === cleanTerminal ||
                pth.includes(cleanRaw) ||
                pth.includes(cleanTerminal)
              );
            });
            if (componentMatch.length > 0) {
              candidateDefs = componentMatch;
              hasComponentMatch = true;
            }
          }

          if (inferredType) {
            // Built-in Python types (dict, list, etc.) have dynamic native methods; skip inspection
            if (['dict', 'list', 'set', 'tuple', 'str', 'bool', 'number'].includes(inferredType)) {
              continue;
            }
            const normInferred = inferredType.replace(/_/g, '').toLowerCase();
            const matchingDefs = candidateDefs.filter(
              (d) =>
                d.containerName?.replace(/_/g, '').toLowerCase() === normInferred ||
                d.containerName?.replace(/_/g, '').toLowerCase() === `${normInferred}action` ||
                d.uri.fsPath.replace(/_/g, '').toLowerCase().includes(normInferred)
            );
            if (matchingDefs.length > 0) {
              candidateDefs = matchingDefs;
            } else {
              // When receiver is inferred to a specific component (e.g. gcode_move),
              // but its class definition is not found among candidate definitions,
              // DO NOT fall back to inspecting against random other classes!
              continue;
            }
          } else if (isGeneric || (!hasComponentMatch && this.isPolymorphicMethod(methodName))) {
            // Generic variable name or un-inferred polymorphic method, skip
            continue;
          }
        }

        // If receiver is a Class name (e.g. BoxActionBase.communication_set_pre_loading),
        // prioritize definitions belonging to that container class
        if (receiver && /^[A-Z]/.test(receiver)) {
          const classDefs = candidateDefs.filter(
            (d) =>
              d.containerName === receiver ||
              d.containerName?.toLowerCase() === receiver.toLowerCase()
          );
          if (classDefs.length > 0) {
            candidateDefs = classDefs;
          }
        }

        // Parse signatures of candidate definitions
        const sigInfos: FunctionSignatureInfo[] = [];
        for (const def of candidateDefs) {
          const isMethod = def.kind === 'method' || Boolean(def.containerName);
          const sigInfo = isPython
            ? this.parsePythonSignature(def.signature, isMethod, Boolean(def.isStatic))
            : this.parseTypeScriptSignature(def.signature);
          if (sigInfo) {
            if (def.docstring) {
              this.enrichParamsWithDocstring(sigInfo.params, def.docstring);
              if (sigInfo.keywordOnlyParams) {
                this.enrichParamsWithDocstring(sigInfo.keywordOnlyParams, def.docstring);
              }
            }
            sigInfos.push(sigInfo);
          }
        }

        if (sigInfos.length === 0) {
          continue;
        }

        const fullCallRange = new vscode.Range(
          lineIdx,
          match.index,
          callArgs.closeParenPos.line,
          callArgs.closeParenPos.character + 1
        );

        parsedCalls.push({
          receiver,
          methodName,
          callArgs,
          targetRange: fullCallRange,
          candidateDefs,
          sigInfos,
        });

        // Detect if explicit `self` or `cls` argument is passed as the first positional argument
        // (common in base class calls like BoxActionBase.func(self, ...))
        const firstItem = callArgs.items.length > 0 ? callArgs.items[0] : undefined;
        const hasExplicitSelf = Boolean(
          firstItem && !firstItem.isKeyword && (firstItem.text === 'self' || firstItem.text === 'cls')
        );
        const effectivePositionalCount = hasExplicitSelf
          ? Math.max(0, callArgs.positionalCount - 1)
          : callArgs.positionalCount;

        // 1. Check: Too many positional arguments
        let allRejectExcess = true;
        let maxAllowed = 0;
        for (const s of sigInfos) {
          if (s.hasVarargs || effectivePositionalCount <= s.maxPositional) {
            allRejectExcess = false;
            break;
          }
          if (s.maxPositional > maxAllowed) {
            maxAllowed = s.maxPositional;
          }
        }

        if (allRejectExcess && effectivePositionalCount > maxAllowed) {
          const positionalItems = callArgs.items.filter((it) => !it.isKeyword);
          const excessSliceStart = hasExplicitSelf ? maxAllowed + 1 : maxAllowed;
          const excessItems = positionalItems.slice(excessSliceStart);
          const targetRange =
            excessItems.length > 0
              ? new vscode.Range(excessItems[0].range.start, excessItems[excessItems.length - 1].range.end)
              : callArgs.argRange.isEmpty
              ? new vscode.Range(lineIdx, match.index, lineIdx, openParenChar + 1)
              : callArgs.argRange;

          let isKwOnlyViolation = false;
          let kwOnlyParamName = '';
          for (const s of sigInfos) {
            if (s.keywordOnlyParams && s.keywordOnlyParams.length > 0) {
              const kwIndex = effectivePositionalCount - maxAllowed - 1;
              if (kwIndex >= 0 && kwIndex < s.keywordOnlyParams.length) {
                isKwOnlyViolation = true;
                kwOnlyParamName = s.keywordOnlyParams[kwIndex].name;
                break;
              }
            }
          }

          const diagCode = isKwOnlyViolation ? 'keyword-only-as-positional' : 'too-many-arguments';
          const errorMsg = isKwOnlyViolation
            ? `'${kwOnlyParamName}' 为仅关键字形参 (PEP 3102)，必须使用 '${kwOnlyParamName}=...' 关键字传参`
            : `'${methodName}' 最多接收 ${maxAllowed} 个位置参数，但实际传入了 ${effectivePositionalCount} 个 (PyCharm 风格参数检查)`;
          const diag = new vscode.Diagnostic(
            targetRange,
            `XF OmniNav: ${errorMsg}`,
            severity
          );
          diag.source = 'XF OmniNav';
          diag.code = diagCode;
          diagnostics.push(diag);

          if (enableHighlight) {
            decorations.push({
              range: targetRange,
              hoverMessage: new vscode.MarkdownString(
                isKwOnlyViolation
                  ? `**XF OmniNav: 仅关键字参数错误 (PEP 3102 / PyCharm 风格)**\n\n\`${methodName}\` 中的形参 **${kwOnlyParamName}** 声明为仅关键字形参，不能以位置形式传参。`
                  : `**XF OmniNav: 参数错误 (PyCharm 风格)**\n\n\`${methodName}\` 最多接收 **${maxAllowed}** 个位置参数，但实际传入了 **${effectivePositionalCount}** 个。`
              ),
              renderOptions: {
                after: {
                  contentText: isKwOnlyViolation
                    ? ` ❗'${kwOnlyParamName}' 必须使用关键字形式传参`
                    : ` ❗参数错误: 期望 ≤${maxAllowed} 个，实传 ${effectivePositionalCount} 个`,
                  color: '#ff4d4f',
                  fontWeight: 'bold',
                  fontStyle: 'normal',
                  margin: '0 0 0 8px',
                },
              },
            });
          }
        }

        // 2. Check: Missing required arguments
        if (enableMissingCheck) {
          let allMissingRequired = true;
          const missingPerSig: string[][] = [];

          for (const s of sigInfos) {
            const missingForThisSig: string[] = [];
            for (let pIdx = 0; pIdx < s.minPositional; pIdx++) {
              const p = s.params[pIdx];
              if (!p || p.hasDefault || p.isVararg || p.isVarkwarg || p.isKeywordOnly) continue;
              if (p.name === 'self' || p.name === 'cls') continue;
              if (pIdx < effectivePositionalCount) continue;
              if (callArgs.keywords.includes(p.name)) continue;
              missingForThisSig.push(p.name);
            }
            // Check required keyword-only parameters without default values
            if (s.keywordOnlyParams) {
              for (const kwp of s.keywordOnlyParams) {
                if (!kwp.hasDefault && !callArgs.keywords.includes(kwp.name)) {
                  missingForThisSig.push(kwp.name);
                }
              }
            }
            if (missingForThisSig.length === 0) {
              allMissingRequired = false;
              break;
            }
            missingPerSig.push(missingForThisSig);
          }

          if (allMissingRequired && missingPerSig.length > 0 && missingPerSig[0].length > 0) {
            const missingNames = missingPerSig[0];
            const targetRange = callArgs.argRange.isEmpty
              ? callArgs.parenRange
              : callArgs.argRange;

            const diag = new vscode.Diagnostic(
              targetRange,
              `XF OmniNav: '${methodName}' 缺少必填参数: ${missingNames.join(', ')} (PyCharm 风格参数检查)`,
              severity
            );
            diag.source = 'XF OmniNav';
            diag.code = 'missing-arguments';
            diagnostics.push(diag);

            if (enableHighlight) {
              decorations.push({
                range: targetRange,
                hoverMessage: new vscode.MarkdownString(
                  `**XF OmniNav: 参数缺失 (PyCharm 风格)**\n\n\`${methodName}\` 缺少必填参数: **${missingNames.join(', ')}**。`
                ),
                renderOptions: {
                  after: {
                    contentText: ` ❗缺少必填参数: ${missingNames.join(', ')} `,
                    color: '#ff4d4f',
                    fontWeight: 'bold',
                    fontStyle: 'normal',
                    margin: '0 8px 0 8px',
                  },
                },
              });
            }
          }
        }

        // 3. Check: Unexpected keyword arguments
        if (enableUnexpectedKwCheck && callArgs.keywords.length > 0) {
          const hasAnyVarkwargs = sigInfos.some((s) => s.hasVarkwargs);
          if (!hasAnyVarkwargs) {
            for (const item of callArgs.items) {
              if (!item.isKeyword || !item.keywordName) continue;
              const kw = item.keywordName;
              const isKnownInAnySig = sigInfos.some((s) =>
                s.params.some((p) => p.name === kw)
              );
              if (!isKnownInAnySig) {
                const diag = new vscode.Diagnostic(
                  item.range,
                  `XF OmniNav: '${methodName}' 未知关键字参数 '${kw}' (PyCharm 风格参数检查)`,
                  severity
                );
                diag.source = 'XF OmniNav';
                diag.code = 'unexpected-keyword';
                diagnostics.push(diag);

                if (enableHighlight) {
                  decorations.push({
                    range: item.range,
                    hoverMessage: new vscode.MarkdownString(
                      `**XF OmniNav: 未知关键字参数 (PyCharm 风格)**\n\n\`${methodName}\` 未定义名为 **${kw}** 的形参。`
                    ),
                    renderOptions: {
                      after: {
                        contentText: ` ❗未知关键字参数 '${kw}'`,
                        color: '#ff4d4f',
                        fontWeight: 'bold',
                        fontStyle: 'normal',
                        margin: '0 0 0 8px',
                      },
                    },
                  });
                }
              }
            }
          }
        }
      }
    }

    if (scanLineRange) {
      const prevCalls = this.lastCalls.get(document.uri.toString()) || [];
      const prevDiags = this.diagnosticCollection.get(document.uri) || [];
      const prevDecors = this.lastDecorations.get(document.uri.toString()) || [];

      const isInsideScanRange = (l: number) => l >= scanStart && l <= scanEnd;

      const mergedCalls = [
        ...prevCalls.filter((c) => !isInsideScanRange(c.targetRange.start.line)),
        ...parsedCalls,
      ];
      const mergedDiags = [
        ...prevDiags.filter((d) => !isInsideScanRange(d.range.start.line)),
        ...diagnostics,
      ];
      const mergedDecors = [
        ...prevDecors.filter((d) => !isInsideScanRange(d.range.start.line)),
        ...decorations,
      ];

      this.lastCalls.set(document.uri.toString(), mergedCalls);
      this.diagnosticCollection.set(document.uri, mergedDiags);
      this.lastDecorations.set(document.uri.toString(), mergedDecors);
      this.applyDecorationsToDocument(document.uri, mergedDecors);
      return mergedDiags;
    } else {
      this.lastCalls.set(document.uri.toString(), parsedCalls);
      this.diagnosticCollection.set(document.uri, diagnostics);
      this.lastDecorations.set(document.uri.toString(), decorations);
      this.applyDecorationsToDocument(document.uri, decorations);
      return diagnostics;
    }
  }

  public getCallsForDocument(uri: vscode.Uri): ParsedCallInfo[] {
    return this.lastCalls.get(uri.toString()) || [];
  }

  /**
   * Pre-scan all Git modified Python files in background to decorate errors
   * in the explorer file tree without requiring user to open them first.
   */
  public async scanGitModifiedFiles(workspaceRoot?: string): Promise<number> {
    const isEnabled = getOmniConfig<boolean>('enableGitPreScan', true);
    if (!isEnabled) return 0;

    const root =
      workspaceRoot ||
      (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]?.uri.fsPath);
    if (!root) return 0;

    try {
      const { exec } = await import('child_process');
      const util = await import('util');
      const fs = await import('fs');
      const path = await import('path');
      const execAsync = util.promisify(exec);

      const { stdout } = await execAsync('git status --porcelain', { cwd: root, timeout: 5000 });
      const lines = stdout.split('\n');
      const pyFiles: string[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const filePath = trimmed.slice(2).trim();
        if (filePath.endsWith('.py') && !filePath.includes('.git')) {
          pyFiles.push(path.isAbsolute(filePath) ? filePath : path.join(root, filePath));
        }
      }

      let errorCount = 0;
      for (const filePath of pyFiles) {
        try {
          if (fs.existsSync(filePath)) {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const uri = vscode.Uri.file(filePath);
            const lineList = content.split(/\r?\n/);
            const mockDoc: any = {
              uri,
              languageId: 'python',
              getText: () => content,
              lineAt: (n: number) => ({
                text: lineList[n] || '',
                range: new vscode.Range(n, 0, n, (lineList[n] || '').length),
              }),
            };
            const diags = this.inspectDocument(mockDoc);
            if (diags.some((d) => d.severity === vscode.DiagnosticSeverity.Error)) {
              errorCount++;
            }
          }
        } catch {
          // ignore individual file parse failure
        }
      }
      return errorCount;
    } catch {
      return 0;
    }
  }

  private applyDecorationsToDocument(
    uri: vscode.Uri,
    decorations: vscode.DecorationOptions[]
  ): void {
    const uriStr = uri.toString();
    if (vscode.window.visibleTextEditors) {
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document && editor.document.uri.toString() === uriStr) {
          if (typeof editor.setDecorations === 'function') {
            editor.setDecorations(this.errorDecorationType, decorations);
          }
        }
      }
    }
  }

  public applyStoredDecorations(editor: vscode.TextEditor): void {
    if (!editor || !editor.document) return;
    const decorations = this.lastDecorations.get(editor.document.uri.toString());
    if (decorations && typeof editor.setDecorations === 'function') {
      editor.setDecorations(this.errorDecorationType, decorations);
    }
  }

  public triggerInspect(editor: vscode.TextEditor): void {
    const lang = editor.document.languageId;
    if (lang === 'python' || lang === 'typescript' || lang === 'javascript') {
      this.debouncedInspect(editor);

      // For large files (>1500 lines), schedule full audit when user pauses typing
      if (editor.document.lineCount > 1500) {
        const uriStr = editor.document.uri.toString();
        const existingTimer = this.fullAuditTimers.get(uriStr);
        if (existingTimer) {
          clearTimeout(existingTimer);
        }
        const timer = setTimeout(() => {
          this.fullAuditTimers.delete(uriStr);
          this.inspectDocument(editor.document);
        }, 1200);
        this.fullAuditTimers.set(uriStr, timer);
      }
    }
  }

  public clearDocument(uri: vscode.Uri): void {
    this.diagnosticCollection.delete(uri);
    this.lastDecorations.delete(uri.toString());
    this.lastCalls.delete(uri.toString());
    this.applyDecorationsToDocument(uri, []);
  }

  public clearAll(): void {
    this.diagnosticCollection.clear();
    this.sigCache.clear();
    this.lastCalls.clear();
    for (const uriStr of this.lastDecorations.keys()) {
      if (vscode.window.visibleTextEditors) {
        for (const editor of vscode.window.visibleTextEditors) {
          if (editor.document && editor.document.uri.toString() === uriStr) {
            if (typeof editor.setDecorations === 'function') {
              editor.setDecorations(this.errorDecorationType, []);
            }
          }
        }
      }
    }
    this.lastDecorations.clear();
  }

  dispose(): void {
    this.debouncedInspect.cancel();
    for (const t of this.fullAuditTimers.values()) {
      clearTimeout(t);
    }
    this.fullAuditTimers.clear();
    this.clearAll();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
