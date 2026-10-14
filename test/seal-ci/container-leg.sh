# The Node 0.10/0.12 Travis legs, run inside the official node:0.10 /
# node:0.12 images with the repo mounted at /work (`docker run -w /work`).
#
# jsdom 5.6.1 needs io.js+, so Gruntfile.js runs the node smoke tests on
# Node 0.x only when an older jsdom loads (gh-2519); upstream's
# `grunt old_jsdom` installs jsdom@3, whose native contextify build needs
# python2 and an old gcc. Neither is on the Ubuntu 24.04 image, so these legs
# run in the node:0.10 / node:0.12 images (Debian jessie: python 2.7, gcc 4.9).
set -euo pipefail
npm config set registry "https://:2016-02-22T19%3A12%3A09.116Z@time-machines-npm.sealsecurity.io/"
bash test/seal-ci/npm-setup.sh
npm install --cache-min=999999999
./node_modules/.bin/grunt old_jsdom
node -e 'console.log("jsdom " + require("jsdom/package.json").version)'
npm test
