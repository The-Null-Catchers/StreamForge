#!/usr/bin/env sh
set -eu
ffmpeg -hide_banner -loglevel error -y -f lavfi -i testsrc2=size=1280x720:rate=24 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 6 -c:v libx264 -pix_fmt yuv420p -c:a aac "${1:-sample.mp4}"
