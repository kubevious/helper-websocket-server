#!/bin/bash
MY_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
MY_DIR="$(dirname $MY_PATH)"
cd $MY_DIR

export TS_NODE_COMPILER_OPTIONS="{\"module\": \"commonjs\" }"
export RUN_TEST_DEBUG=true

mocha -r ./node_modules/ts-node/register 'test/**/*.ts' -g main-server