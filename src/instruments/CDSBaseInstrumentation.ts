/* eslint-disable max-len */
/* eslint-disable prefer-rest-params */
/* eslint-disable @typescript-eslint/no-this-alias */
/* eslint-disable @typescript-eslint/no-floating-promises */
import api, { Context, Span, SpanOptions, SpanStatusCode, ROOT_CONTEXT } from "@opentelemetry/api";
import { InstrumentationBase, InstrumentationNodeModuleFile } from "@opentelemetry/instrumentation";
import { SemanticAttributes } from "@opentelemetry/semantic-conventions";

export type SpanNameHook = (thisValue: any, args: IArguments) => string;
export type Done = (this: any, error?: any) => void;
export type StartExecutionHook = (span: Span, thisValue: any, args: IArguments) => void;

export type ModuleTransform = (moduleExport: any) => any;

export interface Hooks {
  /**
   * hook which invocated before the original function is invoked
   */
  startExecutionHook?: StartExecutionHook;
}

export abstract class CDSBaseServiceInstrumentation extends InstrumentationBase {

  private getCurrentSpan() {
    return api.trace.getSpan(api.context.active());
  }

  /**
   * create a new context from current span, if no current span, use root context
   * 
   * @returns 
   */
  protected createNewContext(): Context {
    const currentSpan = this.getCurrentSpan();
    if (currentSpan !== undefined) {
      return api.trace.setSpan(
        api.context.active(),
        currentSpan
      );
    }
    return ROOT_CONTEXT;
  }

  /**
   * create sub span base current context
   *
   * @param newSpanName
   * @param options
   * @returns
   */
  protected createSubSpan(newSpanName: string, options?: SpanOptions) {
    return this.tracer.startSpan(newSpanName, options, this.createNewContext());
  }

  /**
   * create a simple measure module function
   * 
   * @param moduleExport 
   * @param moduleName 
   * @param functionName 
   */
  protected _simpleMeasure(moduleExport: any, moduleName: string, functionName: string, hooks?: Hooks) {

    this._wrap(moduleExport, functionName, (original) => {
      const spanName = `${moduleName}.${functionName}`;
      return this._createWrapForNormalFunction(
        spanName,
        original,
        {
          attributes: {
            [SemanticAttributes.CODE_FILEPATH]: moduleName,
            [SemanticAttributes.CODE_FUNCTION]: functionName,
          }
        },
        hooks
      );
    });
  }

  protected _createSimplePatchFile(
    moduleName: string,
    functions: Array<string>,
    moduleTransform?: ModuleTransform
  ): InstrumentationNodeModuleFile<any>;

  protected _createSimplePatchFile(
    moduleName: string,
    functions: any,
    moduleTransform: ModuleTransform = v => v
  ): InstrumentationNodeModuleFile<any> {
    return new InstrumentationNodeModuleFile<any>(
      moduleName,
      ["*"],
      moduleExport => {
        for (const functionName of functions) {
          this._simpleMeasure(moduleTransform(moduleExport), moduleName, functionName);
        }
        return moduleExport;
      },
      moduleExport => {
        for (const functionName of functions) {
          this._unwrap(moduleTransform(moduleExport), functionName);
        }
      }
    );
  }

  private _executeHooks(span: Span, thisValue: any, args: IArguments, hooks?: Hooks) {
    if (hooks === undefined) {
      return;
    }
    hooks?.startExecutionHook?.(span, thisValue, args);
  }

  protected _createWrapForNormalFunction(
    spanName: string,
    original: (...args: Array<any>) => void,
    options?: SpanOptions,
    hooks?: Hooks,
  ) {
    const inst = this;
    const redefined = function (this: any) {
      const newSpan = inst.createSubSpan(spanName, options);
      return api.context.with(
        api.trace.setSpan(api.context.active(), newSpan),
        () => {
          inst._executeHooks(newSpan, this, arguments, hooks);
          let r: any;
          try {
            r = original.apply(this, arguments as any);
          }
          catch (error) {
            newSpan.recordException(error);
            newSpan.setStatus({ code: SpanStatusCode.ERROR });
            newSpan.end();
            throw error;
          }

          if (r instanceof Promise) {
            return r
              .catch(error => {
                newSpan.recordException(error);
                newSpan.setStatus({ code: SpanStatusCode.ERROR });
                throw error;
              })
              .finally(() => newSpan.end());
          }
          else {
            newSpan.end();
            return r;
          }
        }) as unknown as any;
    };
    if (original?.name !== undefined) {
      Object.defineProperty(redefined, "name", { value: original.name });
    }
    return redefined;
  }

  protected _createWrapForCbFunction(
    spanName: string,
    original: (...args: Array<any>) => void,
    options?: SpanOptions,
    hooks?: Hooks,
  ) {
    const inst = this;
    const redefined = function (this: any) {
      const newSpan = inst.createSubSpan(spanName, options);
      return api.context.with(
        api.trace.setSpan(api.context.active(), newSpan),
        () => {
          inst._executeHooks(newSpan, this, arguments, hooks);
          function done(error?: any) {
            if (error) {
              newSpan.recordException(error);
              newSpan.setStatus({ code: SpanStatusCode.ERROR });
            }
            newSpan.end();
          }
          const cb = arguments?.[arguments.length - 1];
          if (typeof cb === "function") {
            return original.apply(
              this,
              Array
                .from(arguments)
                .slice(0, arguments.length - 1)
                .concat(function wrapCb(this: any) {
                  done?.apply(this, arguments as any);
                  cb?.apply(this, arguments);
                })
            );
          }
          return original.apply(this, arguments as any);
        }) as unknown as any;
    };
    if (original?.name !== undefined) {
      Object.defineProperty(redefined, "name", { value: original.name });
    }
    return redefined;

  }

}
