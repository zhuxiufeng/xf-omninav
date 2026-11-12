export class Position {
  constructor(public readonly line: number, public readonly character: number) {}
}

export class Range {
  public readonly start: Position;
  public readonly end: Position;

  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number);
  constructor(start: Position, end: Position);
  constructor(a: any, b: any, c?: any, d?: any) {
    if (typeof a === 'number') {
      this.start = new Position(a, b);
      this.end = new Position(c, d);
    } else {
      this.start = a;
      this.end = b;
    }
  }
}

export const Uri = {
  parse(str: string) {
    const fsPath = str.startsWith('file://') ? str.slice(7) : str;
    return {
      scheme: 'file',
      fsPath,
      path: fsPath,
      toString() {
        return str;
      },
    };
  },
  file(fsPath: string) {
    return {
      scheme: 'file',
      fsPath,
      path: fsPath,
      toString() {
        return 'file://' + fsPath;
      },
    };
  },
};

export const workspace = {
  asRelativePath(uriOrPath: any, _includeWorkspaceFolder?: boolean): string {
    const p =
      typeof uriOrPath === 'string'
        ? uriOrPath
        : uriOrPath?.fsPath || uriOrPath?.path || '';
    return p;
  },
};
