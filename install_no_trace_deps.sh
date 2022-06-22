#!/bin/bash

if [ ! -d "node_modules/@sap/cds" ]; then
  echo "Installing no trace dependencies ...";
  npm i --no-save express @sap/cds@5 sqlite3;
fi
