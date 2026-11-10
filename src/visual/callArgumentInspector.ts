import * as vscode from 'vscode';
import { SymbolIndexer } from '../indexer/symbolIndexer';
import { SymbolDefinition } from '../types';
import { getOmniConfig, debounce, ICON_DATA_URIS } from '../utils';

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
      this.inspectDocument(editor.document);
    }, 250);

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
      params: positionalParams.concat(keywordOnlyParams),
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
        if (ch === inQuote && argText[i - 1] !== '\\') inQuote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
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
   */
  public inspectDocument(document: vscode.TextDocument): vscode.Diagnostic[] {
    if (document.languageId !== 'python') {
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

        // 1. Check: Too many positional arguments
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
          const excessItems = callArgs.items.filter((it) => !it.isKeyword).slice(maxAllowed);
          const targetRange =
            excessItems.length > 0
              ? new vscode.Range(excessItems[0].range.start, excessItems[excessItems.length - 1].range.end)
              : callArgs.argRange.isEmpty
              ? new vscode.Range(lineIdx, match.index, lineIdx, openParenChar + 1)
              : callArgs.argRange;

          const errorMsg = `'${methodName}' 最多接收 ${maxAllowed} 个位置参数，但实际传入了 ${callArgs.positionalCount} 个 (PyCharm 风格参数检查)`;
          const diag = new vscode.Diagnostic(
            targetRange,
            `XF OmniNav: ${errorMsg}`,
            severity
          );
          diag.source = 'XF OmniNav';
          diag.code = 'too-many-arguments';
          diagnostics.push(diag);

          if (enableHighlight) {
            decorations.push({
              range: targetRange,
              hoverMessage: new vscode.MarkdownString(
                `**XF OmniNav: 参数错误 (PyCharm 风格)**\n\n\`${methodName}\` 最多接收 **${maxAllowed}** 个位置参数，但实际传入了 **${callArgs.positionalCount}** 个。`
              ),
              renderOptions: {
                after: {
                  contentText: ` ❗参数错误: 期望 ≤${maxAllowed} 个，实传 ${callArgs.positionalCount} 个`,
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
              if (pIdx < callArgs.positionalCount) continue;
              if (callArgs.keywords.includes(p.name)) continue;
              missingForThisSig.push(p.name);
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
                    contentText: ` ❗缺少必填参数: ${missingNames.join(', ')}`,
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

    this.lastCalls.set(document.uri.toString(), parsedCalls);
    this.diagnosticCollection.set(document.uri, diagnostics);
    this.lastDecorations.set(document.uri.toString(), decorations);
    this.applyDecorationsToDocument(document.uri, decorations);
    return diagnostics;
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
    if (editor.document.languageId === 'python') {
      this.debouncedInspect(editor);
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
    this.clearAll();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
