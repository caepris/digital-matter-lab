import { cloneDocument, type AssemblyDocument } from './AssemblyDocument';

const HISTORY_LIMIT = 100;

export class AssemblyHistory {
  private past: AssemblyDocument[] = [];
  private future: AssemblyDocument[] = [];
  private gestureStart: AssemblyDocument | null = null;
  current: AssemblyDocument;

  constructor(document: AssemblyDocument) {
    this.current = cloneDocument(document);
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  commit(next: AssemblyDocument): void {
    this.gestureStart = null;
    if (serialize(this.current) === serialize(next)) return;
    this.past.push(this.current);
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.current = cloneDocument(next);
    this.future = [];
  }

  beginGesture(): void {
    if (!this.gestureStart) this.gestureStart = this.current;
  }

  preview(next: AssemblyDocument): void {
    this.current = cloneDocument(next);
  }

  endGesture(): void {
    if (!this.gestureStart) return;
    const start = this.gestureStart;
    const next = this.current;
    this.gestureStart = null;
    this.current = start;
    this.commit(next);
  }

  cancelGesture(): void {
    if (!this.gestureStart) return;
    this.current = this.gestureStart;
    this.gestureStart = null;
  }

  undo(): AssemblyDocument {
    this.cancelGesture();
    const previous = this.past.pop();
    if (!previous) return this.current;
    this.future.push(this.current);
    this.current = previous;
    return this.current;
  }

  redo(): AssemblyDocument {
    this.cancelGesture();
    const next = this.future.pop();
    if (!next) return this.current;
    this.past.push(this.current);
    this.current = next;
    return this.current;
  }

  reset(document: AssemblyDocument): void {
    this.past = [];
    this.future = [];
    this.gestureStart = null;
    this.current = cloneDocument(document);
  }
}

function serialize(document: AssemblyDocument): string {
  return JSON.stringify(document);
}
