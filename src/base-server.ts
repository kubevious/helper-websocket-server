import _ from 'the-lodash'
import { Promise, Resolvable } from 'the-promise'
import { ILogger } from 'the-logger'

import { Server, IncomingMessage } from 'http'
import * as SocketIO from 'socket.io'
import { Request, Response, NextFunction } from 'express';

import { UserMessages } from './types';

import { makeKey } from './utils';
import { Handshake } from 'socket.io/dist/socket'

export type WebSocketTarget = any;// Record<string, any>;
export type WebSocketMiddleware<TContext extends {} = WebSocketTarget, TLocals extends {} = WebSocketTarget> = (socket: MySocket<TContext, TLocals>, customData: MySocketCustomData<TContext, TLocals>) => Resolvable<void>;

export type SubscriptionMetaFetcherCb<TContext extends {} = WebSocketTarget, TLocals extends {} = WebSocketTarget, TSubMeta extends {} = {}> = (target: WebSocketTarget, socket: MySocket<TContext, TLocals>) => SubscriptionMeta<TSubMeta>;
export type SubscriptionHandler<TSubMeta extends {} = {}> = (present: boolean, target: WebSocketTarget, meta: SubscriptionMeta<TSubMeta>) => any;
export type SocketHandler<TContext extends {} = WebSocketTarget, TLocals extends {} = WebSocketTarget, TSubMeta extends {} = {}> = (globalTarget: WebSocketTarget, socket: MySocket<TContext, TLocals>, globalId: string, localTarget: WebSocketTarget, meta: SubscriptionMeta<TSubMeta>) => any;

export type ServerMiddlewareCallbackFunc<TLocals = any> = (req: Request, res: Response<any, TLocals>, next: NextFunction) => void;
export type ServerMiddlewarePromiseFunc<TLocals = any> = (req: Request, res: Response<any, TLocals>) => Promise<any> | void;
export class WebSocketBaseServer<TContext extends {} = WebSocketTarget, TLocals extends {} = WebSocketTarget, TSubMeta extends {} = {} >
{
    private _logger : ILogger;
    private _io : SocketIO.Server;

    private _subscriptions : Record<string, ServerSubscriptionInfo<TContext, TLocals>> = {};
    private _subscriptionMetaFetcherCb : SubscriptionMetaFetcherCb<TContext, TLocals, TSubMeta> | null = null;
    private _subscriptionHandlers : SubscriptionHandler<TSubMeta>[] = [];
    private _socketHandlers : SocketHandler<TContext, TLocals, TSubMeta>[] = [];

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
        this._logger.info("[run]");

        this._io.on('connection', (socket) => {
            this._runPromise('connection', () => {
                return this._handleConnection(socket);
            })
        });
    }

    setupSubscriptionMetaFetcher(cb: SubscriptionMetaFetcherCb<TContext, TLocals, TSubMeta>)
    {
        this._subscriptionMetaFetcherCb = cb;
    }

    use(name: string, middleware: WebSocketMiddleware<TContext, TLocals>)
    {
        return this._io.use((socket, next) => {

            const mySocket = <MySocket<TContext, TLocals>> socket;

            Promise.try(() => middleware(socket, mySocket.customData!))
                .then(() => {
                    next()
                    return null;
                })
                .catch(reason => {
                    this._handleMiddlewareError('use', name, reason);
                    next(reason);
                    return null;
                })
                .then(() => null);
        });
    }

    useExpressCallback(name: string, middleware: ServerMiddlewareCallbackFunc<TLocals>)
    {
        this.use(name, (socket) => {
            const req = this._makeExpressRequest(socket);
            const res = this._makeExpressResponse(socket);

            return Promise.construct((resolve, reject) => {
                middleware(
                    req,
                    res,
                    (error: any) => {
                        if (error) {
                            this._handleMiddlewareError('useExpressCallback', name, error);
                            reject(error)
                        } else {
                            resolve();
                        }
                    }
                )
            })
        });
    }

    useP(name: string, middleware: ServerMiddlewarePromiseFunc<TLocals>)
    {
        this.use(name, (socket) => {
            const req = this._makeExpressRequest(socket);
            const res = this._makeExpressResponse(socket);
            return middleware(req, res);
        });
    }

    private _handleMiddlewareError(kind: string, name: string, error: any)
    {
        if (error) {
            const code = error.status || error.statusCode || error.code;
            if (code) {
                this._logger.warn('[%s] [%s] code: %s. error: ', kind, name, code, error.message);
                return;
            }
        }
        
        this._logger.warn('[%s] [%s]', kind, name, error);
    }

    private _makeExpressRequest(socket: MySocket<TContext, TLocals>) : Request
    {
        const reqWrapper = new SocketRequestWrapper(socket);
        const req : Request = <Request>(<any>reqWrapper);
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
        this._logger.debug('[notifySocket] socket: %s, localTarget: ', socket.id, localTarget);
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
        this._logger.debug('[notifyAll] globalTarget && value: ', globalTarget, value);

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

    handleSubscription(cb: SubscriptionHandler<TSubMeta>)
    {
        this._subscriptionHandlers.push(cb);
    }

    handleSocket(cb: SocketHandler<TContext, TLocals, TSubMeta>)
    {
        this._socketHandlers.push(cb);
    }

    private _initMiddleware(socket: SocketIO.Socket, next: (err?: any) => void) : void
    {
        const mySocket = <MySocket<TContext, TLocals>>socket;
        (<any>mySocket).customData = {
            context: {},
            locals: {},
            localIdDict: {},
            globalIdDict: {},
        };
        next();
    }

    private _handleConnection(socket: MySocket<TContext, TLocals>)
    {
        this._logger.verbose('[_handleConnection] id: %s', socket.id);

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
            meta: meta,
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
                let tx = this._newTransaction(socket, socketSubscription.meta);
                this._processDeleteGlobalSubscription(tx, socketSubscription);
                return this._completeTransaction(tx);
            }
        }
    }

    private _handleGlobalSubscription(
        socket: MySocket<TContext, TLocals>,
        subscriptionInfo : SocketSubscriptionInfo) : SubscriptionTx<TContext, TLocals> | null
    {
        let tx = this._newTransaction(socket, subscriptionInfo.meta);

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

    private _processCreateGlobalSubscription(
        tx: SubscriptionTx<TContext, TLocals>,
        socketSubscription : SocketSubscriptionInfo)
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

    private _newTransaction(socket: MySocket<TContext, TLocals>, meta: SubscriptionMeta) : SubscriptionTx<TContext, TLocals>
    {
        return {
            meta: meta,
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
                        [false, tx.deletedGlobalTarget!, tx.meta],
                        'delete-subscription-handlers');
                }
            })
            .then(() => {
                if (tx.wasCreated) {
                    return this._trigger(this._subscriptionHandlers, 
                        [true, tx.globalTarget!, tx.meta],
                        'create-subscription-handlers');
                }
            })
            .then(() => {
                if (tx.globalId) {
                    return this._trigger(this._socketHandlers, 
                        [tx.globalTarget!, tx.socket, tx.globalId!, tx.localTarget!, tx.meta],
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
        this._logger.verbose('[_handleDisconnect] id: %s', socket.id);

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
                let tx = this._newTransaction(socket, socketSubscription.meta);
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
    handshake: Handshake,
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
    meta: SubscriptionMeta,

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

export type SubscriptionMeta<TSubMeta extends {} = {}> = Partial<TSubMeta & {
    contextFields: string[],
    targetExtras: WebSocketTarget
}>


interface SubscriptionTx<TContext extends {} = WebSocketTarget, TLocals extends {} = WebSocketTarget>
{
    meta: SubscriptionMeta,
    socket: MySocket<TContext, TLocals>,

    wasDeleted: boolean,
    deletedGlobalId?: string,
    deletedGlobalTarget?: WebSocketTarget

    wasCreated: boolean,
    localTarget?: WebSocketTarget,
    globalId?: string,
    globalTarget?: WebSocketTarget
}


class SocketRequestWrapper<TContext, TLocals>
{
    private _socket: MySocket<TContext, TLocals>;
    private _request: IncomingMessage;

    constructor(socket: MySocket<TContext, TLocals>)
    {
        this._socket = socket;
        this._request = socket.request;
    }

    get method() {
        return 'GET';
    }

    get headers() {
        return this._request.headers;
    }

    get user() {
        return (<any>this._request).user;
    }

    get query() {
        return this._socket.handshake.query
    }

    set user(value: any) {
        (<any>this._request).user = value;
    }


    
}