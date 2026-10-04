#!/usr/bin/env bash
# Host unit test for the car firmware. Needs a C++17 compiler:
#   CXX="g++"                      (MinGW / Linux / macOS)
#   CXX="python -m ziglang c++"    (pip install ziglang)
# Usage: bash firmware/test/run_tests.sh [-v]    (-v prints firmware Serial output)
# Builds the same test in three configs so the calibration knobs are exercised too.
set -euo pipefail
cd "$(dirname "$0")"
CXX="${CXX:-python -m ziglang c++}"
trap 'rm -f test_firmware.exe test_firmware.pdb' EXIT

run() {
    name=$1; shift
    echo "== $name"
    $CXX -std=c++17 -Wall -Wextra -Wno-unused-parameter -Wno-nullability-completeness \
        -DCONFIG_IDF_TARGET_ESP32=1 -I mocks "$@" test_firmware.cpp -o test_firmware.exe
    ./test_firmware.exe ${VERBOSE:-}
}
[ "${1:-}" = "-v" ] && VERBOSE=-v

run "default: battery sensor off"
run "battery sensor on"                           -DBATTERY_ADC_PIN=35
run "battery on + MIN_DUTY 70 + left side inverted" -DBATTERY_ADC_PIN=35 -DMOTOR_MIN_DUTY=70 -DMOTOR_L_INVERT=1
