import _ from 'the-lodash'
import { Promise, Resolvable } from 'the-promise'
import { ILogger } from 'the-logger'

import { Server, IncomingMessage } from 'http'
import * as SocketIO from 'socket.io'
import { Request, Response, NextFunction } from 'express';

import { UserMessages } from './types';

import { makeKey } from './utils';

export type WebSocketTarget = any;// Record<string, any>;
export type WebSocketMiddleware<TContext extends {} = WebSocketTarget, TLocals extends {} = WebSocketTarget> = (socket: MySocket<TContext, TLocals>, customData: MySocketCustomData<TContext, TLocals>) => Resolvable<void>;

export type SubscriptionMetaFetcherCb<TContext extends {} = WebSocketTarget, TLocals extends {} = WebSocketTarget> = (target: WebSocketTarget, socket: MySocket<TContext, TLocals>) => SubscriptionMeta;
export type SubscriptionHandler<TContext extends {} = WebSocketTarget, TLocals extends {} = WebSocketTarget> = (present: boolean, target: WebSocketTarget, socket: MySocket<TContext, TLocals>) => any;
export type SocketHandler<TContext extends {} = WebSocketTarget, TLocals extends {} = WebSocketTarget> = (globalTarget: WebSocketTarget, socket: MySocket<TContext, TLocals>, globalId: string, localTarget: WebSocketTarget) => any;

export type ServerMiddlewareCallbackFunc<TLocals = any> = (req: Request, res: Response<any, TLocals>, next: NextFunction) => void;
export type ServerMiddlewarePromiseFunc<TLocals = any> = (req: Request, res: Response<any, TLocals>) => Promise<any> | void;
export class WebSocketBaseServer<TContext extends {} = WebSocketTarget, TLocals extends {} = WebSocketTarget >
{
    private _logger : ILogger;
    private _io : SocketIO.Server;

    private _subscriptions : Record<string, ServerSubscriptionInfo<TContext, TLocals>> = {};
    private _subscriptionMetaFetcherCb : SubscriptionMetaFetcherCb<TContext, TLocals> | null = null;
    private _subscriptionHandlers : SubscriptionHandler<TContext, TLocals>[] = [];
    private _socketHandlers : SocketHandler<TContext, TLocals>[] = [];

    constructor(logger: ILogger, httpServer: Server, url?: string)
    {
        this._logger = logger;

        this._io = new SocketIO.Server(httpServer, {
            path: url
        });

        this._io.use(this._initMiddleware.bind(this));
    }

    get logger() {
        return this._logger;
    }

    run()
    {
        this.logger.info("[run]");

        this._io.on('connection', (socket) => {
            this._runPromise('connection', () => {
                return this._newConnection(socket);
            })
        });
    }

    setupSubscriptionMetaFetcher(cb: SubscriptionMetaFetcherCb<TContext, TLocals>)
    {
        this._subscriptionMetaFetcherCb = cb;
    }

    use(middleware: WebSocketMiddleware<TContext, TLocals>)
    {
        return this._io.use((socket, next) => {

            const mySocket = <MySocket<TContext, TLocals>> socket;

            Promise.try(() => middleware(socket, mySocket.customData!))
                .then(() => {
                    next()
                    return null;
                })
                .catch(reason => {
                    this.logger.warn('[use] ', reason);
                    next(reason);
                    return null;
                })
                .then(() => null);
        });
    }

    useExpressCallback(middleware: ServerMiddlewareCallbackFunc<TLocals>)
    {
        this.use((socket, customData) => {
            const req = this._makeExpressRequest(socket);
            const res = this._makeExpressResponse(socket);

            return Promise.construct((resolve, reject) => {
                middleware(
                    req,
                    res,
                    (error: any) => {
                        if (error) {
                            this.logger.warn('[useExpressCallback] ', error);
                            reject(error)
                        } else {
                            resolve();
                        }
                    }
                )
            })
        });
    }

    useP(middleware: ServerMiddlewarePromiseFunc<TLocals>)
    {
        this.use((socket) => {
            const req = this._makeExpressRequest(socket);
            const res = this._makeExpressResponse(socket);
            return middleware(req, res);
        });
    }

    private _makeExpressRequest(socket: MySocket<TContext, TLocals>) : Request
    {
        const req : Request = <Request>socket.request;
        return req;
    }

    private _makeExpressResponse(socket: MySocket<TContext, TLocals>) : Response<any, TLocals>
    {
        const res : Response<any, TLocals> = <Response<any, TLocals>>{
            locals: socket.customData!.locals
        };
        return res;
    }

    notifySocket(socket: MySocket<TContext, TLocals>, localTarget: WebSocketTarget, value: any)
    {
        this._logger.verbose('[notifySocket] socket: %s, localTarget: ', socket.id, localTarget);
        this._logger.silly('[notifySocket] socket: %s, localTarget && value: ', socket.id, localTarget, value);

        if (!socket.customData) {
            return;
        }

        let localId = makeKey(localTarget);
        let socketSubscription = socket.customData.localIdDict[localId];
        if (!socketSubscription)
        {
            return;
        }
        
        this._notify(socket, socketSubscription.localTarget, value);
    }

    notifyAll(globalTarget: WebSocketTarget, value: any)
    {
        this._logger.verbose('[notifyAll] globalTarget && value: ', globalTarget, value);

        let globalId = makeKey(globalTarget);
        let subscriptionInfo = this._subscriptions[globalId];
        if (!subscriptionInfo)
        {
            return;
        }

        for(let socket of _.values(subscriptionInfo.sockets))
        {
            if (socket.customData)
            {
                let socketSubscriptionInfo = socket.customData.globalIdDict[globalId];
                if (socketSubscriptionInfo)
                {
                    this._notify(socket, socketSubscriptionInfo.localTarget, value);
                }
            }
        }
    }

    handleSubscription(cb: SubscriptionHandler<TContext, TLocals>)
    {
        this._subscriptionHandlers.push(cb);
    }

    handleSocket(cb: SocketHandler<TContext, TLocals>)
    {
        this._socketHandlers.push(cb);
    }

    private _initMiddleware(socket: SocketIO.Socket, next: (err?: any) => void) : void
    {
        const xx : object = {};
        const mySocket = <MySocket<TContext, TLocals>>socket;
        (<any>mySocket).customData = {
            context: {},
            locals: {},
            localIdDict: {},
            globalIdDict: {},
        };
        next();
    }

    private _newConnection(socket: MySocket<TContext, TLocals>)
    {
        this._logger.debug('[_newConnection] id: %s', socket.id);

        if (!socket.customData) {
            return;
        }

        socket.on(UserMessages.subscribe, (localTarget) => {
            this._runPromise(UserMessages.subscribe, () => {
                return this._handleSubscribe(socket, localTarget);
            })
        });

        socket.on(UserMessages.unsubscribe, (localTarget) => {
            this._runPromise(UserMessages.unsubscribe, () => {
                return this._handleUnsubscribe(socket, localTarget);
            })
        });

        socket.on(UserMessages.update_context, (context) => {
            this._runPromise(UserMessages.update_context, () => {
                return this._setupContext(socket, context);
            })
        });

        socket.on('disconnect', () => {
            this._runPromise('disconnect', () => {
                return this._handleDisconnect(socket);
            })
        });
    }

    private _handleSubscribe(socket: MySocket<TContext, TLocals>, localTarget: WebSocketTarget)
    {
        if (!socket.customData) {
            return;
        }

        let localId = makeKey(localTarget);
        this._logger.debug('[_handleSubscribe] id: %s, localTarget: ', socket.id, localTarget);

        let meta = this._fetchSubscriptionMeta(localTarget, socket);

        let socketSubscriptionInfo : SocketSubscriptionInfo = {
            localId: localId,
            localTarget: localTarget,
            contextFields: meta.contextFields,
            targetExtras: meta.targetExtras
        };
        socket.customData.localIdDict[localId] = socketSubscriptionInfo;

        const tx = this._handleGlobalSubscription(socket, socketSubscriptionInfo);
        if (tx) {
            return this._completeTransaction(tx);
        }
    }

    private _handleUnsubscribe(socket: MySocket<TContext, TLocals>, localTarget: WebSocketTarget)
    {
        if (!socket.customData) {
            return;
        }

        const localId = makeKey(localTarget);

        this._logger.debug('[_handleUnsubscribe] id: %s, localTarget: ', socket.id, localTarget);

        let socketSubscription = socket.customData.localIdDict[localId];
        if (socketSubscription)
        {
            delete socket.customData.localIdDict[socketSubscription.localId];
            if (socketSubscription.globalId)
            {
                let tx = this._newTransaction(socket);
                this._processDeleteGlobalSubscription(tx, socketSubscription);
                return this._completeTransaction(tx);
            }
        }
    }

    private _handleGlobalSubscription(socket: MySocket<TContext, TLocals>, subscriptionInfo : SocketSubscriptionInfo) : SubscriptionTx<TContext, TLocals> | null
    {
        let tx = this._newTransaction(socket);

        let newGlobalTarget = this._makeGlobalTarget(subscriptionInfo, socket);
        if (!newGlobalTarget) 
        {
            this._logger.debug('[_handleGlobalSubscription] socket: %s, NO newGlobalTarget: ', socket.id);

            if (subscriptionInfo.globalTarget)
            {
                this._processDeleteGlobalSubscription(tx, subscriptionInfo);
            }
            else
            {
                return null;
            }
        }
        else
        {
            this._logger.debug('[_handleGlobalSubscription] socket: %s, newGlobalTarget: ', socket.id, newGlobalTarget);

            let globalId = makeKey(newGlobalTarget);

            if (subscriptionInfo.globalId)
            {
                if (globalId === subscriptionInfo.globalId)
                {
                    return null;
                }
                else
                {
                    this._processDeleteGlobalSubscription(tx, subscriptionInfo);
                }
            }
           
            subscriptionInfo.globalId = globalId;
            subscriptionInfo.globalTarget = newGlobalTarget;
            this._processCreateGlobalSubscription(tx, subscriptionInfo);
        }

        return tx;
    }

    private _processCreateGlobalSubscription(tx: SubscriptionTx<TContext, TLocals>, socketSubscription : SocketSubscriptionInfo)
    {
        const socket = tx.socket;
        const customData = socket.customData!;

        const globalId = socketSubscription.globalId!;
        const globalTarget = socketSubscription.globalTarget!;

        tx.localTarget = socketSubscription.localTarget;
        tx.globalId = globalId;
        tx.globalTarget = globalTarget;

        customData.globalIdDict[globalId] = socketSubscription;

        if (!this._subscriptions[globalId]) {
            tx.wasCreated = true;

            this._subscriptions[globalId] = {
                globalId: globalId,
                globalTarget: globalTarget,
                sockets: {}
            };
        }

        this._subscriptions[globalId].sockets[socket.id] = socket;
    }

    private _processDeleteGlobalSubscription(tx: SubscriptionTx<TContext, TLocals>, socketSubscription : SocketSubscriptionInfo)
    {
        const socket = tx.socket;
        const customData = socket.customData!;

        const globalId = socketSubscription.globalId!;

        let globalSubscriptionInfo = this._subscriptions[globalId];
        if (globalSubscriptionInfo) {
            delete globalSubscriptionInfo.sockets[socket.id];
            if (_.keys(globalSubscriptionInfo.sockets).length == 0) {
                delete this._subscriptions[globalId];
                tx.wasDeleted = true;
            }
        }

        delete customData.globalIdDict[globalId];
        socketSubscription.globalId = undefined;
        socketSubscription.globalTarget = undefined;
    }

    private _newTransaction(socket: MySocket<TContext, TLocals>) : SubscriptionTx<TContext, TLocals>
    {
        return {
            socket: socket,
            wasCreated: false,
            wasDeleted: false
        }
    }

    private _completeTransaction(tx: SubscriptionTx<TContext, TLocals>)
    {
        return Promise.resolve()
            .then(() => {
                if (tx.wasDeleted)
                {
                    return this._trigger(this._subscriptionHandlers, 
                        [false, tx.deletedGlobalTarget!],
                        'delete-subscription-handlers');
                }
            })
            .then(() => {
                if (tx.wasCreated) {
                    return this._trigger(this._subscriptionHandlers, 
                        [true, tx.globalTarget!],
                        'create-subscription-handlers');
                }
            })
            .then(() => {
                if (tx.globalId) {
                    return this._trigger(this._socketHandlers, 
                        [tx.globalTarget!, tx.socket, tx.globalId!, tx.localTarget!],
                        'socket-handlers');
                }
            })
    }


    private _setupContext(socket: MySocket<TContext, TLocals>, context: WebSocketTarget)
    {
        if (!socket.customData) {
            return;
        }

        this._logger.debug('[_setupContext] id: %s, context: ', socket.id, context);

        const customData = socket.customData;

        if (context) {
            customData.context = context;
        } else {
            (<any>customData).context = {};
        }

        const txList : SubscriptionTx<TContext, TLocals>[] = []

        for(let socketSubscription of _.values(customData.localIdDict))
        {
            let tx = this._handleGlobalSubscription(socket, socketSubscription);
            if (tx) {
                txList.push(tx);
            }
        }

        return Promise.serial(txList, tx => {
            return this._completeTransaction(tx);
        })
    } 

    private _makeGlobalTarget(subscription: SocketSubscriptionInfo, socket: MySocket<TContext, TLocals>) : WebSocketTarget | null
    {
        let target = _.clone(subscription.localTarget);
        if (subscription.targetExtras) 
        {
            target = _.defaults(target, subscription.targetExtras!)
        }
        if (subscription.contextFields)
        {
            for(let field of subscription.contextFields)
            {
                const customData = socket.customData!;
                const fieldValue = (<any>customData.context)[field];
                if (_.isNullOrUndefined(fieldValue)) {
                    return null;
                } else {
                    target[field] = fieldValue;
                }
            }
        }
        return target;
    }

    private _fetchSubscriptionMeta(target: WebSocketTarget, socket: MySocket<TContext, TLocals>) : SubscriptionMeta
    {
        if (this._subscriptionMetaFetcherCb) {
            const meta = this._subscriptionMetaFetcherCb(target, socket);
            if (!meta) {
                return {}
            }
            return meta;
        }
        return {};
    }

    private _handleDisconnect(socket: MySocket<TContext, TLocals>)
    {
        this._logger.debug('[_handleDisconnect] id: %s', socket.id);

        return Promise.resolve()
            .then(() => this._removeAllSubscriptions(socket))
            .then(() => {
                if (socket.customData) {
                    socket.customData = undefined;
                }
            })
    }

    private _removeAllSubscriptions(socket: MySocket<TContext, TLocals>)
    {
        if (!socket) {
            return;
        }
        if (!socket.customData) {
            return;
        }

        this._logger.debug('[_removeAllSubscriptions] socket: %s', socket.id);

        const txList : SubscriptionTx<TContext, TLocals>[] = []

        for(let socketSubscription of _.values(socket.customData.localIdDict))
        {
            if (socketSubscription.globalId)
            {
                let tx = this._newTransaction(socket);
                this._processDeleteGlobalSubscription(tx, socketSubscription);
                txList.push(tx);
            }
        }

        socket.customData.localIdDict = {};
        socket.customData.globalIdDict = {};

        return Promise.serial(txList, tx => {
            return this._completeTransaction(tx);
        })
    }

    private _notify(socket: MySocket<TContext, TLocals>, globalTarget: WebSocketTarget, value: any)
    {
        socket.emit('update', {
            target: globalTarget,
            value: value
        })
    }
 
    private _trigger(cbList: ((...args : any) => any)[], params: any[], name: string) : Promise<any>
    {
        return Promise.serial(cbList, x => {
            return x.apply(null, params);
        })
        .catch(reason => {
            this._logger.error("[_trigger] %s ::", name, reason);
        })
    }

    private _runPromise(name: string, cb: () => any)
    {
        this._logger.debug("In WebSocket :: %s", name);

        try
        {
            Promise.resolve(cb())
                .catch(reason => {
                    this._logger.error("In WebSocket::%s . Details: ", name, reason);
                })
        }
        catch(reason)
        {
            this._logger.error("In WebSocket::%s . Error: ", name, reason);
        }
    }

}

export interface MySocket<TContext extends {} = WebSocketTarget, TLocals extends {} = WebSocketTarget> extends NodeJS.EventEmitter {
    id: string;
    
    request: IncomingMessage,
    customData? : MySocketCustomData<TContext, TLocals>;

    emit(ev: string, ...args: any[]): boolean;
    onAny(listener: (...args: any[]) => void): this;
}
export interface MySocketCustomData<TContext extends {} = WebSocketTarget, TLocals extends {} = WebSocketTarget>
{
    context: TContext,
    locals: TLocals,
    localIdDict: Record<string, SocketSubscriptionInfo>,
    globalIdDict: Record<string, SocketSubscriptionInfo>,
}

export interface SocketSubscriptionInfo
{
    localId: string,
    localTarget: WebSocketTarget,
    
    contextFields?: string[],
    targetExtras?: WebSocketTarget

    globalId?: string,
    globalTarget?: WebSocketTarget
}

export interface ServerSubscriptionInfo<TContext extends {} = WebSocketTarget, TLocals extends {} = WebSocketTarget>
{
    globalId: string,
    globalTarget: WebSocketTarget,
    sockets: Record<string, MySocket<TContext, TLocals>>
}

export interface SubscriptionMeta
{
    contextFields?: string[],
    targetExtras?: WebSocketTarget
}


interface SubscriptionTx<TContext extends {} = WebSocketTarget, TLocals extends {} = WebSocketTarget>
{
    socket: MySocket<TContext, TLocals>,
    // socketSubscription : SocketSubscriptionInfo,

    wasDeleted: boolean,
    deletedGlobalId?: string,
    deletedGlobalTarget?: WebSocketTarget

    wasCreated: boolean,
    localTarget?: WebSocketTarget,
    globalId?: string,
    globalTarget?: WebSocketTarget
}