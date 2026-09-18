#!/bin/sh
# Next.js on an internal port, the gateway on the public one.
PORT=${NEXT_PORT:-3001} HOSTNAME=127.0.0.1 node server.js &
exec node gateway.mjs
