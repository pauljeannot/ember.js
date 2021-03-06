import { assert } from '@ember/debug';
import { DEBUG } from '@glimmer/env';

export interface DebugStack {
  peek(): string | void;
}

export interface DebugContext {
  env: {
    debugStack: DebugStack;
  };
}

export type MethodKey<T> = { [K in keyof T]: T[K] extends (() => void) ? K : never }[keyof T];
export type RunInTransactionFunc = <T extends object, K extends MethodKey<T>>(
  context: T,
  methodName: K
) => boolean;
export type DidRenderFunc = (object: any, key: string, reference: any) => void;
export type AssertNotRenderedFunc = (obj: object, keyName: string) => void;

let runInTransaction: RunInTransactionFunc;
let didRender: DidRenderFunc;
let assertNotRendered: AssertNotRenderedFunc;

// detect-backtracking-rerender by default is debug build only
if (DEBUG) {
  // there are 2 states

  // DEBUG
  // tracks lastRef and lastRenderedIn per rendered object and key during a transaction
  // release everything via normal weakmap semantics by just derefencing the weakmap

  // RELEASE
  // tracks transactionId per rendered object and key during a transaction
  // release everything via normal weakmap semantics by just derefencing the weakmap

  class TransactionRunner {
    transactionId: number;
    inTransaction: boolean;
    shouldReflush: boolean;
    weakMap: WeakMap<object, any>;
    debugStack: DebugStack | undefined;

    constructor() {
      this.transactionId = 0;
      this.inTransaction = false;
      this.shouldReflush = false;
      this.weakMap = new WeakMap();
      if (DEBUG) {
        // track templates
        this.debugStack = undefined;
      }
    }

    runInTransaction<T extends object, K extends MethodKey<T>>(context: T, methodName: K): boolean {
      this.before(context);
      try {
        (context[methodName] as any)();
      } finally {
        this.after();
      }
      return this.shouldReflush;
    }

    didRender(object: object, key: string, reference: any): void {
      if (!this.inTransaction) {
        return;
      }
      if (DEBUG) {
        this.setKey(object, key, {
          lastRef: reference,
          lastRenderedIn: this.debugStack!.peek(),
        });
      } else {
        this.setKey(object, key, this.transactionId);
      }
    }

    assertNotRendered(object: object, key: string): void {
      if (!this.inTransaction) {
        return;
      }
      if (this.hasRendered(object, key)) {
        if (DEBUG) {
          let { lastRef, lastRenderedIn } = this.getKey(object, key);
          let currentlyIn = this.debugStack!.peek();

          let label = '';

          if (lastRef && typeof lastRef.debug === 'function') {
            label = `as \`${lastRef.debug()}\` in ${lastRenderedIn}`;
          } else {
            label = `in ${lastRenderedIn}`;
          }

          assert(
            `You modified \`${object}\` twice in a single render. It was first rendered ${label} and then modified later in ${currentlyIn}. This was unreliable and slow in Ember 1.x and is no longer supported. See https://github.com/emberjs/ember.js/issues/13948 for more details.`,
            false
          );
        }

        this.shouldReflush = true;
      }
    }

    hasRendered(object: object, key: string): boolean {
      if (!this.inTransaction) {
        return false;
      }
      if (DEBUG) {
        return this.getKey(object, key) !== undefined;
      }
      return this.getKey(object, key) === this.transactionId;
    }

    before(context: object): void {
      this.inTransaction = true;
      this.shouldReflush = false;
      if (DEBUG) {
        this.debugStack = (context as DebugContext).env.debugStack;
      }
    }

    after(): void {
      this.transactionId++;
      this.inTransaction = false;
      if (DEBUG) {
        this.debugStack = undefined;
      }
      this.clearObjectMap();
    }

    createMap(object: object): object {
      let map = Object.create(null);
      this.weakMap.set(object, map);
      return map;
    }

    getOrCreateMap(object: object): object {
      let map = this.weakMap.get(object);
      if (map === undefined) {
        map = this.createMap(object);
      }
      return map;
    }

    setKey(object: object, key: string, value: any): void {
      let map = this.getOrCreateMap(object);
      map[key] = value;
    }

    getKey(object: object, key: string): any {
      let map = this.weakMap.get(object);
      if (map !== undefined) {
        return map[key];
      }
    }

    clearObjectMap(): void {
      this.weakMap = new WeakMap();
    }
  }

  let runner = new TransactionRunner();

  runInTransaction = (...args) => runner.runInTransaction(...args);
  didRender = (...args) => runner.didRender(...args);
  assertNotRendered = (...args) => runner.assertNotRendered(...args);
} else {
  // in production do nothing to detect reflushes
  runInTransaction = <T extends object, K extends MethodKey<T>>(context: T, methodName: K) => {
    (context[methodName] as any)();
    return false;
  };
}

export { runInTransaction as default, didRender, assertNotRendered };
