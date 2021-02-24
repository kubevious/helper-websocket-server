import 'mocha';
import should = require('should');
import { Promise } from 'the-promise';

import { setupLogger, LoggerOptions } from 'the-logger';

import { WebSocketBaseServer } from '../src';

import express from 'express';
import { Server } from 'http'


const loggerOptions = new LoggerOptions().enableFile(false).pretty(true);
const logger = setupLogger('test', loggerOptions);

let globalApp = express();
globalApp.set("port", process.env.PORT || 33333);
let globalHttp : Server | null;

describe('base-server', () => {

    beforeEach(() => {
        globalHttp = new Server(globalApp);
    });

    afterEach(() => {
        globalHttp!.close();
        globalHttp = null;
    });


    it('case-01', () => {
        const wsServer = new WebSocketBaseServer(logger, globalHttp!, '/socket');
        return Promise.resolve()
            .then(() => wsServer.run())
            .then(() => Promise.timeout(100))
            .then(() => {
            })
    });

});
