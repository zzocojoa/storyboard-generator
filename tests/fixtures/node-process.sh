#!/bin/sh
# 새 스크립트마다 실행 파일을 기동하지 않고 같은 런처에서 검증할 Node 본문을 읽는다.
if [ "$1" = "--cutroom-fixture-ready" ]; then
  exec "$0.runtime" -e 'process.stdout.write("cutroom-fixture-ready\n")'
fi
exec "$0.runtime" "$0.source.mjs" "$@"
