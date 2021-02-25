import 'mocha';
import should = require('should');
import { Promise } from 'the-promise';

import { setupLogger, LoggerOptions, LogLevel } from 'the-logger';

import { WebSocketBaseServer } from '../src';

import express from 'express';
import { Server } from 'http'
import * as path from "path";

const RUN_TEST_DEBUG = (process.env.RUN_TEST_DEBUG == 'true');
const PAUSE_TIMEOUT = RUN_TEST_DEBUG ? 100 * 1000 : 0;
const TEST_TIMEOUT = PAUSE_TIMEOUT + 2000;

const loggerOptions = new LoggerOptions().enableFile(false).pretty(true).subLevel('test', LogLevel.debug);
const logger = setupLogger('test', loggerOptions);

const PORT = process.env.PORT || 3333;
let globalApp = express();

let globalHttp : Server | null;

globalApp.get("/", (req: any, res: any) => {
    res.sendFile(path.resolve(__dirname, "./client/index.html"));
});

describe('base-server', () => {

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
        const wsServer = new WebSocketBaseServer(logger, globalHttp!, '/socket');
        return Promise.resolve()
            .then(() => wsServer.run())
            .then(() => Promise.timeout(PAUSE_TIMEOUT))
            .then(() => {
            })
    })
    .timeout(TEST_TIMEOUT);

});
