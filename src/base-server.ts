import _ from 'the-lodash'
import { Promise } from 'the-promise'
import { ILogger } from 'the-logger'

import { Server } from 'http'
import * as SocketIO from 'socket.io'


export type WebSocketTarget = Record<string, any>;
export type WebSocketMiddleware = (socket: SocketIO.Socket, next: (err?: any) => void) => void;

export type GlobalTargetFormatter = (target: WebSocketTarget, socket: MySocket) => WebSocketTarget;
export type SubscriptionHandler = (present: boolean, target: WebSocketTarget, socket: MySocket) => any;
export type SocketHandler = (globalTarget: WebSocketTarget, socket: MySocket, globalId: string, localTarget: WebSocketTarget) => any;

export class WebSocketBaseServer
{
    private _logger : ILogger;
    private _io : SocketIO.Server;

    private _subscriptions : Record<string, { globalTarget: WebSocketTarget, sockets: Record<string, MySocket>}> = {};
    private _makeGlobalTargetCb : GlobalTargetFormatter | null = null;
    private _subscriptionHandlers : SubscriptionHandler[] = [];
    private _socketHandlers : SocketHandler[] = [];

    constructor(logger: ILogger, httpServer: Server, url?: string)
    {
        this._logger = logger;

        this._io = new SocketIO.Server(httpServer, {
            path: url
        });
    }

    get logger() {
        return this._logger;
    }

    run()
    {
        this.logger.info("[run]");

        // this._io.use((socket, next) => {
        //     this.logger.info("[USE] %s", socket.id);
        //     next();
        // });

        this._io.on("connect_error", (err) => {
            this.logger.warn("[CONNECT_ERROR] ", err);
        });


        this._io.on("event", () => {
            this.logger.warn("[EVENT] ");
        });

        this._io.on('connection', (socket) => {
            this._runPromise('connection', () => {
                return this._newConnection(socket);
            })
        });
    }

    setupGlobalTargetFormatter(cb: GlobalTargetFormatter)
    {
        this._makeGlobalTargetCb = cb;
    }

    use(middleware: WebSocketMiddleware)
    {
        return this._io.use(middleware);
    }

    notifySocket(socket: MySocket, localTarget: WebSocketTarget, value: any)
    {
        this._logger.verbose('[notifySocket] socket: %s, localTarget && value: ', socket.id, localTarget, value);

        if (!socket.customData) {
            return;
        }

        let localId = this.makeKey(localTarget);
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

        let globalId = this.makeKey(globalTarget);
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

    handleSubscription(cb: SubscriptionHandler)
    {
        this._subscriptionHandlers.push(cb);
    }

    handleSocket(cb: SocketHandler)
    {
        this._socketHandlers.push(cb);
    }

    private _newConnection(socket: MySocket)
    {
        this._logger.debug('[_newConnection] id: %s', socket.id);

        socket.customData = {
            localIdDict: {},
            globalIdDict: {},
        };

        socket.on('subscribe', (localTarget) => {
            this._runPromise('subscribe', () => {
                return this._handleSubscribe(socket, localTarget);
            })
        });

        socket.on('unsubscribe', (localTarget) => {
            this._runPromise('unsubscribe', () => {
                return this._handleUnsubscribe(socket, localTarget);
            })
        });

        socket.on('unsubscribe_all', () => {
            this._runPromise('subscribe', () => {
                return this._handleUnubscribeAll(socket);
            })
        });

        socket.on('disconnect', () => {
            this._runPromise('disconnect', () => {
                return this._handleDisconnect(socket);
            })
        });
    }

    private _handleSubscribe(socket: MySocket, localTarget: WebSocketTarget)
    {
        if (!socket.customData) {
            return;
        }

        let localId = this.makeKey(localTarget);
        let globalTarget = this._makeGlobalTarget(localTarget, socket);
        let globalId = this.makeKey(globalTarget);

        this._logger.debug('[_handleSubscribe] id: %s, globalTarget: ', socket.id, globalTarget);

        let socketSubscriptionInfo = {
            localId: localId,
            globalId: globalId,
            localTarget: localTarget,
            globalTarget: globalTarget
        };
        socket.customData.localIdDict[localId] = socketSubscriptionInfo;
        socket.customData.globalIdDict[globalId] = socketSubscriptionInfo;

        let wasNew = false;
        if (!this._subscriptions[globalId]) {
            wasNew = true;
            this._subscriptions[globalId] = {
                globalTarget: globalTarget,
                sockets: {}
            };
        }
        this._subscriptions[globalId].sockets[socket.id] = socket;

        return Promise.resolve()
            .then(() => {
                if (wasNew) {
                    return this._trigger(this._subscriptionHandlers, 
                        [true, globalTarget],
                        'create-subscription-handlers');
                }
            })
            .then(() => {
                return this._trigger(this._socketHandlers, 
                    [globalTarget, socket, globalId, localTarget],
                    'socket-handlers');
            })
            ;
    }

    private _handleUnsubscribe(socket: MySocket, localTarget: WebSocketTarget)
    {
        if (!socket.customData) {
            return;
        }

        let localId = this.makeKey(localTarget);

        this._logger.debug('[_handleUnsubscribe] id: %s, localTarget: ', socket.id, localTarget);

        let wasDeleted = false;

        let socketSubscription = socket.customData.localIdDict[localId];
        if (socketSubscription)
        {
            let subscriptionInfo = this._subscriptions[socketSubscription.globalId];
            if (subscriptionInfo) {
                delete subscriptionInfo.sockets[socket.id];
    
                if (_.keys(subscriptionInfo.sockets).length == 0) {
                    delete this._subscriptions[socketSubscription.globalId];
                    wasDeleted = true;
                }
            }

            delete socket.customData.localIdDict[socketSubscription.localId];
            delete socket.customData.globalIdDict[socketSubscription.globalId];

            if (wasDeleted)
            {
                return this._trigger(this._subscriptionHandlers, 
                    [false, subscriptionInfo.globalTarget],
                    'delete-subscription-handlers');
            }
        }
    }

    private _makeGlobalTarget(target: WebSocketTarget, socket: MySocket) : WebSocketTarget
    {
        if (this._makeGlobalTargetCb) {
            target = _.clone(target);
            target = this._makeGlobalTargetCb(target, socket);
        }
        return target;
    }

    private _handleUnubscribeAll(socket: MySocket)
    {
        return this._removeAllSubscriptions(socket);
    }

    private _handleDisconnect(socket: MySocket)
    {
        this._logger.debug('[_handleDisconnect] id: %s', socket.id);

        return Promise.resolve()
            .then(() => this._removeAllSubscriptions(socket))
            .then(() => {
                return delete socket.customData;
            })
    }

    private _removeAllSubscriptions(socket: MySocket)
    {
        if (!socket) {
            return;
        }
        if (!socket.customData) {
            return;
        }

        this._logger.debug('[_removeAllSubscriptions] socket: %s', socket.id);

        let toBeDeletedTargets = [];
        for(let socketSubscription of _.values(socket.customData.localIdDict))
        {
            let subscriptionInfo = this._subscriptions[socketSubscription.globalId];
            if (subscriptionInfo) {
                delete subscriptionInfo.sockets[socket.id];

                if (_.keys(subscriptionInfo.sockets).length == 0) {
                    delete this._subscriptions[socketSubscription.globalId];
                    toBeDeletedTargets.push(subscriptionInfo.globalTarget);
                }
            }
        }
        socket.customData.localIdDict = {};
        socket.customData.globalIdDict = {};

        return Promise.serial(toBeDeletedTargets, globalTarget => {
            return this._trigger(this._subscriptionHandlers, 
                [false, globalTarget],
                'delete-all-subscriptions-handlers');
        })
    }

    makeKey(target: WebSocketTarget) : string
    {
        return _.stableStringify(target);
    }

    private _notify(socket: MySocket, globalTarget: WebSocketTarget, value: any)
    {
        socket.emit('update', {
            target: globalTarget,
            value: value
        })
    }
 
    private _trigger(cbList: any[], params: any[], name: string) : Promise<any>
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

export interface MySocket extends NodeJS.EventEmitter {
    id: string;
    
    customData? : MySocketCustomData;

    emit(ev: string, ...args: any[]): boolean;
    onAny(listener: (...args: any[]) => void): this;
}
export interface MySocketCustomData
{
    localIdDict: Record<string, SocketSubscriptionInfo>,
    globalIdDict: Record<string, SocketSubscriptionInfo>,
}

export interface SocketSubscriptionInfo
{
    localId: string,
    globalId: string,
    localTarget: WebSocketTarget,
    globalTarget: WebSocketTarget
}
