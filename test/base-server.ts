import 'mocha';
import should = require('should');
import { Promise } from 'the-promise';


import { WebSocketBaseServer } from '../src';

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
        const wsServer = new WebSocketBaseServer(logger, globalHttp!, '/socket');
        return Promise.resolve()
            .then(() => wsServer.run())
            .then(() => Promise.timeout(PAUSE_TIMEOUT))
            .then(() => {
            })
    })
    .timeout(TEST_TIMEOUT);


    it('case-02', () => {
        const wsServer = new WebSocketBaseServer(logger, globalHttp!, '/socket');

        wsServer.setupSubscriptionMetaFetcher((target, socket) => {
            return {
                contextFields: ['foo', 'bar'],
                targetExtras: {
                    projectId: 'foo-bar'
                }
            };
        })

        return Promise.resolve()
            .then(() => wsServer.run())
            .then(() => Promise.timeout(PAUSE_TIMEOUT))
            .then(() => {
            })
    })
    .timeout(TEST_TIMEOUT);


    it('middleware-01', () => {
        const wsServer = new WebSocketBaseServer(logger, globalHttp!, '/socket');

        wsServer.setupSubscriptionMetaFetcher((target, socket) => {
            return {
                contextFields: ['foo', 'bar'],
                targetExtras: {
                    projectId: 'foo-bar'
                }
            };
        })

        wsServer.use((socket, customData) => {
            return Promise.resolve();
        });

        return Promise.resolve()
            .then(() => wsServer.run())
            .then(() => Promise.timeout(PAUSE_TIMEOUT))
            .then(() => {
            })
    })
    .timeout(TEST_TIMEOUT);

});
