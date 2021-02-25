import 'mocha';
import should = require('should');
import { Promise } from 'the-promise';

import { setupLogger, LoggerOptions } from 'the-logger';

import { WebSocketServer } from '../src';

import express from 'express';
import { Server } from 'http'
import * as path from "path";


const loggerOptions = new LoggerOptions().enableFile(false).pretty(true);
const logger = setupLogger('test', loggerOptions);

const PORT = process.env.PORT || 3333;
let globalApp = express();

let globalHttp : Server | null;

globalApp.get("/", (req: any, res: any) => {
    res.sendFile(path.resolve(__dirname, "./client/index.html"));
});

describe('main-server', () => {

    beforeEach(() => {
        logger.info("[beforeEach]");

        return Promise.construct((resolve, reject) => {
            globalHttp = globalApp.listen(PORT, () => {
                logger.info("Listening on %s", PORT);
                resolve();
            })
        })
    });

    afterEach(() => {
        logger.info("[afterEach]");
        globalHttp!.close();
        globalHttp = null;
    });


    it('case-01', () => {
        logger.info("Test Init");
        const wsServer = new WebSocketServer(logger, globalHttp!, '/socket.io');
        return Promise.resolve()
            .then(() => wsServer.run())
            .then(() => Promise.timeout(1000))
            .then(() => {
            })
    })
    .timeout(100000);

});
