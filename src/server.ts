import _ from 'the-lodash'
import { Promise } from 'the-promise'
import { ILogger } from 'the-logger'
import { Server } from 'http'

import * as HashUtils from './hash-utils';
import { makeKey } from './utils';

import { MySocket, WebSocketBaseServer, WebSocketMiddleware, WebSocketTarget } from './base-server';

export class WebSocketServer
{
    private _logger : ILogger;
    private _baseServer : WebSocketBaseServer;

    private _values : Record<string, TargetInfo> = {};

    constructor(logger: ILogger, httpServer: Server, url?: string)
    {
        this._logger = logger;

        this._baseServer = new WebSocketBaseServer(logger, httpServer, url);
        this._baseServer.handleSocket(this._handleSocket.bind(this));
    }

    get logger() {
        return this._logger;
    }

    run()
    {
        this.logger.info("[run]");
        return this._baseServer.run();
    }

    use(name: string, middleware: WebSocketMiddleware)
    {
        this._baseServer.use(name, middleware);
    }

    update(target: WebSocketTarget, value: any)
    {
        this._logger.verbose('[update] ', target);
        this._logger.silly('[update] ', target, value);

        const id = makeKey(target);

        let isChanged : boolean = false;

        if (_.isNullOrUndefined(value)) {
            value = null;
            if (!_.isNullOrUndefined(this._values[id])) {
                delete this._values[id];
                isChanged = true;
            }
        } else {
            const hash = HashUtils.calculateObjectHashStr(value);
            if (this._values[id]) {
                if (this._values[id].hash != hash) {
                    isChanged = true;
                }
            } else {
                isChanged = true;
            }

            if (isChanged) {
                this._values[id] = {
                    target: target,
                    hash: hash,
                    value: value
                }
            }
        }

        if (isChanged)
        {
            this._baseServer.notifyAll(target, value);
        }
    }

    updateScope(scope: WebSocketTarget, newItems: WebSocketItem[])
    {
        const newItemsDict : Record<string, WebSocketItem> = {};
        for(const newItem of newItems)
        {
            const target = _.clone(newItem.target);
            _.defaults(target, scope)
            const id = makeKey(target);
            newItemsDict[id] = {
                target: target,
                value: newItem.value
            };
        }

        const currentItems = this._scopeItems(scope);

        const diff = [];

        for(const id of _.keys(currentItems))
        {
            if (!newItemsDict[id]) {
                diff.push({
                    target: currentItems[id].target,
                    value: null
                })
            }
        }

        for(const id of _.keys(newItemsDict))
        {
            diff.push({
                target: newItemsDict[id].target,
                value: newItemsDict[id].value
            });
        }

        for(const delta of diff)
        {
            this.update(delta.target, delta.value);
        }
    }

    private _handleSocket(globalTarget: WebSocketTarget, socket: MySocket, globalId: string, localTarget: WebSocketTarget)
    {
        this._logger.verbose('[_handleSocket] globalId: %s, globalTarget:', globalId, globalTarget);
        const valueInfo = this._values[globalId];

        let value = null;
        if (valueInfo) {
            value = valueInfo.value
        }

        this._baseServer.notifySocket(socket, localTarget, value);
    }

    private _scopeItems(scope: WebSocketTarget) : Record<string, TargetInfo>
    {
        const result : Record<string, TargetInfo> = {};
        for(const id of _.keys(this._values))
        {
            const valueInfo = this._values[id];
            if (this._matchesScope(scope, valueInfo.target))
            {
                result[id] = valueInfo;
            }
        }
        return result;
    }

    private _matchesScope(scope: WebSocketTarget, target: WebSocketTarget) : boolean
    {
        for(const id of _.keys(scope))
        {
            if (scope[id] !== target[id]) {
                return false;
            }
        }
        return true;
    }

}


interface TargetInfo {
    target: WebSocketTarget,
    hash: string,
    value: any
}


export interface WebSocketItem {
    target: WebSocketTarget,
    value: any
}
