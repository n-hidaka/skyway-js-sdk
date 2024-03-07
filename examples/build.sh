#!/bin/bash

pushd $(dirname $0) > /dev/null

for example in $(ls -1 | grep -v -e "$(basename $0)"); do
  echo "Building ${example}"
  pushd ${example} > /dev/null

  npm run transpile \
  && npm run build:example \
  && mkdir -p ../dists \
  && if [ -e ../dists/${example} ]; then rm -rf ../dists/${example}; fi \
  && mv dist ../dists/${example}

  popd > /dev/null
done

popd > /dev/null

