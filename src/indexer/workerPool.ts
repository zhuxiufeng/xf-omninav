import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Worker } from 'worker_threads';
import * as vscode from 'vscode';
import { CompactSymbolDefinition } from '../types';

export interface SerializedSymbolItem {
  name: string;
  kind: any;
  containerName?: string;
  parentContainers?: string[];
  r: [number, number, number, number];
  sr: [number, number, number, number];
  signature: string;
  fileRelativePath: string;
  isExported?: boolean;
  docstring?: string;
}

interface WorkerTask {
  id: number;
  uriStr: string;
  text: string;
  workspaceRoot?: string;
  resolve: (defs: CompactSymbolDefinition[]) => void;
  reject: (err: any) => void;
}

export class WorkerPool implements vscode.Disposable {
  private workers: Worker[] = [];
  private idleWorkers: Worker[] = [];
  private activeWorkers = new Map<number, Worker>();
  private activeTasks = new Map<number, WorkerTask>();
  private pendingQueue: WorkerTask[] = [];
  private nextTaskId = 1;
  private isEnabled = false;

  constructor() {
    this.initPool();
  }

  private initPool(): void {
    try {
      // Look for parseWorker.js in multiple locations:
      // 1. Same directory (dev/source)
      // 2. ../dist/parseWorker.js (bundled extension)
      // 3. dist/parseWorker.js
      const candidates = [
        path.join(__dirname, 'parseWorker.js'),
        path.join(__dirname, '../dist/parseWorker.js'),
        path.join(__dirname, '../../dist/parseWorker.js'),
        path.join(process.cwd(), 'dist/parseWorker.js'),
      ];

      let workerPath: string | undefined;
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          workerPath = p;
          break;
        }
      }

      if (!workerPath) {
        return;
      }

      // Max workers: CPU count - 1, capped between 2 and 4
      const cpuCount = typeof os.cpus === 'function' ? os.cpus().length : 2;
      const poolSize = Math.max(1, Math.min(cpuCount - 1, 4));

      for (let i = 0; i < poolSize; i++) {
        const worker = new Worker(workerPath);
        worker.on('message', (res: { id: number; uriStr: string; defs?: SerializedSymbolItem[]; error?: string }) => {
          const task = this.activeTasks.get(res.id);
          this.activeTasks.delete(res.id);
          this.activeWorkers.delete(res.id);

          this.idleWorkers.push(worker);
          this.drainQueue();

          if (task) {
            if (res.error) {
              task.reject(new Error(res.error));
            } else if (res.defs) {
              const uri = vscode.Uri.parse(res.uriStr);
              const defs = res.defs.map(
                (d) =>
                  new CompactSymbolDefinition({
                    name: d.name,
                    kind: d.kind,
                    uri,
                    range: d.r,
                    selectionRange: d.sr,
                    signature: d.signature,
                    fileRelativePath: d.fileRelativePath,
                    containerName: d.containerName,
                    parentContainers: d.parentContainers,
                    docstring: d.docstring,
                    isExported: d.isExported,
                  })
              );
              task.resolve(defs);
            } else {
              task.resolve([]);
            }
          }
        });

        worker.on('error', (_err) => {
          // If a worker encounters an error, remove it from active and idle pools
          const idleIdx = this.idleWorkers.indexOf(worker);
          if (idleIdx !== -1) {
            this.idleWorkers.splice(idleIdx, 1);
          }
        });

        this.workers.push(worker);
        this.idleWorkers.push(worker);
      }

      this.isEnabled = this.workers.length > 0;
    } catch {
      this.isEnabled = false;
    }
  }

  public get available(): boolean {
    return this.isEnabled && this.workers.length > 0;
  }

  public parseText(
    uriStr: string,
    text: string,
    workspaceRoot?: string
  ): Promise<CompactSymbolDefinition[]> {
    if (!this.available) {
      return Promise.reject(new Error('WorkerPool unavailable'));
    }

    return new Promise<CompactSymbolDefinition[]>((resolve, reject) => {
      const task: WorkerTask = {
        id: this.nextTaskId++,
        uriStr,
        text,
        workspaceRoot,
        resolve,
        reject,
      };

      this.pendingQueue.push(task);
      this.drainQueue();
    });
  }

  private drainQueue(): void {
    while (this.pendingQueue.length > 0 && this.idleWorkers.length > 0) {
      const task = this.pendingQueue.shift()!;
      const worker = this.idleWorkers.shift()!;

      this.activeTasks.set(task.id, task);
      this.activeWorkers.set(task.id, worker);

      worker.postMessage({
        id: task.id,
        uriStr: task.uriStr,
        text: task.text,
        workspaceRoot: task.workspaceRoot,
      });
    }
  }

  public dispose(): void {
    this.isEnabled = false;
    for (const w of this.workers) {
      try {
        w.terminate();
      } catch {}
    }
    this.workers = [];
    this.idleWorkers = [];
    this.pendingQueue = [];
    this.activeTasks.clear();
  }
}
