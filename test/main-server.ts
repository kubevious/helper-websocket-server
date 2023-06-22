import 'mocha';
import should from 'should';
import { MyPromise } from 'the-promise';

import { WebSocketServer } from '../src';

import express from 'express';
import { Server } from 'http'
import * as path from "path";

import { logger } from './logger';

const RUN_TEST_DEBUG = (process.env.RUN_TEST_DEBUG == 'true');
const PAUSE_TIMEOUT = RUN_TEST_DEBUG ? 100 * 1000 : 0;
const TEST_TIMEOUT = PAUSE_TIMEOUT + 2000;

const PORT = process.env.PORT || 3333;
let globalApp = express();

let globalHttp : Server | null;

globalApp.get("/", (req: any, res: any) => {
    res.sendFile(path.resolve(__dirname, "./client/index.html"));
});

describe('main-server', () => {

    beforeEach(() => {
        logger.info("[beforeEach]");

        return MyPromise.construct((resolve, reject) => {
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


    it('constructor', () => {
        const wsServer = new WebSocketServer(logger, globalHttp!, '/socket');
        return Promise.resolve()
            .then(() => wsServer.run())
            .then(() => MyPromise.delay(1 * 1000))
            .then(() => {
                return wsServer.update({ kind: 'messages' }, ['foo', 'bar']);
            })
            .then(() => MyPromise.delay(PAUSE_TIMEOUT))
            .then(() => {
            })
    })
    .timeout(TEST_TIMEOUT);

});
