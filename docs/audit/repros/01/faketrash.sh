#!/bin/sh
echo "TRASH $*" >> "$(dirname "$0")/trash.log"
