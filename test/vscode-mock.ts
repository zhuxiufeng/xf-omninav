export class Position {
  constructor(public line: number, public character: number) {}
}

export class Range {
  public start: Position;
  public end: Position;
  constructor(start: Position, end: Position);
  constructor(startLine: number, startChar: number, endLine: number, endChar: number);
  constructor(a: any, b: any, c?: any, d?: any) {
    if (typeof a === 'number') {
      this.start = new Position(a, b);
      this.end = new Position(c, d);
    } else {
      this.start = a;
      this.end = b;
    }
  }

  isEqual(other: Range): boolean {
    return (
      this.start.line === other.start.line &&
      this.start.character === other.start.character &&
      this.end.line === other.end.line &&
      this.end.character === other.end.character
    );
  }

  contains(positionOrRange: Position | Range): boolean {
    if ('start' in positionOrRange) {
      return this.contains(positionOrRange.start) && this.contains(positionOrRange.end);
    }
    const pos = positionOrRange;
    if (pos.line < this.start.line || pos.line > this.end.line) {
      return false;
    }
    if (pos.line === this.start.line && pos.character < this.start.character) {
      return false;
    }
    if (pos.line === this.end.line && pos.character > this.end.character) {
      return false;
    }
    return true;
  }
}

export class Selection extends Range {
  public active: Position;
  public anchor: Position;
  constructor(anchor: Position, active: Position) {
    super(anchor, active);
    this.anchor = anchor;
    this.active = active;
  }
}

export class Location {
  constructor(public uri: Uri, public range: Range | Position) {}
}

export class Uri {
  public scheme: string = 'file';
  constructor(public fsPath: string) {
    if (fsPath.startsWith('vscode-remote://')) {
      this.scheme = 'vscode-remote';
    }
  }
  static parse(val: string): Uri {
    return new Uri(val.replace(/^file:\/\//, ''));
  }
  static file(val: string): Uri {
    return new Uri(val);
  }
  toString(): string {
    return `${this.scheme}://${this.fsPath}`;
  }
}

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

export class MockTextLine {
  constructor(public text: string, public lineNumber: number) {}
  get range(): Range {
    return new Range(this.lineNumber, 0, this.lineNumber, this.text.length);
  }
  get firstNonWhitespaceCharacterIndex(): number {
    const match = this.text.match(/^(\s*)/);
    return match ? match[1].length : 0;
  }
}

export class MockTextDocument {
  private lines: string[];
  public uri: Uri;
  public languageId: string;

  constructor(content: string, uriStr = 'file:///test.py', languageId = 'python') {
    this.lines = content.split('\n');
    this.uri = Uri.parse(uriStr);
    this.languageId = languageId;
  }

  get lineCount(): number {
    return this.lines.length;
  }

  get fileName(): string {
    return this.uri.fsPath;
  }

  getText(range?: Range): string {
    if (!range) {
      return this.lines.join('\n');
    }
    if (range.start.line === range.end.line) {
      const line = this.lines[range.start.line] || '';
      return line.substring(range.start.character, range.end.character);
    }
    const result: string[] = [];
    for (let i = range.start.line; i <= range.end.line; i++) {
      const line = this.lines[i] || '';
      if (i === range.start.line) {
        result.push(line.substring(range.start.character));
      } else if (i === range.end.line) {
        result.push(line.substring(0, range.end.character));
      } else {
        result.push(line);
      }
    }
    return result.join('\n');
  }

  lineAt(line: number): MockTextLine {
    return new MockTextLine(this.lines[line] || '', line);
  }

  getWordRangeAtPosition(position: Position, regex = /[A-Za-z0-9_]+/): Range | undefined {
    const line = this.lineAt(position.line).text;
    const globalRegex = new RegExp(regex.source, 'g');
    let match;
    while ((match = globalRegex.exec(line)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (position.character >= start && position.character <= end) {
        return new Range(position.line, start, position.line, end);
      }
    }
    return undefined;
  }
}

export class EventEmitter<T = any> {
  private listeners: ((e: T) => any)[] = [];
  event = (listener: (e: T) => any) => {
    this.listeners.push(listener);
    return { dispose: () => {} };
  };
  fire(data: T) {
    this.listeners.forEach((l) => l(data));
  }
  dispose() {
    this.listeners = [];
  }
}

export const workspace = {
  workspaceFolders: [] as any[],
  textDocuments: [] as MockTextDocument[],
  asRelativePath(uri: Uri) {
    return uri.fsPath;
  },
  fs: {
    stat: async () => ({ type: 1 }),
    readDirectory: async () => [] as [string, number][],
    readFile: async () => Buffer.from(''),
  },
  findFiles: async () => [],
  getWorkspaceFolder(_uri: Uri) {
    return undefined;
  },
  getConfiguration() {
    return {
      get: (_key: string, defVal: any) => defVal,
    };
  },
  openTextDocument: async (uri: Uri) => {
    const found = workspace.textDocuments.find(
      (d) => d.uri.toString() === uri.toString() || d.uri.fsPath.endsWith(uri.fsPath)
    );
    if (found) {
      return found;
    }
    return new MockTextDocument('', uri.toString(), 'python');
  },
  onDidSaveTextDocument: () => ({ dispose: () => {} }),
  onDidChangeTextDocument: () => ({ dispose: () => {} }),
  createFileSystemWatcher: () => ({
    onDidCreate: () => ({ dispose: () => {} }),
    onDidDelete: () => ({ dispose: () => {} }),
    dispose: () => {},
  }),
};

export const window = {
  activeTextEditor: undefined as any,
  showInformationMessage: async () => undefined,
  showQuickPick: async () => undefined,
  showTextDocument: async (doc: any) => ({
    document: doc,
    selection: new Selection(new Position(0, 0), new Position(0, 0)),
    revealRange: () => {},
  }),
  createStatusBarItem: () => ({
    text: '',
    tooltip: '',
    show: () => {},
    hide: () => {},
    dispose: () => {},
  }),
  withProgress: async (_opt: any, task: any) => await task(),
};

export const languages = {
  registerDefinitionProvider: () => ({ dispose: () => {} }),
};

export const commands = {
  registerCommand: () => ({ dispose: () => {} }),
  executeCommand: async () => undefined,
};

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum TextEditorRevealType {
  Default = 0,
  InCenter = 1,
}

export const debug = {
  breakpoints: [],
  onDidChangeBreakpoints: () => ({ dispose: () => {} }),
};

export enum SymbolKind {
  File = 0,
  Module = 1,
  Namespace = 2,
  Package = 3,
  Class = 4,
  Method = 5,
  Property = 6,
  Field = 7,
  Constructor = 8,
  Enum = 9,
  Interface = 10,
  Function = 11,
  Variable = 12,
  Constant = 13,
  String = 14,
  Number = 15,
  Boolean = 16,
  Array = 17,
  Object = 18,
  Key = 19,
  Null = 20,
  EnumMember = 21,
  Struct = 22,
  Event = 23,
  Operator = 24,
  TypeParameter = 25,
}
