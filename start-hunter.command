#!/bin/bash
# Dublu-click pe macOS: pornește serverul și deschide interfața
cd "$(dirname "$0")"
(sleep 2 && open http://localhost:3080) &
node server.js
