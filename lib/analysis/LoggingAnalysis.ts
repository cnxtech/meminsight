/*
 * Copyright (c) 2014 Samsung Electronics Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *        http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
///<reference path='../ts-declarations/node.d.ts' />
///<reference path='../ts-declarations/jalangi.d.ts' />
///<reference path='./Loggers.ts' />
///<reference path='./InstUtils.ts' />
///<reference path='./ObjIdManager.ts' />
///<reference path='./LastUseManager.ts' />
///<reference path='./NativeModels.ts' />
/**
 * Created by m.sridharan on 5/29/14.
 */



module ___LoggingAnalysis___ {

    if (!isBrowser) {
        require('jalangi2/src/js/instrument/astUtil');
        require('../lib/analysis/memAnalysisUtils');
    }

    class LoggingAnalysis implements JalangiAnalysis {
        /***************************************/
        /* ANALYSIS STATE AND INTERNAL METHODS */
        /***************************************/

        private updateLastUse(objId: number,iid:number) {
            this.lastUse.updateLastUse(objId, iid, this.logger.getTime());
        }


        private logger: Logger;

        private idManager: ObjIdManager;

        private nativeModels: NativeModels;

        private lastUse: LastUseManager;
        /***********************************/
        /* CONSTRUCTOR AND JALANGI METHODS */
        /***********************************/

        constructor() {
        }

        private initJalangiConfig(): void {
            var conf = J$.Config;
            var instHandler = (<any>J$).memAnalysisUtils.instHandler;
            conf.INSTR_READ = instHandler.instrRead;
            conf.INSTR_WRITE = instHandler.instrWrite;
            conf.INSTR_GETFIELD = instHandler.instrGetfield;
            conf.INSTR_PUTFIELD = instHandler.instrPutfield;
            conf.INSTR_BINARY = instHandler.instrBinary;
            conf.INSTR_PROPERTY_BINARY_ASSIGNMENT = instHandler.instrPropBinaryAssignment;
            conf.INSTR_UNARY = instHandler.instrUnary;
            conf.INSTR_LITERAL = instHandler.instrLiteral;
            conf.INSTR_CONDITIONAL = instHandler.instrConditional;
        }

        init(initParam: any): void {
            this.lastUse = new LastUseManager(initParam["allUses"] !== undefined);
            this.initLogger(initParam, this.lastUse);
            this.lastUse.setLogger(this.logger);
            var idManager = createObjIdManager(this.logger, this.lastUse, initParam["useHiddenProp"] !== undefined);
            this.idManager = idManager;
            this.nativeModels = new NativeModels(idManager, this.logger);
            this.logAllPutfields = initParam["allPutfields"] !== undefined;
            this.initJalangiConfig();
            var debugFun = initParam["debugFun"];
            if (debugFun) {
                // we monkey-patch here to avoid checking the debug flag on every invocation
                // of invokeFunPre
                var origInvokeFunPre = this.invokeFunPre;
                this.invokeFunPre = (iid:number, f:any, base:any, args:any, isConstructor:boolean, isMethod: boolean) => {
                    if (f && f.name === debugFun) {
                        var obj = args[0];
                        // we should already have metadata for the object
                        if (!idManager.hasMetadata(obj)) {
                            throw new Error("missing metadata for argument to debug function");
                        }
                        var objId = idManager.findExtantObjId(obj);
                        this.logger.logDebug(iid, objId);
                    }
                    origInvokeFunPre.call(this,iid,f,base,args,isConstructor,isMethod);
                    return null;
                }
            }
            if (isBrowser) {
                window.addEventListener('keydown', (e) => {
                    // keyboard shortcut is Alt-Shift-T for now
                    if (e.altKey && e.shiftKey && e.keyCode === 84) {
                        this.lastUse.flushLastUse();
                        this.logger.end(() => {
                            alert("all flushed\n" + this.nativeModels.getNumDOMNodesModeled() + " DOM node locations from models");
                        });
                        this.logger.stopTracing();
                    }
                });
            }
        }

        initLogger(initParam: any, lastUse: LastUseManager) {
            var logger:Logger;
            if (isBrowser) {
                if (initParam["syncAjax"]) {
                    throw new Error("TODO revive support for synchronous AJAX logging");
//                    logger = new SyncAjaxLogger();
                } else {
                    logger = new BinaryWebSocketLogger(lastUse);
                }
            } else {
                if (initParam["syncFS"]) {
                    if (initParam["asciiFS"]) {
                        logger = new AsciiFSLogger(lastUse);
                    } else {
                        logger = new BinaryFSLogger(lastUse);
                    }
                } else {
                    logger = new NodeWebSocketLogger(lastUse, initParam["appDir"]);
                }
            }
            this.logger = logger;
        }

        onReady(readyCB: () => void) {
            if (this.logger instanceof NodeWebSocketLogger) {
                (<NodeWebSocketLogger>this.logger).setConnectCB(readyCB);
            } else {
                readyCB();
            }
        }

        declare(iid:number, name:string, val:any, isArgument:boolean):any {
            // TODO handle case where code overwrites arguments?
            if (name !== 'arguments') {
                var id = 0;
                if (isObject(val)) {
                    id = this.idManager.findOrCreateUniqueId(val, iid, false);
                }
                this.logger.logDeclare(iid, name, id);
            }
        }

        literal(iid:number, val:any, hasGetterSetter: boolean):any {
            if (isObject(val)) {
                var valId = this.idManager.findOrCreateUniqueId(val, iid, true);
                if (!(typeof val === 'function')) {
                    this.handleLiteralProperties(iid, val, valId, hasGetterSetter);
                }
            }
        }

        private handleLiteralProperties(iid: number, lit: any, litId: number, hasGetterSetter: boolean) {
            var props = Object.keys(lit);
            var simple = (offset: string) => {
                var child = lit[offset];
                if (isObject(child)) {
                    var childId = this.idManager.findOrCreateUniqueId(child, iid, false);
                    this.logger.logPutfield(iid,litId,offset,childId);
                }
            };
            if (!hasGetterSetter) {
                props.forEach(simple);
            } else {
                props.forEach((offset) => {
                    var descriptor = Object.getOwnPropertyDescriptor(lit,offset);
                    if (descriptor.get !== undefined || descriptor.set !== undefined) {
                        var annotateGetterSetter = (fun:any, getter: boolean) => {
                            if (fun) {
                                // fun may already be annotated in the case where we
                                // are annotating properties of an object returned from a constructor
                                // call. but, we can't detect this case.
                                var id = this.idManager.findOrCreateUniqueId(fun, iid, true);
                                var synthProp = getter ? "~get~" + fun.name : "~set~" + fun.name;
                                this.logger.logPutfield(iid, litId, synthProp, id);
                            }
                        };
                        annotateGetterSetter(descriptor.get, true);
                        annotateGetterSetter(descriptor.set, false);
                    } else {
                        simple(offset);
                    }
                });
            }
        }

        /**
         * used to track whether we have emitted a call log entry from the caller.
         * If so, then functionEnter in the callee need not emit the log entry
         * @type {boolean}
         */
        private emittedCall = false;

        /**
         * used to track whether a call is known to be a constructor call.  set at
         * invokeFunPre, unset in functionEnter
         * @type {boolean}
         */
        private isConstructor = false;

        invokeFunPre(iid:number, f:Function, base:any, args:any[], isConstructor:boolean, isMethod: boolean): InvokeFunPreResult {
            if (!this.nativeModels.modelInvokeFunPre(iid, f, base, args, isConstructor, isMethod)) {
                if (f) {
                    var funEnterIID = lookupCachedFunEnterIID(f);
                    if (funEnterIID !== undefined) { // invoking a known, instrumented function
                        var funObjId = this.idManager.findObjId(f);
                        var funSID = f[J$.Constants.SPECIAL_PROP_SID];
                        this.logger.logCall(iid, funObjId, funEnterIID, funSID);
                        this.emittedCall = true;
                        this.isConstructor = isConstructor;
                    }
                }
            }
            return;
        }


        /**
         * if evalIID === -1, indirect eval
         * @param evalIID
         * @param iidMetadata
         */
        instrumentCode(evalIID: number, newAST: any): Result {
            console.log("instrumenting eval " + evalIID);
            var na = (<any>J$).memAnalysisUtils;
            // TODO log source mapping???
            var curVarNames:any = null;
            var freeVarsHandler = (node: any, context: any) => {
                var fv:any = na.freeVars(node);
                curVarNames = fv === na.ANY ? "ANY" : Object.keys(fv);
            };
            var visitorPost = {
                'CallExpression': (node: any) => {
                    if (node.callee.object && node.callee.object.name === 'J$' && (node.callee.property.name === 'Fe')) {
                        var iid: any = node.arguments[0].value;
                        this.logger.logFreeVars(iid, curVarNames);
                    }
                    return node;
                }
            };
            var visitorPre = {
                'FunctionExpression': freeVarsHandler,
                'FunctionDeclaration': freeVarsHandler
            };
            J$.astUtil.transformAst(newAST, visitorPost, visitorPre);
            return;

        }

        invokeFun(iid:number, f:any, base:any, args:any, val:any, isConstructor:boolean, isMethod: boolean):any {
            var idManager = this.idManager;
            if (isObject(val)) {
                if (idManager.hasMetadata(val)) {
                    var metadata: number = idManager.getMetadata(val);
                    if (idManager.isUnannotatedThis(metadata)) {
                        var objId = idManager.extractObjId(metadata);
                        if (isConstructor) {
                            // update the IID
                            this.logger.logUpdateIID(objId, iid);
                            // log a putfield to expose pointer to the prototype object
                            var funProto = f.prototype;
                            if (isObject(funProto)) {
                                var funProtoId = idManager.findOrCreateUniqueId(funProto, iid, false);
                                this.logger.logPutfield(iid, objId, "__proto__", funProtoId);
                            }

                        }
                        // unset the bit
                        idManager.setMetadata(val,objId);
                    }
                } else {
                    // native object.  stash away the iid of the call
                    // in case we decide to create an id for the object later
                    idManager.setSourceIdForNativeObj(val,this.lastUse.getSourceId(iid));
                }
            }
            this.nativeModels.modelInvokeFun(iid, f, base, args, val, isConstructor, isMethod);
            var funId = idManager.findObjId(f);
            if (funId !== -1) {
                this.updateLastUse(funId,iid);
            }
        }

        /**
         * whether logging can be skipped for a putfield.
         * We need a stack to handle case where putfield
         * invokes a setter that itself contains a putfield
         * @type {Array}
         */
        private skipLoggingStack: Array<boolean> = [];

        /**
         * if true, log all putfields, even if value before
         * and after is a primitive
         * @type {boolean}
         */
        private logAllPutfields: boolean = false;

        putFieldPre(iid:number, base:any, offset:any, val:any):any {
            var skipLogging = false;
            if (isObject(base) && !this.logAllPutfields) {
                // can only skip if new value is a primitive
                if (!isObject(val)) {
                    // property must be a non-getter-setter defined on the object itself
                    var desc = Object.getOwnPropertyDescriptor(base,offset);
                    if (desc && !desc.set && !desc.get) {
                        // old value must be a primitive
                        var oldVal: any = base[offset];
                        if (!isObject(oldVal)) {
                            // we can skip logging!
                            skipLogging = true;
                        }
                    }
                } else {
                    var nativeResult = this.nativeModels.modelPutFieldPre(iid, base, offset, val);
                    if (nativeResult) {
                        return nativeResult;
                    }
                }
            }
            this.skipLoggingStack.push(skipLogging);
        }

        putField(iid:number, base:any, offset:any, val:any):any {
            var skipLogging = this.skipLoggingStack.pop();
            if (isObject(base)) {
                var baseId = this.idManager.findObjId(base);
                if (baseId !== -1) {
                    if (!skipLogging) {
                        if (!isGetterSetter(base,offset)) {
                            var valId = isObject(val) ? this.idManager.findOrCreateUniqueId(val,iid,false) : 0;
                            this.logger.logPutfield(iid,baseId,String(offset),valId);
                        }
                    }
                    this.updateLastUse(baseId,iid);
                }
                this.nativeModels.modelPutField(iid, base, offset, val);
            }
                    }

        private logWrite(iid:number,name:string,valId:number) {
            if (!name) {
                throw new Error("got an invalid name for iid " + iid);
            }
            this.logger.logWrite(iid, name, valId);
        }

        write(iid:number, name:any, val:any, oldValue:any):any {
            if (isObject(val)) {
                var id = this.idManager.findOrCreateUniqueId(val,iid, false);
                this.logWrite(iid,name,id);
            } else if (isObject(oldValue)) {
                // need the write so oldValue's ref-count gets updated
                this.logWrite(iid,name,0);
            } else {
                // old and new values are primitives, so we don't need to log anything
            }
        }

        /**
         * for each call frame, either the metadata for the unannotated this parameter,
         * or 0 if this was annotated
         * @type {Array}
         */
        private unannotThisMetadata: Array<number> = [];

        functionEnter(iid:number, fun:any, dis:any /* this */, args:any):void {
            if (this.emittedCall) {
                // we emitted a call entry, so we don't need a functionEnter also
                this.emittedCall = false;
            } else {
                var funId = this.idManager.findOrCreateUniqueId(fun,iid, false);
                this.logger.logFunctionEnter(iid, funId);
                // in this case, we won't see the invokeFun callback at the
                // caller to update the last use of fun.  so, update it here
                this.updateLastUse(funId, iid);
            }
            // check for unannotated this and flag as such
            if (dis !== GLOBAL_OBJ) {
                var idManager = this.idManager;
                var metadata = 0;
                if (!idManager.hasMetadata(dis)) {
                    metadata = idManager.findOrCreateUniqueId(dis,iid,false);
                    if (this.isConstructor) {
                        // TODO could optimize to only add value to obj2Metadata once
                        metadata = idManager.setUnannotatedThis(metadata);
                        idManager.setMetadata(dis,metadata);
                        this.unannotThisMetadata.push(metadata);
                    } else {
                        // we haven't seen the this object, but we are not
                        // sure this is a constructor call.  so, just create
                        // an id, but push 0 on the unnannotThisMetadata stack
                        this.unannotThisMetadata.push(0);
                    }
                } else { // already have metadata
                    metadata = idManager.getMetadata(dis);
                    this.unannotThisMetadata.push(0);
                }
                this.logger.logDeclare(iid, "this", this.idManager.extractObjId(metadata));
            } else {
                // global object; don't bother logging the assignment to this
                this.unannotThisMetadata.push(0);
            }
            // always unset the isConstructor flag
            this.isConstructor = false;
        }

        getField(iid:number, base:any, offset:any, val:any):any {
            // base may not be an object, e.g., if it's a string
            if (isObject(base)) {
                // TODO fix handling of prototype chain
                var id = this.idManager.findObjId(base);
                if (id !== -1) {
                    this.updateLastUse(id,iid);
                }
            }
        }

        functionExit(iid:number, returnVal: any, exceptionVal: any):FunctionExitResult {
            var loggedReturn = false;
            if (isObject(returnVal)) {
                var idManager = this.idManager;
                if (idManager.hasMetadata(returnVal)) {
                    this.logger.logReturn(idManager.findExtantObjId(returnVal));
                    loggedReturn = true;
                }
            }
            // NOTE: analysis should treat function exit as a top-level flush as well
            var unannotatedThis = this.unannotThisMetadata.pop();
            if (unannotatedThis !== 0 && !loggedReturn) {
                // we had an unannotated this and no explicit return.
                // we are very likely exiting from a constructor call.
                // so, add a RETURN log entry for this, so that it doesn't
                // become unreachable.
                // this could be the wrong thing to do, e.g., if this function
                // is actually being invoked from uninstrumented code.
                // don't worry about that corner case for now.
                this.logger.logReturn(this.idManager.extractObjId(unannotatedThis));
            }
            this.logger.logFunctionExit(iid);
            return;
        }

        binary(iid:number, op:string, left:any, right:any, result_c:any):any {
            if (op === 'delete') {
                // left is object, right is property
                var base = left;
                var offset = right;
                if (isObject(base)) {
                    var baseId = this.idManager.findObjId(base);
                    if (baseId !== -1 && offset !== null && offset !== undefined) {
                        this.logger.logPutfield(iid,baseId,String(offset),0);
                        this.updateLastUse(baseId,iid);
                    }
                }
            }
        }



        scriptEnter(iid:number, fileName:string):void {
            var iidInfo = J$.iids;
            var origFileName = iidInfo.originalCodeFileName;
            this.logger.logScriptEnter(iid, J$.sid, origFileName);
            // NOTE we should have already logged the file name due to a previous callback
            Object.keys(iidInfo).forEach((key) => {
                // check if it's a numeric property
                var iid = parseInt(key);
                if (!isNaN(iid)) {
                    var mapping = iidInfo[iid];
                    this.logger.logSourceMapping(iid, mapping[0], mapping[1], mapping[2], mapping[3]);
                }
            });
            var freeVars = J$.ast_info;
            Object.keys(freeVars).forEach((key) => {
                this.logger.logFreeVars(parseInt(key), freeVars[key]);
            });
        }

        scriptExit(iid:number):ScriptExitResult {
            this.logger.logScriptExit(iid);
            return;
        }

        /**
         * public flag indicating when logging is complete
         * @type {boolean}
         */
        doneLogging:boolean = false;

        endExecution():any {
            this.lastUse.flushLastUse();
            this.logger.end(() => { this.doneLogging = true; });
            return {};
        }

        endExpression(iid: number): void {
            if (this.logger.getFlushIID() === ALREADY_FLUSHED) {
                this.logger.setFlushIID(J$.sid, iid);
                // at this point, we can empty the map from native objects to iids,
                // since after a flush we won't be storing them anywhere
                this.idManager.flushNativeObj2IIDInfo();

            }
        }

    }

    var loggingAnalysis = new LoggingAnalysis();
    loggingAnalysis.init(J$.initParams);
    J$.analysis = loggingAnalysis;
}


